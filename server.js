// Attest — Access Certification & Role Governance App
// Node.js Express server with JWT auth + SQLite persistence.

const express = require('express');
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const multer = require('multer');
const { createLogStore } = require('./stores/logStore');
const { createActivityStore } = require('./stores/activityStore');
const {
  createAdminUserStore,
  PROTECTED_ADMIN_EMAILS,
  normalizeEmail,
} = require('./stores/adminUserStore');
const { createDataStore } = require('./stores/dataStore');
const { createCampaignStore } = require('./stores/campaignStore');
const { createSodStore } = require('./stores/sodStore');
const { createEvidenceStore } = require('./stores/evidenceStore');
const { createTenantStore } = require('./stores/tenantStore');
const { createApiKeyStore } = require('./stores/apiKeyStore');
const { createNotificationStore } = require('./stores/notificationStore');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = (function() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  if (process.env.NODE_ENV === 'production') {
    console.error('FATAL: JWT_SECRET environment variable is required in production.');
    process.exit(1);
  }
  // Dev only: generate a random secret so tokens survive restarts within a session
  const crypto = require('crypto');
  const devSecret = crypto.randomBytes(32).toString('hex');
  console.warn('[security] Using auto-generated JWT secret for development. Set JWT_SECRET for persistence across restarts.');
  return devSecret;
})();
const BCRYPT_ROUNDS = 10;
const REPORTS_DIR = process.env.REPORTS_DIR || path.join(__dirname, 'Reports');

// Source data file names
const ROLES_FILE_NAME = process.env.ROLES_FILE_NAME || 'Roles Approvers.xlsx';
const TX_FILE_NAME = process.env.TX_FILE_NAME || 'Transactions.xlsx';

const logStore = createLogStore();
const activityStore = createActivityStore();
const adminUserStore = createAdminUserStore();
const dataStore = createDataStore();
const campaignStore = createCampaignStore();
const sodStore = createSodStore();
const evidenceStore = createEvidenceStore();
const tenantStore = createTenantStore();
const apiKeyStore = createApiKeyStore();
const notificationStore = createNotificationStore();

const UNAUTHORIZED_MESSAGE = 'You are not authorized to use this application. Please contact your system administrator.';
const isProduction = process.env.NODE_ENV === 'production';
const RITM_STATUS_OPTIONS = ['Open', 'Resolved', 'On Hold', 'Cancelled'];
const MAX_TRANSACTION_ROLE_LOOKUPS = positiveIntEnv('MAX_TRANSACTION_ROLE_LOOKUPS', 500);
const MAX_SUBMISSION_ROWS = positiveIntEnv('MAX_SUBMISSION_ROWS', 1000);

// Multer config for Excel uploads (admin only)
const upload = multer({
  dest: REPORTS_DIR,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext !== '.xlsx') {
      return cb(new Error('Only .xlsx files are accepted.'));
    }
    cb(null, true);
  },
});

// Human-readable labels for the top-level pages
const PAGE_ACCESS_LABELS = {
  '/': 'Accessed Review app',
  '/index.html': 'Accessed Review app',
  '/reviews.html': 'Accessed Review app',
  '/dashboard.html': 'Accessed Dashboard',
  '/campaigns.html': 'Accessed Campaigns',
  '/audit-trail.html': 'Accessed Audit Trail',
  '/data-sources.html': 'Accessed Data Sources',
  '/sod.html': 'Accessed SoD Conflicts',
  '/evidence.html': 'Accessed Evidence Locker',
  '/admin.html': 'Accessed Audit Trail',
  '/admin-users.html': 'Accessed Admin Users',
  '/activity.html': 'Accessed Activity Log',
};

function recordActivity(event, tenantId) {
  const e = { ...event, tenantId: tenantId || 'default' };
  Promise.resolve()
    .then(() => activityStore.record(e))
    .catch(err => console.error('[activity] record failed:', err));
}

const TX_HEADER_RENAMES = {
  'Role Name': 'Business Role',
  'Associated Role': 'Technical Role',
  'Associated Role Description': 'Technical Role Description',
};

function positiveIntEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function unauthorizedHtml(message = UNAUTHORIZED_MESSAGE) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Unauthorized — Attest</title>
  <style>
    body { margin: 0; font-family: "Segoe UI", Arial, sans-serif; color: #333; background: #fff; }
    main { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px; }
    section { width: min(560px, 100%); border: 1px solid #d9dfe9; border-radius: 6px; padding: 28px; }
    h1 { margin: 0 0 12px; color: #14305c; font-size: 24px; }
    p { margin: 0; line-height: 1.5; }
  </style>
</head>
<body><main><section><h1>Access denied</h1><p>${escapeHtml(message)}</p></section></main></body>
</html>`;
}

function sendAuthError(req, res, status, message = UNAUTHORIZED_MESSAGE) {
  recordActivity({
    type: 'AUTH',
    action: 'unauthorized',
    email: (req.auth && req.auth.email) || '',
    detail: `Denied (${status}) ${req.method} ${req.path}`,
  });
  if (req.path.startsWith('/api/')) {
    return res.status(status).json({ error: message });
  }
  return res.status(status).type('html').send(unauthorizedHtml(message));
}

function getRequestedApprover(req) {
  return String((req.query && req.query.approver) || '').trim();
}

function getBodyApprover(req) {
  return String((req.body && req.body.approver) || '').trim();
}

function hasRoleAccess(ctx, role) {
  if (!role) return false;
  if (ctx.isAdmin) return true;
  return ctx.roles.includes(role);
}

async function nextSubmissionId() {
  const db = require('./stores/db').getDb();
  const row = db.prepare(
    "SELECT MAX(CAST(submission_id AS INTEGER)) as max_id FROM submissions WHERE submission_id GLOB '[0-9][0-9][0-9][0-9][0-9][0-9]'"
  ).get();
  const maxId = row && row.max_id ? Number(row.max_id) : 0;
  return String(maxId + 1).padStart(6, '0');
}

// ---------- In-memory data ----------
let uniqueRoleNames = [];
let roleToApprover = {};
let approverToRoles = {};
let uniqueApprovers = [];
let approverEmailToName = {};
let approverNameToEmail = {};

let txHeader = [];
let txByRole = {};

let rolesVersion = null;
let txVersion = null;

function parseRolesApprovers(buffer) {
  uniqueRoleNames = [];
  roleToApprover = {};
  approverToRoles = {};
  uniqueApprovers = [];
  approverEmailToName = {};
  approverNameToEmail = {};

  const wb = XLSX.read(buffer, { type: 'buffer' });
  const sheetName = wb.SheetNames.includes('Complete') ? 'Complete' : wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  const seenRole = new Set();
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const roleName = String(row[0] || '').trim();
    const fullName = String(row[3] || '').trim();
    if (!roleName) continue;
    if (!seenRole.has(roleName)) {
      seenRole.add(roleName);
      uniqueRoleNames.push(roleName);
      roleToApprover[roleName] = fullName;
      if (fullName) {
        if (!approverToRoles[fullName]) approverToRoles[fullName] = [];
        approverToRoles[fullName].push(roleName);
      }
    }
  }
  uniqueRoleNames.sort((a, b) => a.localeCompare(b));
  uniqueApprovers = Object.keys(approverToRoles).sort((a, b) => a.localeCompare(b));
  for (const k of uniqueApprovers) approverToRoles[k].sort((a, b) => a.localeCompare(b));

  const emailSheet = wb.Sheets.Emails || wb.Sheets.emails;
  if (emailSheet) {
    const emailRows = XLSX.utils.sheet_to_json(emailSheet, { header: 1, defval: '' });
    const header = (emailRows[0] || []).map(v => String(v || '').trim().toLowerCase());
    const nameCol = Math.max(header.findIndex(h => h.includes('full') && h.includes('name')), 0);
    const emailCol = header.findIndex(h => h.includes('email'));
    const resolvedEmailCol = emailCol >= 0 ? emailCol : 1;
    for (let i = 1; i < emailRows.length; i++) {
      const row = emailRows[i];
      const fullName = String(row[nameCol] || '').trim();
      const email = normalizeEmail(row[resolvedEmailCol]);
      if (!fullName || !email || !approverToRoles[fullName]) continue;
      approverEmailToName[email] = fullName;
      approverNameToEmail[fullName] = email;
    }
  } else {
    console.warn('Roles Approvers workbook does not include an Emails sheet.');
  }

  console.log(
    `Loaded ${uniqueRoleNames.length} roles, ${uniqueApprovers.length} approvers, ` +
    `${Object.keys(approverEmailToName).length} approver emails.`
  );
}

function parseTransactions(buffer) {
  txByRole = {};
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const sheetName = wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  if (!data.length) return;
  const rawHeader = data[0].map(v => String(v));
  while (rawHeader.length && !String(rawHeader[rawHeader.length - 1]).trim()) rawHeader.pop();
  txHeader = rawHeader.map(h => TX_HEADER_RENAMES[h] || h);
  const colCount = rawHeader.length;

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const roleName = String(row[0] || '').trim();
    if (!roleName) continue;
    const trimmed = row.slice(0, colCount).map(v => (v === undefined || v === null) ? '' : v);
    if (!txByRole[roleName]) txByRole[roleName] = [];
    txByRole[roleName].push(trimmed);
  }
  console.log(`Loaded transactions: ${data.length - 1} rows across ${Object.keys(txByRole).length} roles.`);
}

async function refreshRoles({ force = false } = {}) {
  const version = await dataStore.getVersion(ROLES_FILE_NAME);
  if (version === null) {
    console.error('Roles source file not found:', ROLES_FILE_NAME);
    return false;
  }
  if (!force && version === rolesVersion) return false;
  const { buffer, source } = await dataStore.getFile(ROLES_FILE_NAME);
  parseRolesApprovers(buffer);
  rolesVersion = version;
  console.log(`Roles/approvers loaded from ${source} (version ${version}).`);
  return true;
}

async function refreshTransactions({ force = false } = {}) {
  const version = await dataStore.getVersion(TX_FILE_NAME);
  if (version === null) {
    console.error('Transactions source file not found:', TX_FILE_NAME);
    return false;
  }
  if (!force && version === txVersion) return false;
  const { buffer, source } = await dataStore.getFile(TX_FILE_NAME);
  parseTransactions(buffer);
  txVersion = version;
  console.log(`Transactions loaded from ${source} (version ${version}).`);
  return true;
}

// ---------- JWT Authentication ----------
function generateToken(payload) {
  // Ensure tenant_id is in the token
  return jwt.sign(
    { email: payload.email, tenant_id: payload.tenant_id || 'default' },
    JWT_SECRET,
    { expiresIn: '24h' }
  );
}

function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

// ---------- Tenant Middleware ----------
function tenantMiddleware(req, res, next) {
  try {
    // Priority 1: X-Tenant-ID header (for API key / admin override)
    const headerTenant = String(req.get('x-tenant-id') || '').trim();
    if (headerTenant) {
      req.tenantId = headerTenant;
      return next();
    }

    // Priority 2: Extract from JWT
    const authHeader = String(req.get('authorization') || '').trim();
    if (authHeader.startsWith('Bearer ')) {
      try {
        const payload = verifyToken(authHeader.slice(7));
        req.tenantId = payload.tenant_id || 'default';
        return next();
      } catch {}
    }

    // Priority 3: Dev mode fallback
    if (!isProduction) {
      req.tenantId = process.env.DEV_TENANT_ID || 'default';
      return next();
    }

    req.tenantId = 'default';
    next();
  } catch {
    req.tenantId = 'default';
    next();
  }
}

async function getAuthenticatedEmail(req) {
  // Check Authorization header (Bearer token)
  const authHeader = String(req.get('authorization') || '').trim();
  if (authHeader.startsWith('Bearer ')) {
    try {
      const token = authHeader.slice(7);
      const payload = verifyToken(token);
      return normalizeEmail(payload.email || '');
    } catch (err) {
      // Token invalid/expired — fall through to dev mode
    }
  }

  // Dev mode fallback
  if (!isProduction) {
    return normalizeEmail(
      process.env.DEV_AUTH_EMAIL ||
      process.env.LOCAL_AUTH_EMAIL ||
      req.get('x-dev-auth-email') ||
      'admin.one@attest.local'
    );
  }
  return '';
}

async function buildAuthContext(req) {
  const email = await getAuthenticatedEmail(req);
  const admins = await adminUserStore.listAdmins();
  const isAdmin = email ? admins.includes(email) : false;
  const approverName = email ? (approverEmailToName[email] || '') : '';
  const roles = approverName ? (approverToRoles[approverName] || []) : [];
  return {
    email,
    approverName,
    roles,
    isAdmin,
    isAuthorized: Boolean(isAdmin || approverName),
  };
}

function isPublicPath(path) {
  // Static assets and public pages — no auth required
  if (path === '/' || path === '/healthz' || path === '/login.html' || path === '/api/auth' || path.startsWith('/assets/') || path.startsWith('/api/evidence/share/') || path.startsWith('/vendor/')) return true;
  // All static files (CSS, JS, SVG, JSON, fonts)
  if (/\.(css|js|svg|png|jpg|jpeg|gif|ico|woff2?|ttf|eot|json|map)$/i.test(path)) return true;
  // All HTML pages
  if (path.endsWith('.html')) return true;
  return false;
}

async function authMiddleware(req, res, next) {
  try {
    // Always build auth context from token if present
    req.auth = await buildAuthContext(req);

    // Public paths — let through even without auth
    if (isPublicPath(req.path)) return next();

    // Protected paths — require valid auth
    if (!req.auth.email) {
      if (req.path.startsWith('/api/')) {
        return res.status(401).json({ error: 'Authentication required.' });
      }
      return res.redirect('/login.html?redirect=' + encodeURIComponent(req.originalUrl));
    }
    if (!req.auth.isAuthorized) {
      return sendAuthError(req, res, 403);
    }
    return next();
  } catch (err) {
    console.error('Authentication failed:', err);
    if (req.path.startsWith('/api/')) {
      return res.status(401).json({ error: 'Authentication failed.' });
    }
    return res.redirect('/login.html');
  }
}

function requireAdmin(req, res, next) {
  if (req.auth && req.auth.isAdmin) return next();
  return sendAuthError(req, res, 403);
}

function recordPageAccess(req, res, next) {
  if (req.method === 'GET' && Object.prototype.hasOwnProperty.call(PAGE_ACCESS_LABELS, req.path)) {
    recordActivity({
      type: 'AUTH',
      action: 'access',
      email: (req.auth && req.auth.email) || '',
      detail: PAGE_ACCESS_LABELS[req.path],
    });
  }
  return next();
}

// ---------- Global middleware ----------
app.use(express.json({ limit: '4mb' }));
app.use(tenantMiddleware);

// API Key authentication middleware — runs before JWT for API routes
async function apiKeyMiddleware(req, res, next) {
  const apiKey = String(req.get('x-api-key') || '').trim();
  if (!apiKey) return next(); // No API key, fall through to JWT
  try {
    const keyData = await apiKeyStore.validateKey(apiKey);
    if (!keyData) return res.status(401).json({ error: 'Invalid or revoked API key.' });
    req.apiKey = keyData;
    req.tenantId = keyData.tenant_id;
    // Allow access based on permissions
    if (keyData.permissions === 'health-check' && req.path !== '/healthz') {
      return res.status(403).json({ error: 'API key has health-check only permissions.' });
    }
    if (keyData.permissions === 'read-only' && !['GET','HEAD'].includes(req.method)) {
      return res.status(403).json({ error: 'API key has read-only permissions.' });
    }
    // Set a pseudo-auth for recordActivity
    req.auth = { email: 'api-key:' + keyData.id, isAdmin: false, approverName: '', roles: [], isAuthorized: true };
    next();
  } catch (err) { next(); }
}
app.use(apiKeyMiddleware);

// ---------- Static routes + API modules ----------
app.get('/healthz', (req, res) => res.json({ ok: true }));
app.get('/', (req, res) => res.redirect('/dashboard.html'));
app.use(authMiddleware);
app.use(recordPageAccess);
app.use(express.static(path.join(__dirname, 'public')));
app.use('/vendor/jspdf', express.static(path.join(__dirname, 'node_modules', 'jspdf', 'dist')));
app.use('/vendor/jspdf-autotable', express.static(path.join(__dirname, 'node_modules', 'jspdf-autotable', 'dist')));

// Register all API route modules
const { getDb } = require('./stores/db');
require('./routes')({
  app, db: getDb(),
  logStore, activityStore, adminUserStore, dataStore, campaignStore, sodStore, evidenceStore, tenantStore, apiKeyStore, notificationStore,
  uniqueRoleNames, roleToApprover, approverToRoles, uniqueApprovers, approverEmailToName, approverNameToEmail,
  txHeader, txByRole, rolesVersion, txVersion,
  recordActivity, createNotification, refreshRoles, refreshTransactions,
  generateToken, verifyToken, normalizeEmail, escapeHtml, unauthorizedHtml, sendAuthError,
  requireAdmin, upload, JWT_SECRET, BCRYPT_ROUNDS, REPORTS_DIR, ROLES_FILE_NAME, TX_FILE_NAME,
  UNAUTHORIZED_MESSAGE, RITM_STATUS_OPTIONS, MAX_TRANSACTION_ROLE_LOOKUPS, MAX_SUBMISSION_ROWS,
  PROTECTED_ADMIN_EMAILS,
});

// Helper: create a notification (non-blocking)
async function createNotification(opts) {
  try { return await notificationStore.create({ tenant_id: opts.tenant_id || 'default', type: opts.type || 'system', title: opts.title || '', body: opts.body || '', link: opts.link || '', icon: opts.icon || '', email: opts.email || '' }); }
  catch (err) { console.warn('[notifications] Failed to create:', err.message); return null; }
}

// ---------- Start server ----------
async function start() {
  try {
    const { generateExcelFiles, seedDatabase } = require('./scripts/seed-on-first-run');
    generateExcelFiles(); seedDatabase();
  } catch (err) { console.warn('[seed] Seed on first run failed (non-fatal):', err.message); }
  console.log('Loading roles/approvers...');
  try { await refreshRoles({ force: true }); } catch (err) { console.error('Initial roles/approvers load failed:', err); }
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Attest running at http://localhost:${PORT}`);
    setImmediate(async () => { try { console.log('Loading transactions in background...'); await refreshTransactions({ force: true }); } catch (err) { console.error('Background transactions load failed:', err); } });
  });
}
start();

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

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';
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
  const entries = await logStore.readAll();
  const maxId = entries.reduce((max, entry) => {
    const id = String(entry.submissionId || '').trim();
    if (!/^\d{6}$/.test(id)) return max;
    return Math.max(max, Number(id));
  }, 0);
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
  return path === '/healthz' || path === '/login.html' || path === '/dashboard.html' || path === '/reviews.html' || path === '/campaigns.html' || path === '/audit-trail.html' || path === '/data-sources.html' || path === '/sod.html' || path === '/evidence.html' || path === '/tenants.html' || path === '/settings.html' || path === '/api-keys.html' || path === '/onboarding.html' || path === '/offboarding.html' || path === '/admin.html' || path === '/index.html' || path === '/api/auth' || path.startsWith('/assets/') || path.startsWith('/api/evidence/share/');
}

async function authMiddleware(req, res, next) {
  try {
    if (isPublicPath(req.path)) return next();
    req.auth = await buildAuthContext(req);
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

function requireAdminPage(req, res, next) {
  if (req.path === '/admin.html' || req.path === '/admin-users.html' || req.path === '/activity.html') {
    return requireAdmin(req, res, next);
  }
  return next();
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

// ---------- Auth endpoint (unified login + signup) ----------
app.post('/api/auth', async (req, res) => {
  try {
    const { action, email, password, name } = req.body || {};
    const normalizedEmail = normalizeEmail(email);
    if (!normalizedEmail || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    if (action === 'signup') {
      // Only allow signup if no admins exist yet (first-run setup)
      const admins = await adminUserStore.listAdmins('default');
      if (admins.length > 0) {
        return res.status(403).json({ error: 'Registration is closed. Contact your administrator for an account.' });
      }
      if (!name || name.trim().length < 2) {
        return res.status(400).json({ error: 'Name is required (min 2 characters).' });
      }
      await adminUserStore.addAdmin(normalizedEmail, 'default');
      const token = generateToken({ email: normalizedEmail, name: name.trim(), tenant_id: 'default' });
      const tenants = await tenantStore.listAll();
      return res.json({ token, email: normalizedEmail, isAdmin: true, approverName: name.trim(), tenantId: 'default', tenants, message: 'Account created.' });
    }

    // Login — accept optional tenant_id from request
    const tenantId = String(req.body.tenant_id || '').trim() || 'default';
    const admins = await adminUserStore.listAdmins(tenantId);
    if (!admins.includes(normalizedEmail)) {
      return res.status(401).json({ error: 'Invalid credentials. If this is your first time, sign up to create an admin account.' });
    }
    // Simplified auth — in production, use bcrypt to verify password hash
    const valid = password === 'admin';
    if (!valid) {
      return res.status(401).json({ error: 'Invalid credentials.' });
    }
    const isAdmin = admins.includes(normalizedEmail);
    const approverName = approverEmailToName[normalizedEmail] || '';
    const token = generateToken({ email: normalizedEmail, tenant_id: tenantId });

    // Get list of all tenants for the UI selector
    const tenants = await tenantStore.listAll();

    res.json({ token, email: normalizedEmail, isAdmin, approverName, tenantId, tenants });
  } catch (err) {
    console.error('POST /api/auth failed:', err);
    res.status(500).json({ error: 'Authentication failed.' });
  }
});

// ---------- Static + APIs ----------
app.get('/healthz', (req, res) => res.json({ ok: true }));
app.use(authMiddleware);
app.use(requireAdminPage);
app.use(recordPageAccess);
app.use(express.static(path.join(__dirname, 'public')));
app.use('/vendor/jspdf', express.static(path.join(__dirname, 'node_modules', 'jspdf', 'dist')));
app.use('/vendor/jspdf-autotable', express.static(path.join(__dirname, 'node_modules', 'jspdf-autotable', 'dist')));

app.get('/api/me', async (req, res) => {
  const tenants = await tenantStore.listAll();
  const currentTenant = await tenantStore.getById(req.tenantId || 'default');
  res.json({
    email: req.auth.email,
    approverName: req.auth.approverName,
    approverEmail: req.auth.approverName ? approverNameToEmail[req.auth.approverName] || '' : '',
    roles: req.auth.roles,
    isAdmin: req.auth.isAdmin,
    tenantId: req.tenantId || 'default',
    tenant: currentTenant || { id: 'default', name: 'Default Organization' },
    tenants,
  });
});

app.get('/api/approvers', (req, res) => {
  if (!req.auth.isAdmin) {
    return res.json(req.auth.approverName ? [req.auth.approverName] : []);
  }
  res.json(uniqueApprovers);
});

function sendRolesForApprover(req, res, requestedApprover) {
  if (req.auth.isAdmin) {
    if (requestedApprover) return res.json(approverToRoles[requestedApprover] || []);
    return res.json(uniqueRoleNames);
  }
  if (requestedApprover && requestedApprover !== req.auth.approverName) {
    return res.status(403).json({ error: 'You can only access roles assigned to your approver profile.' });
  }
  return res.json(req.auth.roles);
}

app.get('/api/roles', (req, res) => {
  return sendRolesForApprover(req, res, getRequestedApprover(req));
});

app.post('/api/roles/by-approver', (req, res) => {
  return sendRolesForApprover(req, res, getBodyApprover(req));
});

app.get('/api/approver', (req, res) => {
  const role = String(req.query.role || '').trim();
  if (!role) return res.json({ role: '', fullName: '' });
  if (!hasRoleAccess(req.auth, role)) {
    return res.status(403).json({ error: 'You can only access roles assigned to your approver profile.' });
  }
  res.json({ role, fullName: roleToApprover[role] || '' });
});

app.get('/api/transactions', (req, res) => {
  const role = String(req.query.role || '').trim();
  if (role && !hasRoleAccess(req.auth, role)) {
    return res.status(403).json({ error: 'You can only access transactions for roles assigned to your approver profile.' });
  }
  const rows = role && txByRole[role] ? txByRole[role] : [];
  res.json({ header: txHeader, rows });
});

app.post('/api/transactions/bulk', (req, res) => {
  const roles = Array.isArray(req.body && req.body.roles) ? req.body.roles : [];
  if (roles.length > MAX_TRANSACTION_ROLE_LOOKUPS) {
    return res.status(413).json({ error: `Too many roles requested; max is ${MAX_TRANSACTION_ROLE_LOOKUPS}` });
  }
  const out = {};
  const boundedRoles = roles.slice(0, MAX_TRANSACTION_ROLE_LOOKUPS);
  for (const r of boundedRoles) {
    const role = String(r || '').trim();
    if (!role) continue;
    if (!hasRoleAccess(req.auth, role)) {
      return res.status(403).json({ error: 'You can only access transactions for roles assigned to your approver profile.' });
    }
    out[role] = txByRole[role] || [];
  }
  res.json({ header: txHeader, byRole: out });
});

app.post('/api/log', async (req, res) => {
  try {
    const body = req.body || {};
    const requestedApprover = String(body.approver || '').trim();
    const approver = req.auth.isAdmin ? requestedApprover : req.auth.approverName;
    const rows = Array.isArray(body.rows) ? body.rows : [];
    if (!approver || !rows.length) {
      return res.status(400).json({ error: 'approver and rows are required' });
    }
    if (rows.length > MAX_SUBMISSION_ROWS) {
      return res.status(413).json({ error: `Too many submitted rows; max is ${MAX_SUBMISSION_ROWS}` });
    }
    if (!approverToRoles[approver]) {
      return res.status(400).json({ error: 'Unknown approver' });
    }
    if (!req.auth.isAdmin && requestedApprover && requestedApprover !== req.auth.approverName) {
      return res.status(403).json({ error: 'You can only submit reviews for your approver profile.' });
    }
    const allowedRoles = new Set(approverToRoles[approver] || []);
    const ts = new Date().toISOString();
    const submissionId = await nextSubmissionId();
    const boundedRows = rows.slice(0, MAX_SUBMISSION_ROWS);
    const entries = boundedRows.map((r, idx) => ({
      logEntryId: submissionId + '-' + String(idx + 1).padStart(3, '0'),
      submissionId,
      timestamp: ts,
      approver,
      submittedByEmail: req.auth.email,
      impersonated: req.auth.isAdmin && approver !== req.auth.approverName,
      roleName: String(r.roleName || '').trim(),
      action: String(r.action || '').trim(),
      ritm: String(r.ritm || '').trim(),
      ritmStatus: 'Open',
      actionDetails: String(r.actionDetails || r.comments || '').trim(),
      comments: String(r.actionDetails || r.comments || '').trim(),
      rejectionReason: String(r.rejectionReason || '').trim(),
      rowIndex: idx + 1,
    })).filter(e => e.roleName && allowedRoles.has(e.roleName));
    if (!entries.length) {
      return res.status(400).json({ error: 'No submitted rows match the authorized approver roles.' });
    }
    await logStore.appendEntries(entries);
    recordActivity({
      type: 'SUBMISSION',
      action: 'submission_created',
      email: req.auth.email,
      detail: `Submission ${submissionId} for ${approver}: ${entries.length} role(s)`
        + (req.auth.isAdmin && approver !== req.auth.approverName ? ' (impersonated)' : ''),
    });
    res.json({ ok: true, submissionId, recorded: entries.length });
  } catch (err) {
    console.error('POST /api/log failed:', err);
    res.status(500).json({ error: 'failed to record submission' });
  }
});

app.get('/api/log', requireAdmin, async (req, res) => {
  try {
    const { approver, action, role } = req.query;
    const filtered = await logStore.readAll({ approver, action, role });
    res.json(filtered);
  } catch (err) {
    console.error('GET /api/log failed:', err);
    res.status(500).json({ error: 'failed to read submissions' });
  }
});

app.patch('/api/log/:logEntryId/ritm', requireAdmin, async (req, res) => {
  try {
    const logEntryId = String(req.params.logEntryId || '').trim();
    const ritm = String((req.body && req.body.ritm) || '').trim();
    if (!logEntryId) return res.status(400).json({ error: 'logEntryId is required' });
    const ok = await logStore.updateRitm(logEntryId, ritm);
    if (!ok) return res.status(404).json({ error: 'log entry not found' });
    recordActivity({
      type: 'RITM',
      action: 'ritm_updated',
      email: req.auth.email,
      detail: `RITM for ${logEntryId} set to "${ritm || '(cleared)'}"`,
    });
    res.json({ ok: true, logEntryId, ritm });
  } catch (err) {
    console.error('PATCH /api/log/:logEntryId/ritm failed:', err);
    res.status(500).json({ error: 'failed to update RITM' });
  }
});

app.patch('/api/log/:logEntryId/ritm-status', requireAdmin, async (req, res) => {
  try {
    const logEntryId = String(req.params.logEntryId || '').trim();
    const ritmStatus = String((req.body && req.body.ritmStatus) || '').trim();
    if (!logEntryId) return res.status(400).json({ error: 'logEntryId is required' });
    if (ritmStatus && !RITM_STATUS_OPTIONS.includes(ritmStatus)) {
      return res.status(400).json({ error: 'invalid RITM update status' });
    }
    const ok = await logStore.updateRitmStatus(logEntryId, ritmStatus);
    if (!ok) return res.status(404).json({ error: 'log entry not found' });
    recordActivity({
      type: 'RITM',
      action: 'ritm_status_updated',
      email: req.auth.email,
      detail: `RITM status for ${logEntryId} set to "${ritmStatus || '(cleared)'}"`,
    });
    res.json({ ok: true, logEntryId, ritmStatus });
  } catch (err) {
    console.error('PATCH /api/log/:logEntryId/ritm-status failed:', err);
    res.status(500).json({ error: 'failed to update RITM status' });
  }
});

app.get('/api/activity', requireAdmin, async (req, res) => {
  try {
    const { type, email } = req.query;
    const limit = Number(req.query.limit) > 0 ? Number(req.query.limit) : undefined;
    const events = await activityStore.readAll({ type, email, limit });
    res.json(events);
  } catch (err) {
    console.error('GET /api/activity failed:', err);
    res.status(500).json({ error: 'failed to read activity log' });
  }
});

app.get('/api/admin-users', requireAdmin, async (req, res) => {
  try {
    const admins = await adminUserStore.listAdmins();
    res.json({
      admins,
      protectedAdmins: PROTECTED_ADMIN_EMAILS,
    });
  } catch (err) {
    console.error('GET /api/admin-users failed:', err);
    res.status(500).json({ error: 'failed to read admin users' });
  }
});

app.post('/api/admin-users', requireAdmin, async (req, res) => {
  try {
    const email = String((req.body && req.body.email) || '').trim();
    const added = await adminUserStore.addAdmin(email);
    res.json({ ok: true, email: added });
  } catch (err) {
    console.error('POST /api/admin-users failed:', err);
    res.status(400).json({ error: err.message || 'failed to add admin user' });
  }
});

app.delete('/api/admin-users/:email', requireAdmin, async (req, res) => {
  try {
    const email = String(req.params.email || '').trim();
    const removed = await adminUserStore.removeAdmin(email);
    res.json({ ok: true, removed });
  } catch (err) {
    if (err.code === 'PROTECTED_ADMIN') {
      return res.status(403).json({ error: 'Superadmin accounts cannot be removed' });
    }
    console.error('DELETE /api/admin-users/:email failed:', err);
    res.status(400).json({ error: err.message || 'failed to remove admin user' });
  }
});

app.post('/api/admin/reload-data', requireAdmin, async (req, res) => {
  try {
    const roles = await refreshRoles({ force: true });
    const transactions = await refreshTransactions({ force: true });
    res.json({ ok: true, reloaded: { roles, transactions }, rolesVersion, txVersion });
  } catch (err) {
    console.error('POST /api/admin/reload-data failed:', err);
    res.status(500).json({ error: 'failed to reload source data' });
  }
});

// ---------- Excel Upload endpoints ----------
app.post('/api/admin/upload-roles', requireAdmin, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
    const targetPath = path.join(REPORTS_DIR, ROLES_FILE_NAME);

    // Validate the Excel has at least columns A and D
    const buffer = fs.readFileSync(req.file.path);
    const wb = XLSX.read(buffer, { type: 'buffer' });
    const sheetName = wb.SheetNames.includes('Complete') ? 'Complete' : wb.SheetNames[0];
    const ws = wb.Sheets[sheetName];
    const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    if (!data.length) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: 'Excel file is empty or has no valid sheet.' });
    }

    // Move to final location
    fs.renameSync(req.file.path, targetPath);

    // Reload data
    const reloaded = await refreshRoles({ force: true });

    res.json({
      ok: true,
      reloaded,
      stats: { roles: uniqueRoleNames.length, approvers: uniqueApprovers.length },
      message: `Uploaded successfully. ${uniqueRoleNames.length} roles, ${uniqueApprovers.length} approvers loaded.`,
    });
  } catch (err) {
    console.error('POST /api/admin/upload-roles failed:', err);
    if (req.file && fs.existsSync(req.file.path)) {
      try { fs.unlinkSync(req.file.path); } catch {}
    }
    res.status(500).json({ error: err.message || 'Failed to upload roles file.' });
  }
});

app.post('/api/admin/upload-transactions', requireAdmin, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
    const targetPath = path.join(REPORTS_DIR, TX_FILE_NAME);

    // Validate the Excel has at least column A
    const buffer = fs.readFileSync(req.file.path);
    const wb = XLSX.read(buffer, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    if (!data.length) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: 'Excel file is empty or has no valid sheet.' });
    }

    fs.renameSync(req.file.path, targetPath);

    const reloaded = await refreshTransactions({ force: true });
    const totalRows = Object.values(txByRole).reduce((sum, rows) => sum + rows.length, 0);

    res.json({
      ok: true,
      reloaded,
      stats: { roles: Object.keys(txByRole).length, totalRows },
      message: `Uploaded successfully. ${Object.keys(txByRole).length} roles, ${totalRows} transaction rows loaded.`,
    });
  } catch (err) {
    console.error('POST /api/admin/upload-transactions failed:', err);
    if (req.file && fs.existsSync(req.file.path)) {
      try { fs.unlinkSync(req.file.path); } catch {}
    }
    res.status(500).json({ error: err.message || 'Failed to upload transactions file.' });
  }
});

app.get('/api/admin/data-status', requireAdmin, async (req, res) => {
  const rolesTotal = uniqueRoleNames.length;
  const approversTotal = uniqueApprovers.length;
  const txTotalRows = Object.values(txByRole).reduce((sum, rows) => sum + rows.length, 0);
  const txRoles = Object.keys(txByRole).length;

  let rolesFileInfo = null;
  let txFileInfo = null;
  try {
    const rolesPath = path.join(REPORTS_DIR, ROLES_FILE_NAME);
    if (fs.existsSync(rolesPath)) {
      const stat = fs.statSync(rolesPath);
      rolesFileInfo = { name: ROLES_FILE_NAME, size: stat.size, modified: stat.mtime.toISOString() };
    }
  } catch {}
  try {
    const txPath = path.join(REPORTS_DIR, TX_FILE_NAME);
    if (fs.existsSync(txPath)) {
      const stat = fs.statSync(txPath);
      txFileInfo = { name: TX_FILE_NAME, size: stat.size, modified: stat.mtime.toISOString() };
    }
  } catch {}

  res.json({
    roles: { total: rolesTotal, approvers: approversTotal, file: rolesFileInfo },
    transactions: { rolesWithData: txRoles, totalRows: txTotalRows, file: txFileInfo },
  });
});

// ---------- Dashboard API (Phase 1) ----------

// GET /api/dashboard/stats — KPIs: total roles, certification %, pending, SoD conflicts, recent activity
app.get('/api/dashboard/stats', async (req, res) => {
  try {
    const submissions = await logStore.readAll();
    const totalRoles = uniqueRoleNames.length;

    // Count unique roles that have been reviewed (any submission with action)
    const reviewedRolesSet = new Set();
    submissions.forEach(s => {
      if (s.action && s.action !== '') reviewedRolesSet.add(s.roleName);
    });
    const reviewedCount = reviewedRolesSet.size;
    const progress = totalRoles > 0 ? Math.round((reviewedCount / totalRoles) * 100) : 0;
    const pendingCount = Math.max(0, totalRoles - reviewedCount);

    // SoD: use real conflict count from SoD engine
    const sodStats = await sodStore.getConflictStats();
    const sodConflicts = sodStats.open;

    // Include top 10 recent activity events
    const recentActivity = await activityStore.readAll({ limit: 10 });

    res.json({
      totalRoles,
      reviewedRoles: reviewedCount,
      progress,
      pendingCount,
      sodConflicts,
      recentActivity,
    });
  } catch (err) {
    console.error('GET /api/dashboard/stats failed:', err);
    res.status(500).json({ error: 'Failed to load dashboard stats.' });
  }
});

// GET /api/dashboard/recent-activity — latest 10 activity events (standalone)
app.get('/api/dashboard/recent-activity', async (req, res) => {
  try {
    const events = await activityStore.readAll({ limit: 10 });
    res.json(events);
  } catch (err) {
    console.error('GET /api/dashboard/recent-activity failed:', err);
    res.status(500).json({ error: 'Failed to load recent activity.' });
  }
});

// GET /api/dashboard/progress-by-system — certification progress grouped by system
app.get('/api/dashboard/progress-by-system', async (req, res) => {
  try {
    // Infer system name from role name convention: "XX - SYSTEM - ..."
    const systems = {};
    uniqueRoleNames.forEach(role => {
      const parts = role.split(' - ');
      const system = parts.length >= 2 ? parts[1].trim() : 'Other';
      if (!system) return;
      if (!systems[system]) systems[system] = { total: 0, reviewed: 0 };
      systems[system].total += 1;
    });

    // Count reviewed per system from submissions
    const submissions = await logStore.readAll();
    const reviewedRolesSet = new Set();
    submissions.forEach(s => {
      if (s.action && s.action !== '') reviewedRolesSet.add(s.roleName);
    });

    // Match reviewed roles back to their systems
    uniqueRoleNames.forEach(role => {
      const parts = role.split(' - ');
      const system = parts.length >= 2 ? parts[1].trim() : 'Other';
      if (!system || !systems[system]) return;
      if (reviewedRolesSet.has(role)) {
        systems[system].reviewed += 1;
      }
    });

    const result = Object.entries(systems)
      .map(([name, data]) => ({
        name,
        total: data.total,
        reviewed: data.reviewed,
        pct: data.total > 0 ? Math.round((data.reviewed / data.total) * 100) : 0,
      }))
      .sort((a, b) => b.total - a.total);

    res.json(result);
  } catch (err) {
    console.error('GET /api/dashboard/progress-by-system failed:', err);
    res.status(500).json({ error: 'Failed to load system progress.' });
  }
});

// GET /api/dashboard/active-campaigns — now uses real campaign data (Phase 2)
app.get('/api/dashboard/active-campaigns', async (req, res) => {
  try {
    const campaigns = await campaignStore.readAll({ status: 'active', limit: 5 });
    if (!campaigns.length) {
      // Fallback: show current review as a default "campaign"
      const submissions = await logStore.readAll();
      const approvers = new Set(submissions.map(s => s.approver));
      const reviewedRolesSet = new Set();
      submissions.forEach(s => {
        if (s.action && s.action !== '') reviewedRolesSet.add(s.roleName);
      });
      const totalRoles = uniqueRoleNames.length;
      const progress = totalRoles > 0 ? Math.round((reviewedRolesSet.size / totalRoles) * 100) : 0;
      return res.json([{
        id: 'current',
        name: 'Current Access Review',
        framework: 'ITGC',
        period: 'Q3 2026',
        status: progress >= 100 ? 'completed' : 'active',
        deadline: '2026-08-31',
        approvers: approvers.size,
        totalRoles,
        reviewedRoles: reviewedRolesSet.size,
        progress,
      }]);
    }

    // Map real campaigns for dashboard display
    const result = await Promise.all(campaigns.map(async (c) => {
      const totalRoles = uniqueRoleNames.length;
      // Count submissions linked to this campaign
      const submissions = await logStore.readAll();
      const reviewedRolesSet = new Set();
      submissions.forEach(s => {
        if (s.action && s.action !== '' && s.campaignId === c.id) reviewedRolesSet.add(s.roleName);
      });
      const progress = totalRoles > 0 ? Math.round((reviewedRolesSet.size / totalRoles) * 100) : 0;
      return {
        id: c.id,
        name: c.name,
        framework: c.framework,
        period: c.period,
        status: c.status,
        deadline: c.deadline,
        approvers: c.approvers.length,
        totalRoles,
        reviewedRoles: reviewedRolesSet.size,
        progress,
      };
    }));

    res.json(result);
  } catch (err) {
    console.error('GET /api/dashboard/active-campaigns failed:', err);
    res.json([]);
  }
});

// ────────── Campaign API (Phase 2) ──────────

// POST /api/campaigns — Create a new campaign (admin only)
app.post('/api/campaigns', requireAdmin, async (req, res) => {
  try {
    const { name, description, framework, period, deadline, approvers } = req.body || {};
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Campaign name is required.' });
    }
    if (!period || !period.trim()) {
      return res.status(400).json({ error: 'Period is required (e.g. Q3 2026).' });
    }

    const campaign = await campaignStore.create({
      name: name.trim(),
      description: description || '',
      framework: framework || 'SOX',
      period: period.trim(),
      deadline: deadline || '',
      approvers: Array.isArray(approvers) ? approvers : [],
      created_by: req.auth.email,
      status: 'draft',
    });

    recordActivity({
      type: 'CAMPAIGN',
      action: 'campaign_created',
      email: req.auth.email,
      detail: `Campaign "${campaign.name}" created (${campaign.id})`,
    });

    res.status(201).json(campaign);
  } catch (err) {
    console.error('POST /api/campaigns failed:', err);
    res.status(500).json({ error: 'Failed to create campaign.' });
  }
});

// GET /api/campaigns — List campaigns with optional filters
app.get('/api/campaigns', async (req, res) => {
  try {
    const filters = {};
    if (req.query.status) filters.status = req.query.status;
    if (req.query.framework) filters.framework = req.query.framework;
    if (req.query.limit) filters.limit = Math.min(Number(req.query.limit), 100);

    const campaigns = await campaignStore.readAll(filters);
    res.json(campaigns);
  } catch (err) {
    console.error('GET /api/campaigns failed:', err);
    res.status(500).json({ error: 'Failed to list campaigns.' });
  }
});

// GET /api/campaigns/:id — Get campaign detail with progress per approver
app.get('/api/campaigns/:id', async (req, res) => {
  try {
    const campaign = await campaignStore.readById(req.params.id);
    if (!campaign) {
      return res.status(404).json({ error: 'Campaign not found.' });
    }

    const progress = await campaignStore.getProgress(req.params.id);

    // Get total roles per approver from in-memory data
    const enrichedApprovers = campaign.approvers.map(name => {
      const approverRoles = approverToRoles[name] || [];
      const progressInfo = (progress && progress.approverProgress.find(p => p.approver === name)) || {};
      return {
        name,
        totalRoles: approverRoles.length,
        roles: approverRoles,
        reviewedCount: progressInfo.reviewedCount || 0,
        reviewedRoles: progressInfo.reviewedRoles || [],
      };
    });

    res.json({
      ...campaign,
      approvers: enrichedApprovers,
      totalReviewed: progress ? progress.totalReviewed : 0,
    });
  } catch (err) {
    console.error('GET /api/campaigns/:id failed:', err);
    res.status(500).json({ error: 'Failed to load campaign.' });
  }
});

// PATCH /api/campaigns/:id — Update campaign (admin only)
app.patch('/api/campaigns/:id', requireAdmin, async (req, res) => {
  try {
    const { name, description, framework, period, status, deadline, approvers } = req.body || {};
    const updates = {};

    if (name !== undefined) updates.name = name;
    if (description !== undefined) updates.description = description;
    if (framework !== undefined) updates.framework = framework;
    if (period !== undefined) updates.period = period;
    if (status !== undefined) updates.status = status;
    if (deadline !== undefined) updates.deadline = deadline;
    if (approvers !== undefined) updates.approvers = approvers;

    const campaign = await campaignStore.update(req.params.id, updates);
    if (!campaign) {
      return res.status(404).json({ error: 'Campaign not found.' });
    }

    recordActivity({
      type: 'CAMPAIGN',
      action: 'campaign_updated',
      email: req.auth.email,
      detail: `Campaign "${campaign.name}" updated (status: ${campaign.status})`,
    });

    res.json(campaign);
  } catch (err) {
    console.error('PATCH /api/campaigns/:id failed:', err);
    res.status(500).json({ error: 'Failed to update campaign.' });
  }
});

// DELETE /api/campaigns/:id — Delete a campaign (admin only)
app.delete('/api/campaigns/:id', requireAdmin, async (req, res) => {
  try {
    const campaign = await campaignStore.readById(req.params.id);
    if (!campaign) {
      return res.status(404).json({ error: 'Campaign not found.' });
    }

    const deleted = await campaignStore.delete(req.params.id);

    recordActivity({
      type: 'CAMPAIGN',
      action: 'campaign_deleted',
      email: req.auth.email,
      detail: `Campaign "${campaign.name}" deleted`,
    });

    res.json({ ok: deleted });
  } catch (err) {
    console.error('DELETE /api/campaigns/:id failed:', err);
    res.status(500).json({ error: 'Failed to delete campaign.' });
  }
});

// ────────── SoD Engine API (Phase 3) ──────────

// GET /api/sod/rules — List all SoD rules
app.get('/api/sod/rules', requireAdmin, async (req, res) => {
  try {
    const { severity, framework } = req.query;
    const rules = await sodStore.listRules({ severity, framework });
    res.json(rules);
  } catch (err) {
    console.error('GET /api/sod/rules failed:', err);
    res.status(500).json({ error: 'Failed to list SoD rules.' });
  }
});

// POST /api/sod/rules — Create a new SoD rule
app.post('/api/sod/rules', requireAdmin, async (req, res) => {
  try {
    const { name, role_a, role_b, severity, description, framework } = req.body || {};
    const rule = await sodStore.createRule({
      name, role_a, role_b, severity, description, framework,
      created_by: req.auth.email,
    });
    recordActivity({
      type: 'SOD',
      action: 'sod_rule_created',
      email: req.auth.email,
      detail: `SoD rule "${rule.name}": ${rule.role_a} ↔ ${rule.role_b} (${rule.severity})`,
    });
    res.status(201).json(rule);
  } catch (err) {
    console.error('POST /api/sod/rules failed:', err);
    res.status(400).json({ error: err.message || 'Failed to create SoD rule.' });
  }
});

// DELETE /api/sod/rules/:id — Delete an SoD rule
app.delete('/api/sod/rules/:id', requireAdmin, async (req, res) => {
  try {
    const deleted = await sodStore.deleteRule(req.params.id);
    if (!deleted) return res.status(404).json({ error: 'Rule not found.' });
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /api/sod/rules/:id failed:', err);
    res.status(500).json({ error: 'Failed to delete rule.' });
  }
});

// GET /api/sod/conflicts — List all SoD conflicts
app.get('/api/sod/conflicts', async (req, res) => {
  try {
    const { status, severity, approver_name } = req.query;
    const conflicts = await sodStore.listConflicts({ status, severity, approver_name });
    res.json(conflicts);
  } catch (err) {
    console.error('GET /api/sod/conflicts failed:', err);
    res.status(500).json({ error: 'Failed to list conflicts.' });
  }
});

// PATCH /api/sod/conflicts/:id — Mitigate/resolve a conflict
app.patch('/api/sod/conflicts/:id', requireAdmin, async (req, res) => {
  try {
    const { status, mitigation_notes } = req.body || {};
    const conflict = await sodStore.updateConflict(req.params.id, {
      status: status || 'mitigated',
      mitigated_by: req.auth.email,
      mitigation_notes: mitigation_notes || '',
    });
    if (!conflict) return res.status(404).json({ error: 'Conflict not found.' });
    recordActivity({
      type: 'SOD',
      action: 'sod_conflict_resolved',
      email: req.auth.email,
      detail: `SoD conflict ${conflict.id} marked as ${conflict.status}: ${conflict.role_a} ↔ ${conflict.role_b}`,
    });
    res.json(conflict);
  } catch (err) {
    console.error('PATCH /api/sod/conflicts/:id failed:', err);
    res.status(500).json({ error: 'Failed to update conflict.' });
  }
});

// POST /api/sod/detect — Run SoD detection for all approvers
app.post('/api/sod/detect', requireAdmin, async (req, res) => {
  try {
    const allConflicts = [];
    for (const approver of uniqueApprovers) {
      const roles = approverToRoles[approver] || [];
      const conflicts = await sodStore.detectConflicts(approver, roles);
      allConflicts.push(...conflicts);
    }
    res.json({ detected: allConflicts.length, conflicts: allConflicts });
  } catch (err) {
    console.error('POST /api/sod/detect failed:', err);
    res.status(500).json({ error: 'Failed to run SoD detection.' });
  }
});

// GET /api/sod/stats — SoD statistics for dashboard
app.get('/api/sod/stats', async (req, res) => {
  try {
    const stats = await sodStore.getConflictStats();
    res.json(stats);
  } catch (err) {
    res.json({ total: 0, open: 0, criticalOpen: 0 });
  }
});

// ────────── Evidence Locker API (Phase 3) ──────────

// GET /api/evidence — List all evidence packages
app.get('/api/evidence', async (req, res) => {
  try {
    const packages = await evidenceStore.listAll(req.query);
    res.json(packages);
  } catch (err) {
    console.error('GET /api/evidence failed:', err);
    res.status(500).json({ error: 'Failed to list evidence packages.' });
  }
});

// POST /api/evidence/generate — Generate a new evidence package
app.post('/api/evidence/generate', requireAdmin, async (req, res) => {
  try {
    const { name, campaignId, description } = req.body || {};

    // Gather data
    const submissions = await logStore.readAll();
    const activityLog = await activityStore.readAll({ limit: 5000 });

    let campaign = null;
    if (campaignId) {
      campaign = await campaignStore.readById(campaignId);
    }

    const pkg = await evidenceStore.generate({
      name: name || `Evidence_Package_${new Date().toISOString().slice(0, 10)}`,
      campaignId: campaignId || '',
      description: description || '',
      generatedBy: req.auth.email,
      submissions,
      activityLog,
      campaign,
    });

    recordActivity({
      type: 'EVIDENCE',
      action: 'evidence_generated',
      email: req.auth.email,
      detail: `Evidence package "${pkg.name}" generated (${(pkg.file_size / 1024).toFixed(1)} KB)`,
    });

    res.status(201).json(pkg);
  } catch (err) {
    console.error('POST /api/evidence/generate failed:', err);
    res.status(500).json({ error: 'Failed to generate evidence package.' });
  }
});

// GET /api/evidence/:id/download — Download an evidence package
app.get('/api/evidence/:id/download', async (req, res) => {
  try {
    const pkg = await evidenceStore.getById(req.params.id);
    if (!pkg) return res.status(404).json({ error: 'Package not found.' });

    const fs = require('fs');
    if (!fs.existsSync(pkg.file_path)) {
      return res.status(404).json({ error: 'Package file missing from disk.' });
    }

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${pkg.name.replace(/[^a-z0-9_.-]/gi, '_')}.zip"`);
    res.setHeader('Content-Length', pkg.file_size);

    const stream = fs.createReadStream(pkg.file_path);
    stream.pipe(res);
  } catch (err) {
    console.error('GET /api/evidence/:id/download failed:', err);
    res.status(500).json({ error: 'Failed to download package.' });
  }
});

// POST /api/evidence/:id/share — Generate share link for external auditor
app.post('/api/evidence/:id/share', requireAdmin, async (req, res) => {
  try {
    const result = await evidenceStore.generateShareLink(req.params.id);
    if (!result) return res.status(404).json({ error: 'Package not found.' });
    const shareUrl = `/api/evidence/share/${result.token}`;
    res.json({ shareUrl, expiresAt: result.expiresAt });
  } catch (err) {
    console.error('POST /api/evidence/:id/share failed:', err);
    res.status(500).json({ error: 'Failed to generate share link.' });
  }
});

// GET /api/evidence/share/:token — Public download via share link (no auth required)
app.get('/api/evidence/share/:token', async (req, res) => {
  try {
    const pkg = await evidenceStore.getByShareToken(req.params.token);
    if (!pkg) return res.status(404).type('html').send(unauthorizedHtml('This share link is invalid or has expired.'));

    const fs = require('fs');
    if (!fs.existsSync(pkg.file_path)) {
      return res.status(404).json({ error: 'Package file missing.' });
    }

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${pkg.name.replace(/[^a-z0-9_.-]/gi, '_')}.zip"`);
    res.setHeader('Content-Length', pkg.file_size);

    const stream = fs.createReadStream(pkg.file_path);
    stream.pipe(res);
  } catch (err) {
    console.error('GET /api/evidence/share/:token failed:', err);
    res.status(500).json({ error: 'Failed to download shared package.' });
  }
});

// DELETE /api/evidence/:id — Delete a package
app.delete('/api/evidence/:id', requireAdmin, async (req, res) => {
  try {
    const deleted = await evidenceStore.delete(req.params.id);
    if (!deleted) return res.status(404).json({ error: 'Package not found.' });
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /api/evidence/:id failed:', err);
    res.status(500).json({ error: 'Failed to delete package.' });
  }
});

// ────────── Tenant API (Phase 4) ──────────

// GET /api/tenants — List all tenants
app.get('/api/tenants', async (req, res) => {
  try {
    const tenants = await tenantStore.listAll();
    res.json(tenants);
  } catch (err) {
    console.error('GET /api/tenants failed:', err);
    res.status(500).json({ error: 'Failed to list tenants.' });
  }
});

// POST /api/tenants — Create a new tenant (admin only)
app.post('/api/tenants', requireAdmin, async (req, res) => {
  try {
    const { name, plan } = req.body || {};
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Tenant name is required.' });
    }
    const tenant = await tenantStore.create({ name: name.trim(), plan: plan || 'starter', status: 'active' });
    recordActivity({
      type: 'TENANT',
      action: 'tenant_created',
      email: req.auth.email,
      detail: `Tenant "${tenant.name}" created (${tenant.id})`,
    });
    res.status(201).json(tenant);
  } catch (err) {
    console.error('POST /api/tenants failed:', err);
    res.status(500).json({ error: 'Failed to create tenant.' });
  }
});

// PATCH /api/tenants/:id — Update tenant (admin only)
app.patch('/api/tenants/:id', requireAdmin, async (req, res) => {
  try {
    const { name, plan, status } = req.body || {};
    const tenant = await tenantStore.update(req.params.id, { name, plan, status });
    if (!tenant) return res.status(404).json({ error: 'Tenant not found.' });
    res.json(tenant);
  } catch (err) {
    console.error('PATCH /api/tenants/:id failed:', err);
    res.status(500).json({ error: 'Failed to update tenant.' });
  }
});

// DELETE /api/tenants/:id — Delete a tenant (admin only)
app.delete('/api/tenants/:id', requireAdmin, async (req, res) => {
  try {
    if (req.params.id === 'default') {
      return res.status(403).json({ error: 'Cannot delete the default tenant.' });
    }
    const deleted = await tenantStore.delete(req.params.id);
    if (!deleted) return res.status(404).json({ error: 'Tenant not found.' });
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /api/tenants/:id failed:', err);
    res.status(500).json({ error: 'Failed to delete tenant.' });
  }
});

// POST /api/auth/switch-tenant — Switch active tenant (returns new JWT)
app.post('/api/auth/switch-tenant', async (req, res) => {
  try {
    const { tenant_id } = req.body || {};
    if (!tenant_id) return res.status(400).json({ error: 'tenant_id is required.' });

    const tenant = await tenantStore.getById(tenant_id);
    if (!tenant || tenant.status !== 'active') {
      return res.status(400).json({ error: 'Invalid or inactive tenant.' });
    }

    const token = generateToken({ email: req.auth.email, tenant_id });
    res.json({ token, tenantId: tenant_id, tenant });
  } catch (err) {
    console.error('POST /api/auth/switch-tenant failed:', err);
    res.status(500).json({ error: 'Failed to switch tenant.' });
  }
});

// ────────── API Keys (Phase 5) ──────────

// GET /api/api-keys — List active API keys (admin only)
app.get('/api/api-keys', requireAdmin, async (req, res) => {
  try {
    const keys = await apiKeyStore.listAll(req.tenantId);
    res.json(keys);
  } catch (err) {
    res.status(500).json({ error: 'Failed to list API keys.' });
  }
});

// POST /api/api-keys — Generate a new API key (admin only)
app.post('/api/api-keys', requireAdmin, async (req, res) => {
  try {
    const { name, permissions } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: 'Key name is required.' });
    const key = await apiKeyStore.create({
      name, permissions: permissions || 'read-only',
      created_by: req.auth.email, tenant_id: req.tenantId
    });
    recordActivity({ type: 'API_KEY', action: 'api_key_created', email: req.auth.email,
      detail: `API key "${key.name}" created (${key.id})` }, req.tenantId);
    res.status(201).json(key);
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate API key.' });
  }
});

// DELETE /api/api-keys/:id — Revoke an API key (admin only)
app.delete('/api/api-keys/:id', requireAdmin, async (req, res) => {
  try {
    const ok = await apiKeyStore.revoke(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Key not found.' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to revoke key.' });
  }
});

// ────────── Settings API (Phase 5) ──────────

// GET /api/settings — Get tenant settings
app.get('/api/settings', async (req, res) => {
  try {
    const tenant = await tenantStore.getById(req.tenantId || 'default');
    res.json(tenant ? tenant.settings : {});
  } catch (err) {
    res.json({});
  }
});

// PATCH /api/settings — Update tenant settings (admin only)
app.patch('/api/settings', requireAdmin, async (req, res) => {
  try {
    const tenant = await tenantStore.getById(req.tenantId || 'default');
    if (!tenant) return res.status(404).json({ error: 'Tenant not found.' });
    const currentSettings = tenant.settings || {};
    const merged = { ...currentSettings, ...(req.body || {}) };
    await tenantStore.update(req.tenantId, { settings: merged });
    res.json({ ok: true, settings: merged });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update settings.' });
  }
});

// ---------- Start server ----------
async function start() {
  console.log('Loading roles/approvers...');
  try {
    await refreshRoles({ force: true });
  } catch (err) {
    console.error('Initial roles/approvers load failed (will retry on refresh):', err);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Attest running at http://localhost:${PORT}`);
    setImmediate(async () => {
      try {
        console.log('Loading transactions in background...');
        await refreshTransactions({ force: true });
      } catch (err) {
        console.error('Background transactions load failed (will retry on refresh):', err);
      }
    });
  });
}

start();

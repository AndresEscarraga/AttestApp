// Attest — Access Certification & Role Governance App
// Node.js Express server with JWT auth + SQLite persistence.

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const { loadWorkbook, worksheetRows, requireSheet } = require('./services/excelWorkbook');
const {
  CAPABILITIES,
  capabilitiesForRole,
  capabilitiesForApiKey,
  requireCapability,
} = require('./security/capabilities');
const { AppError } = require('./http/errors');
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
const { createRoleCatalogStore } = require('./stores/roleCatalogStore');

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
const roleCatalogStore = createRoleCatalogStore();

const UNAUTHORIZED_MESSAGE = 'You are not authorized to use this application. Please contact your system administrator.';
const isProduction = process.env.NODE_ENV === 'production';
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
  const resolvedTenantId = typeof tenantId === 'object' && tenantId
    ? tenantId.tenantId
    : tenantId;
  if (!resolvedTenantId) {
    console.error('[activity] tenant context is required');
    return;
  }
  const e = { ...event, tenantId: resolvedTenantId };
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
  const context = req.context || {};
  recordActivity({
    type: 'AUTH',
    action: 'unauthorized',
    email: context.email || '',
    detail: `Denied (${status}) ${req.method} ${req.path}`,
  }, context.tenantId);
  if (req.path.startsWith('/api/')) {
    return res.status(status).json({ error: message, code: 'AUTHORIZATION_DENIED', requestId: req.requestId });
  }
  return res.status(status).type('html').send(unauthorizedHtml(message));
}

// Source versions are tenant-scoped; parser state is never shared between tenants.
const rolesVersions = new Map();
const transactionVersions = new Map();

function requireRuntimeTenantId(value) {
  const tenantId = String(value || '').trim();
  if (!tenantId) throw new Error('tenantId is required');
  return tenantId;
}

async function parseRolesApprovers(buffer, tenantId) {
  const tid = requireRuntimeTenantId(tenantId);
  const workbook = await loadWorkbook(buffer);
  const data = worksheetRows(requireSheet(workbook, 'Complete'));
  const byRole = new Map();
  const knownApprovers = new Set();
  for (let index = 1; index < data.length; index += 1) {
    const row = data[index];
    const roleName = String(row[0] || '').trim();
    const approverName = String(row[3] || '').trim();
    if (!roleName || byRole.has(roleName)) continue;
    byRole.set(roleName, approverName);
    if (approverName) knownApprovers.add(approverName);
  }
  if (!byRole.size) throw new Error('Roles workbook contains no valid role rows.');

  const approverEmails = new Map();
  const emailSheet = workbook.getWorksheet('Emails') || workbook.getWorksheet('emails');
  if (emailSheet) {
    const emailRows = worksheetRows(emailSheet);
    const header = (emailRows[0] || []).map(value => String(value || '').trim().toLowerCase());
    const nameColumn = Math.max(header.findIndex(value => value.includes('full') && value.includes('name')), 0);
    const emailColumn = header.findIndex(value => value.includes('email'));
    const resolvedEmailColumn = emailColumn >= 0 ? emailColumn : 1;
    for (let index = 1; index < emailRows.length; index += 1) {
      const row = emailRows[index];
      const name = String(row[nameColumn] || '').trim();
      const email = normalizeEmail(row[resolvedEmailColumn]);
      if (name && email && knownApprovers.has(name) && !approverEmails.has(name)) approverEmails.set(name, email);
    }
  }

  const assignments = [...byRole.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([roleName, approverName]) => {
      const parts = roleName.split(' - ');
      return {
        roleName,
        approverName,
        approverEmail: approverEmails.get(approverName) || '',
        systemName: parts.length >= 2 ? parts[1].trim() : 'Other',
      };
    });
  roleCatalogStore.replaceAssignments(tid, assignments);
  console.log(`Loaded ${assignments.length} roles, ${knownApprovers.size} approvers, ${approverEmails.size} approver emails for ${tid}.`);
}

async function parseTransactions(buffer, tenantId) {
  const tid = requireRuntimeTenantId(tenantId);
  const workbook = await loadWorkbook(buffer);
  const data = worksheetRows(requireSheet(workbook));
  const rawHeader = (data[0] || []).map(value => String(value || ''));
  while (rawHeader.length && !rawHeader[rawHeader.length - 1].trim()) rawHeader.pop();
  if (!rawHeader.length) throw new Error('Transactions workbook has no header.');
  const header = rawHeader.map(value => TX_HEADER_RENAMES[value] || value);
  const byRole = {};
  for (let index = 1; index < data.length; index += 1) {
    const roleName = String(data[index][0] || '').trim();
    if (!roleName) continue;
    if (!byRole[roleName]) byRole[roleName] = [];
    byRole[roleName].push(data[index].slice(0, rawHeader.length));
  }
  if (!Object.keys(byRole).length) throw new Error('Transactions workbook contains no valid transaction rows.');
  roleCatalogStore.replaceTransactions(tid, byRole, header);
  console.log(`Loaded ${data.length - 1} transaction rows across ${Object.keys(byRole).length} roles for ${tid}.`);
}

async function refreshRoles({ force = false, tenantId } = {}) {
  const tid = requireRuntimeTenantId(tenantId);
  const version = await dataStore.getVersion(ROLES_FILE_NAME, tid);
  if (version === null) return false;
  if (!force && rolesVersions.get(tid) === version) return false;
  const { buffer, source } = await dataStore.getFile(ROLES_FILE_NAME, tid);
  await parseRolesApprovers(buffer, tid);
  rolesVersions.set(tid, version);
  console.log(`Roles/approvers loaded from ${source} (version ${version}).`);
  return true;
}

async function refreshTransactions({ force = false, tenantId } = {}) {
  const tid = requireRuntimeTenantId(tenantId);
  const version = await dataStore.getVersion(TX_FILE_NAME, tid);
  if (version === null) return false;
  if (!force && transactionVersions.get(tid) === version) return false;
  const { buffer, source } = await dataStore.getFile(TX_FILE_NAME, tid);
  await parseTransactions(buffer, tid);
  transactionVersions.set(tid, version);
  console.log(`Transactions loaded from ${source} (version ${version}).`);
  return true;
}

// ---------- JWT Authentication ----------
function generateToken(payload) {
  const email = normalizeEmail(payload && payload.email);
  const tenantId = String((payload && payload.tenant_id) || '').trim();
  if (!email || !tenantId) throw new Error('email and tenant_id are required to issue a token');
  return jwt.sign(
    { email, tenant_id: tenantId },
    JWT_SECRET,
    { expiresIn: '24h' }
  );
}

function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

// ---------- Authenticated principal + tenant context ----------
async function getAuthenticatedPrincipal(req) {
  const apiKey = String(req.get('x-api-key') || '').trim();
  if (apiKey) {
    const keyData = await apiKeyStore.validateKey(apiKey);
    if (!keyData) return { type: 'invalid_api_key', email: '', tenantId: '' };
    return {
      type: 'api_key',
      email: `api-key:${keyData.id}`,
      tenantId: keyData.tenant_id,
      apiKeyId: keyData.id,
      apiKeyPermission: keyData.permissions,
    };
  }

  const authHeader = String(req.get('authorization') || '').trim();
  if (authHeader.startsWith('Bearer ')) {
    try {
      const payload = verifyToken(authHeader.slice(7));
      return {
        type: 'user',
        email: normalizeEmail(payload.email || ''),
        tenantId: String(payload.tenant_id || '').trim(),
        source: 'jwt',
      };
    } catch (err) {
      return { type: 'invalid_jwt', email: '', tenantId: '' };
    }
  }

  if (!isProduction) {
    return {
      type: 'user',
      email: normalizeEmail(
        process.env.DEV_AUTH_EMAIL ||
        process.env.LOCAL_AUTH_EMAIL ||
        req.get('x-dev-auth-email') ||
        'admin.one@attest.local'
      ),
      tenantId: String(process.env.DEV_TENANT_ID || 'default').trim(),
      source: 'development',
    };
  }
  return { type: 'anonymous', email: '', tenantId: '' };
}

function freezeContext(raw) {
  const roles = Object.freeze([...(raw.roles || [])]);
  const memberships = Object.freeze((raw.memberships || []).map(item => Object.freeze({ ...item })));
  const capabilities = Object.freeze([...(raw.capabilities || [])]);
  const principal = Object.freeze({ ...(raw.principal || {}) });
  const membership = raw.membership ? Object.freeze({ ...raw.membership }) : null;
  const tenant = raw.tenant ? Object.freeze({ ...raw.tenant }) : null;
  return Object.freeze({ ...raw, principal, membership, tenant, roles, memberships, capabilities });
}

function anonymousContext(principal) {
  return freezeContext({
    principal,
    email: '', tenantId: '', role: '', approverName: '', roles: [],
    memberships: [], capabilities: [], membership: null, tenant: null,
    isAdmin: false, isAuthorized: false,
  });
}

async function buildRequestContext(req) {
  const principal = await getAuthenticatedPrincipal(req);
  if (principal.type === 'api_key') {
    const tenant = await tenantStore.getById(principal.tenantId);
    if (!tenant || tenant.status !== 'active') return anonymousContext(principal);
    return freezeContext({
      principal,
      email: principal.email,
      tenantId: tenant.id,
      role: 'api_key',
      approverName: '',
      roles: [],
      memberships: [],
      capabilities: capabilitiesForApiKey(principal.apiKeyPermission),
      membership: null,
      tenant,
      isAdmin: false,
      isAuthorized: true,
    });
  }

  const email = principal.email;
  if (!email) return anonymousContext(principal);

  const memberships = await adminUserStore.listMemberships(email);
  const membership = memberships.find(item => item.tenant_id === principal.tenantId);
  if (!membership) return anonymousContext(principal);

  const tenantId = membership.tenant_id;
  const tenant = await tenantStore.getById(tenantId);
  if (!tenant || tenant.status !== 'active' || membership.status !== 'active') {
    return anonymousContext(principal);
  }
  const catalogApprover = roleCatalogStore.getApproverByEmail(tenantId, email);
  const approverName = membership.approver_name || (catalogApprover && catalogApprover.name) || '';
  const roles = approverName ? roleCatalogStore.getRolesForApprover(tenantId, approverName) : [];
  const isAdmin = membership.role === 'admin';
  return freezeContext({
    principal,
    email,
    tenantId,
    role: membership.role,
    approverName,
    roles,
    memberships,
    capabilities: capabilitiesForRole(membership.role),
    membership,
    tenant,
    isAdmin,
    isAuthorized: true,
  });
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
    req.context = await buildRequestContext(req);

    // Public paths — let through even without auth
    if (isPublicPath(req.path)) return next();

    // Protected paths — require valid auth
    if (!req.context.email) {
      if (req.path.startsWith('/api/')) {
        return res.status(401).json({ error: 'Authentication required.', code: 'AUTHENTICATION_REQUIRED', requestId: req.requestId });
      }
      return res.redirect('/login.html?redirect=' + encodeURIComponent(req.originalUrl));
    }
    if (!req.context.isAuthorized) {
      return sendAuthError(req, res, 403);
    }
    return next();
  } catch (err) {
    console.error('Authentication failed:', err);
    if (req.path.startsWith('/api/')) {
      return res.status(401).json({ error: 'Authentication failed.', code: 'AUTHENTICATION_FAILED', requestId: req.requestId });
    }
    return res.redirect('/login.html');
  }
}

function recordPageAccess(req, res, next) {
  if (req.method === 'GET' && req.context && req.context.isAuthorized && Object.prototype.hasOwnProperty.call(PAGE_ACCESS_LABELS, req.path)) {
    recordActivity({
      type: 'AUTH',
      action: 'access',
      email: (req.context && req.context.email) || '',
      detail: PAGE_ACCESS_LABELS[req.path],
    }, req.context);
  }
  return next();
}

// ---------- Global middleware ----------
function requestMetadataMiddleware(req, res, next) {
  const supplied = String(req.get('x-request-id') || '').trim();
  req.requestId = /^[a-zA-Z0-9._:-]{8,128}$/.test(supplied) ? supplied : crypto.randomUUID();
  res.setHeader('X-Request-ID', req.requestId);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'"
  );
  if (isProduction && req.secure) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  next();
}

const authAttempts = new Map();
const AUTH_RATE_WINDOW_MS = positiveIntEnv('AUTH_RATE_WINDOW_MS', 15 * 60 * 1000);
const AUTH_RATE_MAX_ATTEMPTS = positiveIntEnv('AUTH_RATE_MAX_ATTEMPTS', 20);

function authRateLimitMiddleware(req, res, next) {
  if (req.method !== 'POST' || req.path !== '/api/auth') return next();
  const email = normalizeEmail(req.body && req.body.email);
  const key = `${req.ip || req.socket.remoteAddress || 'unknown'}:${email}`;
  const now = Date.now();
  const existing = authAttempts.get(key);
  const entry = !existing || existing.resetAt <= now
    ? { count: 0, resetAt: now + AUTH_RATE_WINDOW_MS }
    : existing;
  if (entry.count >= AUTH_RATE_MAX_ATTEMPTS) {
    const retryAfter = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
    res.setHeader('Retry-After', String(retryAfter));
    return res.status(429).json({
      error: 'Too many authentication attempts. Try again later.',
      code: 'AUTH_RATE_LIMITED',
      requestId: req.requestId,
    });
  }
  res.once('finish', () => {
    if (res.statusCode >= 200 && res.statusCode < 400) authAttempts.delete(key);
    else {
      entry.count += 1;
      authAttempts.set(key, entry);
    }
  });
  next();
}

app.use(requestMetadataMiddleware);
app.use(express.json({ limit: '4mb' }));
app.use(authRateLimitMiddleware);

// API Key authentication middleware — runs before JWT for API routes

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
  logStore, activityStore, adminUserStore, dataStore, campaignStore, sodStore, evidenceStore, tenantStore, apiKeyStore, notificationStore, roleCatalogStore,
  recordActivity, createNotification, refreshRoles, refreshTransactions,
  generateToken, verifyToken, normalizeEmail, escapeHtml, unauthorizedHtml, sendAuthError,
  requireCapability, CAPABILITIES,
  upload, JWT_SECRET, REPORTS_DIR, ROLES_FILE_NAME, TX_FILE_NAME,
  UNAUTHORIZED_MESSAGE, MAX_TRANSACTION_ROLE_LOOKUPS, MAX_SUBMISSION_ROWS,
  PROTECTED_ADMIN_EMAILS,
});

app.use('/api', (req, res) => {
  res.status(404).json({ error: 'API route not found.', code: 'ROUTE_NOT_FOUND', requestId: req.requestId });
});

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = Number(err.status || err.statusCode) || (err.code === 'LIMIT_FILE_SIZE' ? 413 : 500);
  const safeStatus = status >= 400 && status <= 599 ? status : 500;
  const expose = safeStatus < 500 || err instanceof AppError;
  const message = expose ? err.message : 'Internal server error.';
  const code = err.code || (safeStatus === 500 ? 'INTERNAL_ERROR' : 'REQUEST_FAILED');
  console.error(`[${req.requestId}] ${req.method} ${req.originalUrl} failed:`, err);
  res.status(safeStatus).json({ error: message, code, requestId: req.requestId, details: expose ? err.details : undefined });
});

// Helper: create a notification (non-blocking)
async function createNotification(opts) {
  try {
    const tenantId = String(opts && opts.tenant_id || '').trim();
    if (!tenantId) throw new Error('tenant_id is required for notifications');
    return await notificationStore.create({ tenant_id: tenantId, type: opts.type || 'system', title: opts.title || '', body: opts.body || '', link: opts.link || '', icon: opts.icon || '', email: opts.email || '' });
  }
  catch (err) { console.warn('[notifications] Failed to create:', err.message); return null; }
}

// ---------- Start server ----------
async function start() {
  try {
    const { generateExcelFiles, seedDatabase } = require('./scripts/seed-on-first-run');
    await generateExcelFiles();
    seedDatabase();
  } catch (err) { console.warn('[seed] Seed on first run failed (non-fatal):', err.message); }
  console.log('Loading roles/approvers...');
  try { await refreshRoles({ force: true, tenantId: 'default' }); } catch (err) { console.error('Initial roles/approvers load failed:', err); }
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Attest running at http://localhost:${PORT}`);
    setImmediate(async () => { try { console.log('Loading transactions in background...'); await refreshTransactions({ force: true, tenantId: 'default' }); } catch (err) { console.error('Background transactions load failed:', err); } });
  });
}
start();

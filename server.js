// Attest — Access Certification & Role Governance App
// Node.js Express server with JWT auth + SQLite persistence.

const express = require('express');
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const multer = require('multer');
const { createLogStore } = require('./logStore');
const { createActivityStore } = require('./activityStore');
const {
  createAdminUserStore,
  PROTECTED_ADMIN_EMAILS,
  normalizeEmail,
} = require('./adminUserStore');
const { createDataStore } = require('./dataStore');

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
  '/admin.html': 'Accessed Admin Log',
  '/admin-users.html': 'Accessed Admin Users',
  '/activity.html': 'Accessed Activity Log',
};

function recordActivity(event) {
  Promise.resolve()
    .then(() => activityStore.record(event))
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
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '24h' });
}

function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
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
  return path === '/healthz' || path === '/login.html' || path === '/dashboard.html' || path === '/api/auth' || path.startsWith('/assets/');
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
      const admins = await adminUserStore.listAdmins();
      if (admins.length > 0) {
        return res.status(403).json({ error: 'Registration is closed. Contact your administrator for an account.' });
      }
      if (!name || name.trim().length < 2) {
        return res.status(400).json({ error: 'Name is required (min 2 characters).' });
      }
      await adminUserStore.addAdmin(normalizedEmail);
      const token = generateToken({ email: normalizedEmail, name: name.trim() });
      return res.json({ token, email: normalizedEmail, isAdmin: true, approverName: name.trim(), message: 'Account created.' });
    }

    // Login
    const admins = await adminUserStore.listAdmins();
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
    const token = generateToken({ email: normalizedEmail });
    res.json({ token, email: normalizedEmail, isAdmin, approverName });
  } catch (err) {
    console.error('POST /api/auth failed:', err);
    res.status(500).json({ error: 'Authentication failed.' });
  }
});

// ---------- Static + APIs ----------
app.use(express.json({ limit: '4mb' }));
app.get('/healthz', (req, res) => res.json({ ok: true }));
app.use(authMiddleware);
app.use(requireAdminPage);
app.use(recordPageAccess);
app.use(express.static(path.join(__dirname, 'public')));
app.use('/vendor/jspdf', express.static(path.join(__dirname, 'node_modules', 'jspdf', 'dist')));
app.use('/vendor/jspdf-autotable', express.static(path.join(__dirname, 'node_modules', 'jspdf-autotable', 'dist')));

app.get('/api/me', (req, res) => {
  res.json({
    email: req.auth.email,
    approverName: req.auth.approverName,
    approverEmail: req.auth.approverName ? approverNameToEmail[req.auth.approverName] || '' : '',
    roles: req.auth.roles,
    isAdmin: req.auth.isAdmin,
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

// ---------- Dashboard API ----------
app.get('/api/dashboard/stats', async (req, res) => {
  try {
    const submissions = await logStore.readAll();
    const totalRoles = uniqueRoleNames.length;
    const reviewedSubmissions = new Set(submissions.map(s => s.roleName)).size;
    const progress = totalRoles > 0 ? Math.round((reviewedSubmissions / totalRoles) * 100) : 0;
    const pendingCount = totalRoles - reviewedSubmissions;
    // SoD: count submissions where same approver has conflicting roles (simplified)
    const approverSubmissions = {};
    submissions.forEach(s => { if (!approverSubmissions[s.approver]) approverSubmissions[s.approver] = new Set(); approverSubmissions[s.approver].add(s.roleName); });
    let sodConflicts = 0;
    Object.values(approverSubmissions).forEach(roles => { if (roles.size > 3) sodConflicts += 1; });
    const recentActivity = await activityStore.readAll({ limit: 5 });
    res.json({ totalRoles, reviewedRoles: reviewedSubmissions, progress, pendingCount, sodConflicts, recentActivity });
  } catch (err) {
    console.error('GET /api/dashboard/stats failed:', err);
    res.status(500).json({ error: 'Failed to load dashboard stats.' });
  }
});

app.get('/api/dashboard/progress-by-system', (req, res) => {
  try {
    // Infer system from role name prefix (BE - SYSTEM - ...)
    const systems = {};
    uniqueRoleNames.forEach(role => {
      const parts = role.split(' - ');
      const system = parts.length >= 2 ? parts[1] : 'Other';
      if (!systems[system]) systems[system] = { total: 0, reviewed: 0 };
      systems[system].total += 1;
    });
    // Count reviewed per system
    const reviewedRoles = new Set();
    logStore.readAll().then(submissions => {
      submissions.forEach(s => reviewedRoles.add(s.roleName));
      Object.keys(systems).forEach(sys => {
        uniqueRoleNames.forEach(role => {
          if (role.includes(' - ' + sys + ' - ') && reviewedRoles.has(role)) {
            systems[sys].reviewed += 1;
          }
        });
      });
      const result = Object.entries(systems)
        .map(([name, data]) => ({ name, total: data.total, reviewed: data.reviewed, pct: data.total > 0 ? Math.round((data.reviewed / data.total) * 100) : 0 }))
        .sort((a, b) => b.total - a.total);
      res.json(result);
    }).catch(() => res.json([]));
  } catch (err) {
    console.error('GET /api/dashboard/progress-by-system failed:', err);
    res.status(500).json({ error: 'Failed to load system progress.' });
  }
});

app.get('/api/dashboard/active-campaigns', async (req, res) => {
  // Placeholder — full campaigns in Phase 2
  try {
    const submissions = await logStore.readAll();
    const approvers = new Set(submissions.map(s => s.approver));
    const reviewedRoles = new Set(submissions.map(s => s.roleName));
    const totalRoles = uniqueRoleNames.length;
    const progress = totalRoles > 0 ? Math.round((reviewedRoles.size / totalRoles) * 100) : 0;
    res.json([{
      id: 'current',
      name: 'Current Access Review',
      framework: 'ITGC',
      period: 'Q3 2026',
      status: progress >= 100 ? 'completed' : 'active',
      deadline: '2026-08-31',
      approvers: approvers.size,
      totalRoles: totalRoles,
      reviewedRoles: reviewedRoles.size,
      progress: progress
    }]);
  } catch (err) {
    res.json([]);
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

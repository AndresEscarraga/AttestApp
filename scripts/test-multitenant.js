// Integration tests for tenant membership, isolation and seed A/B wiring.

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const root = path.join(__dirname, '..');
const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'attest-multitenant-'));
const port = 33000 + Math.floor(Math.random() * 1000);
const baseUrl = `http://127.0.0.1:${port}`;
let stdout = '';
let stderr = '';

const child = spawn(process.execPath, ['server.js'], {
  cwd: root,
  env: {
    ...process.env,
    NODE_ENV: 'production',
    JWT_SECRET: 'multitenant-integration-secret-at-least-32-chars',
    PORT: String(port),
    DB_PATH: path.join(runDir, 'attest.db'),
    REPORTS_DIR: path.join(runDir, 'reports'),
    EVIDENCE_DIR: path.join(runDir, 'evidence'),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
child.stdout.on('data', chunk => { stdout += chunk.toString(); });
child.stderr.on('data', chunk => { stderr += chunk.toString(); });

async function waitForServer() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/healthz`);
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Server did not become ready.\n${stdout}\n${stderr}`);
}

async function request(pathname, { token, apiKey, method = 'GET', body, headers = {} } = {}) {
  const requestHeaders = new Headers(headers);
  if (token) requestHeaders.set('Authorization', `Bearer ${token}`);
  if (apiKey) requestHeaders.set('X-API-Key', apiKey);
  if (body !== undefined) requestHeaders.set('Content-Type', 'application/json');
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: requestHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: response.status, data };
}

async function login(email, tenantId) {
  const payload = { action: 'login', email, password: 'password123' };
  if (tenantId) payload.tenant_id = tenantId;
  const result = await request('/api/auth', { method: 'POST', body: payload });
  assert.equal(result.status, 200, `Login failed for ${email}: ${JSON.stringify(result.data)}`);
  return result.data;
}

async function switchTenant(token, tenantId) {
  return request('/api/auth/switch-tenant', {
    token,
    method: 'POST',
    body: { tenant_id: tenantId },
  });
}

async function run() {
  await waitForServer();

  const admin = await login('admin.one@attest.local');
  assert.equal(admin.tenantId, 'default');
  assert.equal(admin.role, 'admin');
  assert.deepEqual(new Set(admin.tenants.map(tenant => tenant.id)), new Set(['default', 'tenant-beta']));

  const ignoredHeader = await request('/api/me', {
    token: admin.token,
    headers: { 'X-Tenant-ID': 'tenant-beta' },
  });
  assert.equal(ignoredHeader.status, 200);
  assert.equal(ignoredHeader.data.tenantId, 'default', 'Client header must not override authenticated tenant');

  const defaultCampaigns = await request('/api/campaigns', { token: admin.token });
  assert.equal(defaultCampaigns.status, 200);
  assert(defaultCampaigns.data.length >= 4);
  assert(defaultCampaigns.data.every(campaign => campaign.tenant_id === 'default'));

  const switched = await switchTenant(admin.token, 'tenant-beta');
  assert.equal(switched.status, 200);
  const betaToken = switched.data.token;
  const betaMe = await request('/api/me', { token: betaToken });
  assert.equal(betaMe.data.tenantId, 'tenant-beta');
  assert.equal(betaMe.data.role, 'admin');

  const betaCampaigns = await request('/api/campaigns', { token: betaToken });
  assert.equal(betaCampaigns.status, 200);
  assert.equal(betaCampaigns.data.length, 2);
  assert(betaCampaigns.data.every(campaign => campaign.tenant_id === 'tenant-beta'));
  assert(betaCampaigns.data.every(campaign => campaign.name.startsWith('BETA')));

  const betaRoles = await request('/api/roles', { token: betaToken });
  assert.equal(betaRoles.status, 200);
  assert.equal(betaRoles.data.length, 4);
  assert(betaRoles.data.every(role => role.startsWith('BETA')));

  const crossTenantCampaign = await request('/api/campaigns/camp_sox_q3', { token: betaToken });
  assert.equal(crossTenantCampaign.status, 404);

  const created = await request('/api/campaigns', {
    token: betaToken,
    method: 'POST',
    body: { name: 'BETA — API Isolation Test', period: 'Q4 2026', framework: 'SOX' },
  });
  assert.equal(created.status, 201);
  assert.equal(created.data.tenant_id, 'tenant-beta');

  const defaultAfterCreate = await request('/api/campaigns', { token: admin.token });
  assert(!defaultAfterCreate.data.some(campaign => campaign.id === created.data.id));

  const adminTwo = await login('admin.two@attest.local');
  assert.equal(adminTwo.role, 'admin');
  const adminTwoBeta = await switchTenant(adminTwo.token, 'tenant-beta');
  assert.equal(adminTwoBeta.status, 200);
  const adminTwoBetaMe = await request('/api/me', { token: adminTwoBeta.data.token });
  assert.equal(adminTwoBetaMe.data.role, 'auditor');
  assert.equal(adminTwoBetaMe.data.isAdmin, false);
  const forbiddenAdmin = await request('/api/admin-users', { token: adminTwoBeta.data.token });
  assert.equal(forbiddenAdmin.status, 403);

  const approver = await login('approver.one@attest.local', 'tenant-beta');
  assert.equal(approver.approverName, 'Avery Chen');
  const approverRoles = await request('/api/roles', { token: approver.token });
  assert.deepEqual(approverRoles.data, [
    'BETA - FINANCE - BILLING',
    'BETA - FINANCE - CASH APPLICATION',
  ]);
  const invalidDecision = await request('/api/log', {
    token: approver.token,
    method: 'POST',
    body: {
      approver: 'Avery Chen',
      rows: [{
        roleName: 'BETA - FINANCE - CASH APPLICATION',
        action: 'UNRECOGNIZED_ACTION',
        txAcknowledged: true,
      }],
    },
  });
  assert.equal(invalidDecision.status, 422);
  const validDecision = await request('/api/log', {
    token: approver.token,
    method: 'POST',
    body: {
      approver: 'Avery Chen',
      campaignId: 'beta_access_q4',
      rows: [{
        roleName: 'BETA - FINANCE - CASH APPLICATION',
        action: 'Keep Business Role',
        txAcknowledged: true,
      }],
    },
  });
  assert.equal(validDecision.status, 200);
  assert.equal(validDecision.data.recorded, 1);

  const defaultOnly = await login('superadmin.one@attest.local');
  const invalidSwitch = await switchTenant(defaultOnly.token, 'tenant-beta');
  assert.equal(invalidSwitch.status, 403);

  const betaSod = await request('/api/sod/conflicts', { token: betaToken });
  assert.equal(betaSod.status, 200);
  assert(betaSod.data.length >= 1);
  assert(betaSod.data.every(conflict => conflict.tenant_id === 'tenant-beta'));

  const betaEvidence = await request('/api/evidence', { token: betaToken });
  assert.equal(betaEvidence.status, 200);
  assert(betaEvidence.data.every(pkg => pkg.tenant_id === 'tenant-beta'));

  const settingsPatch = await request('/api/settings', {
    token: betaToken,
    method: 'PATCH',
    body: { key: 'tenant_label', value: 'Beta only' },
  });
  assert.equal(settingsPatch.status, 200);
  assert.equal(settingsPatch.data.settings.tenant_label, 'Beta only');
  const defaultSettings = await request('/api/settings', { token: admin.token });
  assert.notEqual(defaultSettings.data.tenant_label, 'Beta only');

  const keyCreated = await request('/api/api-keys', {
    token: betaToken,
    method: 'POST',
    body: { name: 'Beta integration test', permissions: 'read-only' },
  });
  assert.equal(keyCreated.status, 201);
  const keyDashboard = await request('/api/dashboard/stats', { apiKey: keyCreated.data.key });
  assert.equal(keyDashboard.status, 200, `API key failed: ${JSON.stringify(keyDashboard.data)}`);

  console.log('Multi-tenant integration tests passed.');
}

async function stopChild() {
  if (child.exitCode !== null) return;
  await new Promise(resolve => {
    const timer = setTimeout(resolve, 2000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.kill();
  });
}

run().catch(error => {
  console.error(error.stack || error);
  if (stdout) console.error('\nServer stdout:\n' + stdout);
  if (stderr) console.error('\nServer stderr:\n' + stderr);
  process.exitCode = 1;
}).finally(async () => {
  await stopChild();
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try { fs.rmSync(runDir, { recursive: true, force: true }); break; }
    catch { await new Promise(resolve => setTimeout(resolve, 50)); }
  }
});

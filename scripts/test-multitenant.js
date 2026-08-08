// Integration tests for tenant membership, isolation and seed A/B wiring.

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { writeWorkbook } = require('../services/excelWorkbook');

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
  for (let attempt = 0; attempt < 250; attempt += 1) {
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
  return { status: response.status, data, headers: response.headers };
}

async function expectStatus(status, pathname, options) {
  const result = await request(pathname, options);
  assert.equal(result.status, status, `${options && options.method || 'GET'} ${pathname}: ${JSON.stringify(result.data)}`);
  return result;
}

async function assertDeniedMatrix(token, cases) {
  for (const testCase of cases) {
    const [method, pathname, body] = testCase;
    await expectStatus(403, pathname, { token, method, body });
  }
}

async function login(email, tenantId) {
  const payload = { action: 'login', email, password: 'password123' };
  if (tenantId) payload.tenant_id = tenantId;
  const result = await request('/api/auth', { method: 'POST', body: payload });
  assert.equal(result.status, 200, `Login failed for ${email}: ${JSON.stringify(result.data)}`);
  return result.data;
}

async function uploadWorkbook(pathname, token, filePath) {
  const form = new FormData();
  form.set('file', new Blob([fs.readFileSync(filePath)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), path.basename(filePath));
  const response = await fetch(`${baseUrl}${pathname}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: response.status, data, headers: response.headers };
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
  assert(ignoredHeader.headers.get('x-request-id'));
  assert.equal(ignoredHeader.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(ignoredHeader.headers.get('x-frame-options'), 'DENY');
  assert.equal(ignoredHeader.headers.get('cache-control'), 'no-store');
  assert(admin.capabilities.includes('tenant:manage'));

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

  const syntheticMemberEmail = 'tenant.beta.member@synthetic.test';
  await expectStatus(200, '/api/admin-users', { token: betaToken, method: 'POST', body: { email: syntheticMemberEmail, role: 'auditor' } });
  const betaMembers = await expectStatus(200, '/api/admin-users', { token: betaToken });
  assert(betaMembers.data.members.some(member => member.email === syntheticMemberEmail && member.role === 'auditor'));
  const defaultMembers = await expectStatus(200, '/api/admin-users', { token: admin.token });
  assert(!defaultMembers.data.members.some(member => member.email === syntheticMemberEmail));
  await expectStatus(404, `/api/admin-users/${encodeURIComponent(syntheticMemberEmail)}`, { token: admin.token, method: 'PATCH', body: { role: 'approver' } });
  await expectStatus(404, `/api/admin-users/${encodeURIComponent(syntheticMemberEmail)}`, { token: admin.token, method: 'DELETE' });
  const changedMember = await expectStatus(200, `/api/admin-users/${encodeURIComponent(syntheticMemberEmail)}`, { token: betaToken, method: 'PATCH', body: { role: 'approver' } });
  assert.equal(changedMember.data.membership.role, 'approver');
  await expectStatus(200, `/api/admin-users/${encodeURIComponent(syntheticMemberEmail)}`, { token: betaToken, method: 'DELETE' });
  await expectStatus(200, '/api/admin-users/admin.beta%40attest.local', { token: betaToken, method: 'PATCH', body: { role: 'auditor' } });
  await expectStatus(422, '/api/admin-users/admin.one%40attest.local', { token: betaToken, method: 'PATCH', body: { role: 'auditor' } });
  await expectStatus(200, '/api/admin-users/admin.beta%40attest.local', { token: betaToken, method: 'PATCH', body: { role: 'admin' } });

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

  await expectStatus(404, `/api/campaigns/${created.data.id}`, { token: admin.token });
  await expectStatus(404, `/api/campaigns/${created.data.id}`, { token: admin.token, method: 'PATCH', body: { name: 'Cross-tenant mutation' } });
  await expectStatus(404, `/api/campaigns/${created.data.id}`, { token: admin.token, method: 'DELETE' });

  const defaultAfterCreate = await request('/api/campaigns', { token: admin.token });
  assert(!defaultAfterCreate.data.some(campaign => campaign.id === created.data.id));
  assert((await request(`/api/campaigns/${created.data.id}`, { token: betaToken })).data.name.includes('API Isolation Test'));
  await expectStatus(200, `/api/campaigns/${created.data.id}`, { token: betaToken, method: 'DELETE' });

  const adminTwo = await login('admin.two@attest.local');
  assert.equal(adminTwo.role, 'admin');
  const adminTwoBeta = await switchTenant(adminTwo.token, 'tenant-beta');
  assert.equal(adminTwoBeta.status, 200);
  const adminTwoBetaMe = await request('/api/me', { token: adminTwoBeta.data.token });
  assert.equal(adminTwoBetaMe.data.role, 'auditor');
  assert.equal(adminTwoBetaMe.data.isAdmin, false);
  const forbiddenAdmin = await request('/api/admin-users', { token: adminTwoBeta.data.token });
  assert.equal(forbiddenAdmin.status, 403);
  assert(adminTwoBetaMe.data.capabilities.includes('audit:read'));
  assert(!adminTwoBetaMe.data.capabilities.includes('audit:update'));
  await expectStatus(200, '/api/log?limit=1', { token: adminTwoBeta.data.token });
  await expectStatus(403, '/api/log/example/ritm', { token: adminTwoBeta.data.token, method: 'PATCH', body: { ritm: 'RITM1' } });
  await expectStatus(403, '/api/log', { token: adminTwoBeta.data.token, method: 'POST', body: { approver: 'Avery Chen', rows: [] } });
  await expectStatus(403, '/api/campaigns', { token: adminTwoBeta.data.token, method: 'POST', body: { name: 'Denied', period: 'Q4 2026' } });

  const approver = await login('approver.one@attest.local', 'tenant-beta');
  assert.equal(approver.approverName, 'Avery Chen');
  assert(approver.capabilities.includes('review:submit'));
  assert(!approver.capabilities.includes('campaign:manage'));
  const managementEndpoints = [
    ['POST', '/api/campaigns', { name: 'Denied', period: 'Q4 2026' }],
    ['PATCH', '/api/campaigns/missing', { name: 'Denied' }],
    ['DELETE', '/api/campaigns/missing'],
    ['POST', '/api/sod/rules', { name: 'Denied' }],
    ['DELETE', '/api/sod/rules/missing'],
    ['PATCH', '/api/sod/conflicts/missing', { status: 'false_positive' }],
    ['POST', '/api/sod/detect'],
    ['POST', '/api/evidence/generate', { name: 'Denied' }],
    ['POST', '/api/evidence/missing/share'],
    ['DELETE', '/api/evidence/missing'],
    ['GET', '/api/admin-users'],
    ['POST', '/api/admin-users', { email: 'denied@synthetic.test', role: 'auditor' }],
    ['PATCH', '/api/admin-users/denied%40synthetic.test', { role: 'admin' }],
    ['DELETE', '/api/admin-users/denied%40synthetic.test'],
    ['POST', '/api/admin/reload-data'],
    ['POST', '/api/admin/upload-roles'],
    ['POST', '/api/admin/upload-transactions'],
    ['GET', '/api/admin/data-status'],
    ['GET', '/api/api-keys'],
    ['POST', '/api/api-keys', { name: 'Denied' }],
    ['DELETE', '/api/api-keys/missing'],
    ['PATCH', '/api/settings', { key: 'denied', value: true }],
    ['POST', '/api/tenants', { name: 'Denied' }],
    ['PATCH', '/api/tenants/missing', { name: 'Denied' }],
    ['DELETE', '/api/tenants/missing'],
    ['GET', '/api/activity'],
    ['PATCH', '/api/log/missing/ritm', { ritm: 'Denied' }],
    ['PATCH', '/api/log/missing/ritm-status', { ritmStatus: 'Resolved' }],
  ];
  await assertDeniedMatrix(approver.token, managementEndpoints.concat([['GET', '/api/log']]));
  await assertDeniedMatrix(adminTwoBeta.data.token, managementEndpoints.concat([['POST', '/api/log', { approver: 'Avery Chen', rows: [] }]]));
  const betaApprovers = await expectStatus(200, '/api/approvers', { token: betaToken });
  assert.equal(new Set(betaApprovers.data).size, betaApprovers.data.length, 'Approvers must be unique');
  await expectStatus(403, '/api/campaigns', { token: approver.token, method: 'POST', body: { name: 'Denied', period: 'Q4 2026' } });
  await expectStatus(403, '/api/admin-users', { token: approver.token });
  await expectStatus(403, '/api/settings', { token: approver.token, method: 'PATCH', body: { key: 'denied', value: true } });
  await expectStatus(403, '/api/sod/detect', { token: approver.token, method: 'POST' });
  await expectStatus(403, '/api/evidence/generate', { token: approver.token, method: 'POST', body: { name: 'Denied' } });
  await expectStatus(403, '/api/log', { token: approver.token });
  await expectStatus(403, '/api/api-keys', { token: approver.token });
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

  const betaLog = await expectStatus(200, '/api/log?limit=100', { token: betaToken });
  const submittedEntry = betaLog.data.find(entry => entry.submissionId === validDecision.data.submissionId);
  assert(submittedEntry && submittedEntry.logEntryId);
  await expectStatus(404, `/api/log/${submittedEntry.logEntryId}/ritm`, { token: admin.token, method: 'PATCH', body: { ritm: 'CROSS-TENANT' } });

  const defaultOnly = await login('superadmin.one@attest.local');
  const invalidSwitch = await switchTenant(defaultOnly.token, 'tenant-beta');
  assert.equal(invalidSwitch.status, 403);

  const betaSod = await request('/api/sod/conflicts', { token: betaToken });
  assert.equal(betaSod.status, 200);
  assert(betaSod.data.length >= 1);
  assert(betaSod.data.every(conflict => conflict.tenant_id === 'tenant-beta'));
  const effectiveConflict = betaSod.data[0];
  assert(effectiveConflict.subject_id && effectiveConflict.user_email && effectiveConflict.subject_name);
  assert(effectiveConflict.assignment_a_id && effectiveConflict.assignment_b_id && effectiveConflict.source_snapshot_id);
  assert.notEqual(effectiveConflict.subject_name, effectiveConflict.approver_name, 'SoD subject must not be the review owner');
  const effectiveAssignments = await expectStatus(200, `/api/sod/access-assignments?subject_id=${encodeURIComponent(effectiveConflict.subject_id)}`, { token: betaToken });
  assert(effectiveAssignments.data.length >= 2);
  assert(effectiveAssignments.data.every(assignment => assignment.subject_id === effectiveConflict.subject_id));
  const idempotentDetection = await expectStatus(200, '/api/sod/detect', { token: betaToken, method: 'POST' });
  assert(idempotentDetection.data.evaluated >= 1);
  assert.equal(idempotentDetection.data.detected, 0, 'Repeated SoD detection must not duplicate an existing conflict');
  await expectStatus(422, `/api/sod/conflicts/${effectiveConflict.id}`, { token: betaToken, method: 'PATCH', body: { status: 'accepted' } });
  await expectStatus(422, `/api/sod/conflicts/${effectiveConflict.id}`, { token: betaToken, method: 'PATCH', body: { status: 'mitigated', resolution_reason: 'Incomplete' } });
  const expiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const accepted = await expectStatus(200, `/api/sod/conflicts/${effectiveConflict.id}`, {
    token: betaToken,
    method: 'PATCH',
    body: { status: 'risk_accepted', resolution_reason: 'Synthetic exception approved for test flow', resolution_owner: 'Beta Risk Owner', resolution_expires_at: expiry, resolution_evidence: 'synthetic://risk/approval-001' },
  });
  assert.equal(accepted.data.status, 'risk_accepted');
  assert.equal(accepted.data.approved_by, 'admin.one@attest.local');
  await expectStatus(404, `/api/sod/conflicts/${effectiveConflict.id}`, { token: admin.token, method: 'PATCH', body: { status: 'open', resolution_reason: 'Cross tenant', resolution_owner: 'Nobody' } });
  const history = await expectStatus(200, `/api/sod/conflicts/${effectiveConflict.id}/history`, { token: betaToken });
  assert.equal(history.data[0].to_status, 'risk_accepted');
  const stillIdempotent = await expectStatus(200, '/api/sod/detect', { token: betaToken, method: 'POST' });
  assert.equal(stillIdempotent.data.detected, 0);
  await expectStatus(200, `/api/sod/conflicts/${effectiveConflict.id}`, { token: betaToken, method: 'PATCH', body: { status: 'open', resolution_reason: 'Synthetic acceptance revoked', resolution_owner: 'Beta Risk Owner' } });
  await expectStatus(200, `/api/sod/rules/${effectiveConflict.rule_id}`, { token: betaToken, method: 'DELETE' });
  const conflictsAfterRuleArchive = await expectStatus(200, '/api/sod/conflicts', { token: betaToken });
  assert(conflictsAfterRuleArchive.data.some(conflict => conflict.id === effectiveConflict.id), 'Archiving a rule must preserve its findings');

  const betaRule = await expectStatus(201, '/api/sod/rules', {
    token: betaToken,
    method: 'POST',
    body: { name: 'BETA temporary isolation rule', role_a: 'BETA - FINANCE - BILLING', role_b: 'BETA - IT - CLOUD OPERATIONS', severity: 'high', framework: 'SOX' },
  });
  await expectStatus(404, `/api/sod/rules/${betaRule.data.id}`, { token: admin.token, method: 'DELETE' });
  await expectStatus(200, `/api/sod/rules/${betaRule.data.id}`, { token: betaToken, method: 'DELETE' });

  const betaEvidence = await request('/api/evidence', { token: betaToken });
  assert.equal(betaEvidence.status, 200);
  assert(betaEvidence.data.every(pkg => pkg.tenant_id === 'tenant-beta'));

  const generatedEvidence = await expectStatus(201, '/api/evidence/generate', { token: betaToken, method: 'POST', body: { name: 'BETA generated isolation evidence' } });
  await expectStatus(404, `/api/evidence/${generatedEvidence.data.id}/download`, { token: admin.token });
  await expectStatus(404, `/api/evidence/${generatedEvidence.data.id}`, { token: admin.token, method: 'DELETE' });
  await expectStatus(200, `/api/evidence/${generatedEvidence.data.id}/download`, { token: betaToken });
  await expectStatus(200, `/api/evidence/${generatedEvidence.data.id}`, { token: betaToken, method: 'DELETE' });

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
  await expectStatus(404, `/api/api-keys/${keyCreated.data.id}`, { token: admin.token, method: 'DELETE' });
  await expectStatus(200, `/api/api-keys/${keyCreated.data.id}`, { token: betaToken, method: 'DELETE' });

  const betaNotifications = await expectStatus(200, '/api/notifications?limit=20', { token: betaToken });
  const betaNotification = betaNotifications.data.notifications[0];
  assert(betaNotification && betaNotification.id);
  await expectStatus(404, `/api/notifications/${betaNotification.id}/read`, { token: admin.token, method: 'PATCH' });

  const defaultDataStatus = await expectStatus(200, '/api/admin/data-status', { token: admin.token });
  const betaDataStatus = await expectStatus(200, '/api/admin/data-status', { token: betaToken });
  assert.equal(defaultDataStatus.data.roles.total, 15);
  assert.equal(betaDataStatus.data.roles.total, 4);
  const betaRolesWorkbook = path.join(runDir, 'beta-upload-roles.xlsx');
  const betaTransactionsWorkbook = path.join(runDir, 'beta-upload-transactions.xlsx');
  await writeWorkbook(betaRolesWorkbook, [
    { name: 'Complete', rows: [
      ['Role Name', 'Description', 'System', 'Approver Full Name'],
      ['BETA-UPLOAD - FINANCE - ANALYST', 'Synthetic uploaded role', 'Oracle', 'Avery Chen'],
      ['BETA-UPLOAD - IT - OPERATOR', 'Synthetic uploaded role', 'Azure', 'Jordan Lee'],
    ] },
    { name: 'Emails', rows: [['Full Name', 'Email'], ['Avery Chen', 'approver.one@attest.local'], ['Jordan Lee', 'approver.two@attest.local']] },
  ]);
  await writeWorkbook(betaTransactionsWorkbook, [{ name: 'Transactions', rows: [
    ['Role Name', 'Associated Role', 'Associated Role Description', 'Permission Name'],
    ['BETA-UPLOAD - FINANCE - ANALYST', 'BETA_TECH_1', 'Synthetic technical role', 'BETA_PERMISSION_1'],
    ['BETA-UPLOAD - IT - OPERATOR', 'BETA_TECH_2', 'Synthetic technical role', 'BETA_PERMISSION_2'],
  ] }]);
  const uploadedRoles = await uploadWorkbook('/api/admin/upload-roles', betaToken, betaRolesWorkbook);
  assert.equal(uploadedRoles.status, 200, JSON.stringify(uploadedRoles.data));
  const uploadedTransactions = await uploadWorkbook('/api/admin/upload-transactions', betaToken, betaTransactionsWorkbook);
  assert.equal(uploadedTransactions.status, 200, JSON.stringify(uploadedTransactions.data));
  const betaAfterUpload = await expectStatus(200, '/api/admin/data-status', { token: betaToken });
  const defaultAfterBetaUpload = await expectStatus(200, '/api/admin/data-status', { token: admin.token });
  assert.equal(betaAfterUpload.data.roles.total, 2);
  assert.equal(betaAfterUpload.data.transactions.totalRows, 2);
  assert.equal(defaultAfterBetaUpload.data.roles.total, 15);
  assert.equal(defaultAfterBetaUpload.data.transactions.totalRows, 24);
  const betaActivity = await expectStatus(200, '/api/activity?limit=200', { token: betaToken });
  const defaultActivity = await expectStatus(200, '/api/activity?limit=200', { token: admin.token });
  assert(betaActivity.data.some(event => String(event.detail || '').includes(syntheticMemberEmail)));
  assert(!defaultActivity.data.some(event => String(event.detail || '').includes(syntheticMemberEmail)));
  await expectStatus(404, '/api/tenants/tenant-beta', { token: admin.token, method: 'PATCH', body: { name: 'Cross tenant rename' } });

  let rateLimited = null;
  for (let attempt = 0; attempt < 25 && !rateLimited; attempt += 1) {
    const result = await request('/api/auth', { method: 'POST', body: { action: 'login', email: 'nobody@attest.local', password: 'invalid' } });
    if (result.status === 429) rateLimited = result;
  }
  assert(rateLimited, 'Auth endpoint must enforce rate limiting');
  assert(Number(rateLimited.headers.get('retry-after')) > 0);

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

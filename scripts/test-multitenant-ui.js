// Browser regression for shared tenant switching across authenticated pages.

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright');

const root = path.join(__dirname, '..');
const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'attest-multitenant-ui-'));
const port = 34000 + Math.floor(Math.random() * 1000);
const baseUrl = `http://127.0.0.1:${port}`;
let stdout = '';
let stderr = '';
let browser;

const child = spawn(process.execPath, ['server.js'], {
  cwd: root,
  env: {
    ...process.env,
    NODE_ENV: 'production',
    JWT_SECRET: 'multitenant-ui-secret-at-least-32-characters',
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
      if ((await fetch(`${baseUrl}/healthz`)).ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Server did not become ready.');
}

async function login() {
  const response = await fetch(`${baseUrl}/api/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'login',
      email: 'admin.one@attest.local',
      password: 'password123',
    }),
  });
  assert.equal(response.status, 200);
  return response.json();
}

async function waitForTenant(page, tenantId) {
  await page.waitForFunction(expected => {
    const selector = document.getElementById('tenantSelector');
    return selector && selector.options.length >= 2 && selector.value === expected;
  }, tenantId, { timeout: 10000 });
}

async function run() {
  await waitForServer();
  const session = await login();
  browser = await chromium.launch();
  const context = await browser.newContext();
  await context.addInitScript(token => {
    if (!localStorage.getItem('attest_token')) localStorage.setItem('attest_token', token);
  }, session.token);
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(`${page.url()}: ${error.message}`));

  await page.goto(`${baseUrl}/campaigns.html`, { waitUntil: 'domcontentloaded' });
  await waitForTenant(page, 'default');
  await page.waitForFunction(() => {
    const body = document.getElementById('campaignsBody');
    return body && body.textContent.includes('Q3 SOX ITGC');
  });

  await page.evaluate(() => localStorage.removeItem('attest_e2e_stale_render'));
  await page.route('**/api/campaigns?e2e_delay=1', async route => {
    await new Promise(resolve => setTimeout(resolve, 1200));
    try { await route.continue(); } catch (error) { if (!String(error.message || error).includes('closed')) console.warn(error.message || error); }
  });
  const delayedRequest = page.waitForRequest(request => request.url().includes('/api/campaigns?e2e_delay=1'));
  await page.evaluate(() => {
    window.Attest.api.json('/api/campaigns?e2e_delay=1')
      .then(() => localStorage.setItem('attest_e2e_stale_render', 'painted-A-after-switch'))
      .catch(error => {
        if (!['AbortError','StaleTenantResponseError'].includes(error.name)) {
          localStorage.setItem('attest_e2e_stale_render', `unexpected:${error.name}`);
        }
      });
  });
  await delayedRequest;

  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
    page.selectOption('#tenantSelector', 'tenant-beta'),
  ]);
  await waitForTenant(page, 'tenant-beta');
  await page.waitForTimeout(1400);
  assert.equal(await page.evaluate(() => localStorage.getItem('attest_e2e_stale_render')), null, 'A late Tenant A response must never render after switching to Tenant B');
  assert.equal(await page.evaluate(() => localStorage.getItem('attest_active_tenant')), 'tenant-beta');
  await page.unroute('**/api/campaigns?e2e_delay=1');
  await page.waitForFunction(() => {
    const body = document.getElementById('campaignsBody');
    return body && body.textContent.includes('BETA — Q4 Access Review');
  });
  const betaCampaignText = await page.textContent('#campaignsBody');
  assert(!betaCampaignText.includes('Q3 SOX ITGC'));

  const pages = [
    '/dashboard.html',
    '/reviews.html',
    '/campaigns.html',
    '/audit-trail.html',
    '/activity.html',
    '/sod.html',
    '/evidence.html',
    '/data-sources.html',
    '/admin-users.html',
    '/api-keys.html',
    '/settings.html',
    '/tenants.html',
    '/onboarding.html',
    '/offboarding.html',
  ];

  for (const pathname of pages) {
    const response = await page.goto(`${baseUrl}${pathname}`, { waitUntil: 'domcontentloaded' });
    assert(response && response.ok(), `${pathname} returned ${response && response.status()}`);
    await waitForTenant(page, 'tenant-beta');
    assert.equal(page.url(), `${baseUrl}${pathname}`);
  }

  await page.goto(`${baseUrl}/dashboard.html`, { waitUntil: 'domcontentloaded' });
  await waitForTenant(page, 'tenant-beta');
  await page.waitForFunction(() => {
    const dashboardLink = document.querySelector('.sidebar-item[href="/dashboard.html"]');
    const campaignsLink = document.querySelector('.sidebar-item[href="/campaigns.html"]');
    return dashboardLink && campaignsLink
      && getComputedStyle(dashboardLink).display !== 'none'
      && getComputedStyle(campaignsLink).display !== 'none';
  });
  assert.equal(
    await page.locator('.sidebar-nav .sidebar-item:visible').count() > 0,
    true,
    'The capability filter must not leave an authorized user with an empty sidebar navigation.',
  );
  await page.waitForFunction(() => document.body.textContent.includes('BETA — Q4 Access Review'));

  await page.goto(`${baseUrl}/audit-trail.html`, { waitUntil: 'domcontentloaded' });
  await waitForTenant(page, 'tenant-beta');
  await page.waitForFunction(() => document.body.textContent.includes('BETA - FINANCE - BILLING'));

  await page.goto(`${baseUrl}/sod.html`, { waitUntil: 'domcontentloaded' });
  await waitForTenant(page, 'tenant-beta');
  await page.waitForFunction(() => document.body.textContent.includes('BETA-SOD-001'));
  await page.waitForFunction(() => document.getElementById('conflictsBody').textContent.includes('Beta Finance User (Synthetic)'));
  const sodConflictText = await page.textContent('#conflictsBody');
  assert(sodConflictText.includes('synthetic.finance.user@beta.test'));
  await page.click('#conflictsBody .resolve-btn');
  await page.waitForSelector('#resolutionModal:not(.hidden)');
  await page.selectOption('#resolutionStatus', 'mitigated');
  await page.fill('#resolutionOwner', 'Beta Compensating Control Owner');
  await page.fill('#resolutionReason', 'Synthetic compensating review verified by E2E');
  await page.fill('#resolutionEvidence', 'synthetic://e2e/control-001');
  await page.fill('#resolutionExpiry', await page.evaluate(() => {
    const date = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 16);
  }));
  await page.click('#resolutionModalSave');
  await page.waitForFunction(() => document.getElementById('resolutionModal').classList.contains('hidden') && document.getElementById('conflictsBody').textContent.includes('Mitigated'));
  await page.click('#conflictsBody .resolve-btn');
  await page.selectOption('#resolutionStatus', 'open');
  await page.fill('#resolutionOwner', 'Beta Compensating Control Owner');
  await page.fill('#resolutionReason', 'Synthetic mitigation revoked by E2E');
  await page.click('#resolutionModalSave');
  await page.waitForFunction(() => document.getElementById('resolutionModal').classList.contains('hidden') && document.getElementById('conflictsBody').textContent.includes('Open'));

  await page.goto(`${baseUrl}/evidence.html`, { waitUntil: 'domcontentloaded' });
  await waitForTenant(page, 'tenant-beta');
  await page.waitForFunction(() => document.body.textContent.includes('BETA — Synthetic Q4 Evidence'));

  await page.goto(`${baseUrl}/data-sources.html`, { waitUntil: 'domcontentloaded' });
  await waitForTenant(page, 'tenant-beta');
  await page.waitForFunction(() => document.getElementById('rolesInfo').textContent.includes('4 roles'));

  await page.goto(`${baseUrl}/campaigns.html`, { waitUntil: 'domcontentloaded' });
  await waitForTenant(page, 'tenant-beta');
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
    page.selectOption('#tenantSelector', 'default'),
  ]);
  await waitForTenant(page, 'default');
  await page.waitForFunction(() => document.getElementById('campaignsBody').textContent.includes('Q3 SOX ITGC'));

  assert.deepEqual(pageErrors, [], `Browser errors:\n${pageErrors.join('\n')}`);
  console.log(`Multi-tenant UI tests passed across ${pages.length} pages.`);
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
  if (browser) await browser.close().catch(() => {});
  await stopChild();
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try { fs.rmSync(runDir, { recursive: true, force: true }); break; }
    catch { await new Promise(resolve => setTimeout(resolve, 50)); }
  }
});

// E2E test for Attest — dev mode with synthetic data.
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('PAGE ERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });

  // Dev mode: set header to simulate approver login
  await page.setExtraHTTPHeaders({ 'x-dev-auth-email': 'approver.one@attest.local' });
  await page.goto('http://localhost:3000', { waitUntil: 'networkidle' });

  // ------- 1. Content loads with approver context -------
  await page.waitForFunction(() => {
    const name = document.querySelector('#signedInName');
    return name && name.textContent.trim().length > 0;
  }, null, { timeout: 10000 });
  const signedIn = await page.textContent('#signedInName');
  console.log('Signed in as: ' + signedIn);
  if (!signedIn.includes('Morgan Taylor')) throw new Error('Expected Morgan Taylor in name, got: ' + signedIn);

  // ------- 2. Rows pre-populated with approver's roles -------
  await page.waitForFunction(() => {
    const c = document.querySelector('#reviewTableBody tr:nth-child(1) .approver-cell');
    return c && c.textContent.trim().length > 0;
  }, null, { timeout: 10000 });
  const filledRoleCount = await page.$$eval('#reviewTableBody tr', rs =>
    rs.filter(r => r.querySelector('.role-select').value).length);
  console.log('Pre-populated rows with role: ' + filledRoleCount);
  if (filledRoleCount < 2) throw new Error('Expected approver roles pre-populated, got ' + filledRoleCount);

  // ------- 3. No Permissions / Scope columns -------
  const headers = await page.$$eval('#reviewTable thead .header-row th', ths =>
    ths.map(t => t.textContent.replace(/\s+/g, ' ').trim()));
  console.log('Headers:', headers);
  for (const banned of ['Role Permissions', 'Is Role Privileged', 'In-Scope', 'Scope Justification']) {
    if (headers.some(h => h.includes(banned)))
      throw new Error('Banned header still present: ' + banned);
  }

  // ------- 4. Transactions popup header renamed -------
  await page.click('#reviewTableBody tr:nth-child(1) .btn-tx');
  await page.waitForFunction(() =>
    document.querySelectorAll('#txTable thead th').length > 0, null, { timeout: 30000 });
  const txHeaders = await page.$$eval('#txTable thead th', ths => ths.map(t => t.textContent));
  console.log('Tx headers:', txHeaders);
  if (!txHeaders.includes('Business Role')) throw new Error('Missing renamed Business Role');
  if (!txHeaders.includes('Technical Role')) throw new Error('Missing renamed Technical Role');
  if (!txHeaders.includes('Technical Role Description')) throw new Error('Missing renamed Technical Role Description');
  if (txHeaders.includes('Role Name') || txHeaders.includes('Associated Role'))
    throw new Error('Old header names still present');
  await page.check('#txAckCheckbox');
  await page.click('#txAckConfirm');
  await page.waitForFunction(() =>
    document.querySelector('#txModal').classList.contains('hidden'), null, { timeout: 5000 });

  // ------- 5. RITM no longer required when Action=Remove -------
  await page.selectOption('#reviewTableBody tr:nth-child(1) .action-select', 'Keep');
  await page.selectOption('#reviewTableBody tr:nth-child(2) .action-select', 'Remove');
  await page.selectOption('#reviewTableBody tr:nth-child(3) .action-select', 'Modify');
  // Sign out
  await page.click('#signOutBtn');

  // Print should NOT block on missing RITM (revert)
  const downloads = [];
  page.on('download', d => downloads.push(d));
  page.on('dialog', d => d.dismiss().catch(() => {}));
  await page.click('#printBtn');
  // Wait for two downloads (Keep + Remove/Modify)
  await page.waitForFunction(() => true, null, { timeout: 1500 }).catch(() => {});
  await new Promise(r => setTimeout(r, 4000));
  console.log('Downloads observed: ' + downloads.length);
  if (downloads.length < 2) throw new Error('Expected 2 PDFs (Keep + Remove/Modify), got ' + downloads.length);
  const names = downloads.map(d => d.suggestedFilename());
  if (!names.some(n => n.includes('KEEP'))) throw new Error('Missing KEEP pdf');
  if (!names.some(n => n.includes('REMOVE-MODIFY'))) throw new Error('Missing REMOVE-MODIFY pdf');
  console.log('PDFs:', names);

  // ------- 6. Admin log: need admin context -------
  const adminPage = await ctx.newPage();
  await adminPage.setExtraHTTPHeaders({ 'x-dev-auth-email': 'admin.one@attest.local' });
  await adminPage.goto('http://localhost:3000/admin.html', { waitUntil: 'networkidle' });
  await adminPage.waitForFunction(() =>
    document.querySelectorAll('#logTableBody tr').length > 0, null, { timeout: 8000 });
  const logRows = await adminPage.$$eval('#logTableBody tr', rs => rs.length);
  console.log('Admin log rows: ' + logRows);
  if (logRows < 1) throw new Error('Admin log should have at least 1 entry, got ' + logRows);

  // Filter by Action = Keep
  const keepCheckbox = await adminPage.$('.multi-filter-option input[value="Keep Business Role"]');
  if (keepCheckbox) await keepCheckbox.check();
  await new Promise(r => setTimeout(r, 200));
  const keepRows = await adminPage.$$eval('#logTableBody tr', rs => rs.length);
  if (keepRows < 1) throw new Error('Filter Keep should show at least 1 row');
  const keepActions = await adminPage.$$eval('#logTableBody tr td:nth-child(4)', ts => ts.map(t => t.textContent));
  if (!keepActions.every(a => a === 'Keep')) throw new Error('Filter not applied: ' + keepActions);
  console.log('Admin filter Keep -> ' + keepRows + ' rows');

  if (errors.length) {
    console.error('JS errors:'); errors.forEach(e => console.error(' -', e));
    throw new Error('Page produced errors');
  }
  await browser.close();
  console.log('\nALL TESTS PASSED');
})().catch(err => { console.error('TEST FAILED:', err); process.exit(1); });

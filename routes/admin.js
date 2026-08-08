// routes/admin.js — Admin users, data uploads, API keys, settings, tenants
module.exports = function register(deps) {
  const { app, adminUserStore, dataStore, apiKeyStore, tenantStore, activityStore, requireAdmin, upload, recordActivity, createNotification, REPORTS_DIR, ROLES_FILE_NAME, TX_FILE_NAME, uniqueRoleNames, uniqueApprovers, txByRole, PROTECTED_ADMIN_EMAILS, refreshRoles, refreshTransactions } = deps;
  const path = require('path');
  const fs = require('fs');
  const XLSX = require('xlsx');

  // ══════ ADMIN USERS ══════
  app.get('/api/admin-users', requireAdmin, async (req, res) => {
    try { res.json({ admins: await adminUserStore.listAdmins(), protectedAdmins: PROTECTED_ADMIN_EMAILS }); }
    catch (err) { console.error('GET /api/admin-users failed:', err); res.status(500).json({ error: 'failed to read admin users' }); }
  });

  app.post('/api/admin-users', requireAdmin, async (req, res) => {
    try { const email = String((req.body && req.body.email) || '').trim(); res.json({ ok: true, email: await adminUserStore.addAdmin(email) }); }
    catch (err) { console.error('POST /api/admin-users failed:', err); res.status(400).json({ error: err.message || 'failed to add admin user' }); }
  });

  app.delete('/api/admin-users/:email', requireAdmin, async (req, res) => {
    try { res.json({ ok: true, removed: await adminUserStore.removeAdmin(String(req.params.email || '').trim()) }); }
    catch (err) {
      if (err.code === 'PROTECTED_ADMIN') return res.status(403).json({ error: 'Superadmin accounts cannot be removed' });
      console.error('DELETE /api/admin-users/:email failed:', err); res.status(400).json({ error: err.message || 'failed to remove admin user' });
    }
  });

  // ══════ DATA UPLOADS ══════
  app.post('/api/admin/reload-data', requireAdmin, async (req, res) => {
    try { const roles = await refreshRoles({ force: true }); const tx = await refreshTransactions({ force: true }); res.json({ ok: true, reloaded: { roles, transactions: tx }, rolesVersion: deps.rolesVersion, txVersion: deps.txVersion }); }
    catch (err) { console.error('POST /api/admin/reload-data failed:', err); res.status(500).json({ error: 'failed to reload source data' }); }
  });

  app.post('/api/admin/upload-roles', requireAdmin, upload.single('file'), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
      const targetPath = path.join(REPORTS_DIR, ROLES_FILE_NAME);
      const buffer = fs.readFileSync(req.file.path);
      const wb = XLSX.read(buffer, { type: 'buffer' });
      const sheetName = wb.SheetNames.includes('Complete') ? 'Complete' : wb.SheetNames[0];
      if (!XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: '' }).length) { fs.unlinkSync(req.file.path); return res.status(400).json({ error: 'Excel file is empty.' }); }
      fs.renameSync(req.file.path, targetPath);
      const reloaded = await refreshRoles({ force: true });
      res.json({ ok: true, reloaded, stats: { roles: uniqueRoleNames.length, approvers: uniqueApprovers.length }, message: `Uploaded. ${uniqueRoleNames.length} roles, ${uniqueApprovers.length} approvers.` });
    } catch (err) { console.error('POST /api/admin/upload-roles failed:', err); if (req.file && fs.existsSync(req.file.path)) { try { fs.unlinkSync(req.file.path); } catch {} } res.status(500).json({ error: err.message || 'Failed to upload.' }); }
  });

  app.post('/api/admin/upload-transactions', requireAdmin, upload.single('file'), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
      const targetPath = path.join(REPORTS_DIR, TX_FILE_NAME);
      const buffer = fs.readFileSync(req.file.path);
      const wb = XLSX.read(buffer, { type: 'buffer' });
      if (!XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' }).length) { fs.unlinkSync(req.file.path); return res.status(400).json({ error: 'Excel file is empty.' }); }
      fs.renameSync(req.file.path, targetPath);
      const reloaded = await refreshTransactions({ force: true });
      const totalRows = Object.values(txByRole).reduce((sum, rows) => sum + rows.length, 0);
      res.json({ ok: true, reloaded, stats: { roles: Object.keys(txByRole).length, totalRows }, message: `Uploaded. ${Object.keys(txByRole).length} roles, ${totalRows} rows.` });
    } catch (err) { console.error('POST /api/admin/upload-transactions failed:', err); if (req.file && fs.existsSync(req.file.path)) { try { fs.unlinkSync(req.file.path); } catch {} } res.status(500).json({ error: err.message || 'Failed to upload.' }); }
  });

  app.get('/api/admin/data-status', requireAdmin, async (req, res) => {
    const txTotalRows = Object.values(txByRole).reduce((sum, rows) => sum + rows.length, 0);
    let rolesFileInfo = null, txFileInfo = null;
    try { const rp = path.join(REPORTS_DIR, ROLES_FILE_NAME); if (fs.existsSync(rp)) { const s = fs.statSync(rp); rolesFileInfo = { name: ROLES_FILE_NAME, size: s.size, modified: s.mtime.toISOString() }; } } catch {}
    try { const tp = path.join(REPORTS_DIR, TX_FILE_NAME); if (fs.existsSync(tp)) { const s = fs.statSync(tp); txFileInfo = { name: TX_FILE_NAME, size: s.size, modified: s.mtime.toISOString() }; } } catch {}
    res.json({ roles: { total: uniqueRoleNames.length, approvers: uniqueApprovers.length, file: rolesFileInfo }, transactions: { rolesWithData: Object.keys(txByRole).length, totalRows: txTotalRows, file: txFileInfo } });
  });

  // ══════ API KEYS ══════
  app.get('/api/api-keys', requireAdmin, async (req, res) => {
    try { res.json(await apiKeyStore.listAll(req.tenantId)); }
    catch (err) { res.status(500).json({ error: 'Failed to list API keys.' }); }
  });

  app.post('/api/api-keys', requireAdmin, async (req, res) => {
    try {
      const { name, permissions } = req.body || {};
      if (!name || !name.trim()) return res.status(400).json({ error: 'Key name is required.' });
      const key = await apiKeyStore.create({ name, permissions: permissions || 'read-only', created_by: req.auth.email, tenant_id: req.tenantId });
      recordActivity({ type: 'API_KEY', action: 'api_key_created', email: req.auth.email, detail: `API key "${key.name}" created (${key.id})` }, req.tenantId);
      res.status(201).json(key);
    } catch (err) { res.status(500).json({ error: 'Failed to generate API key.' }); }
  });

  app.delete('/api/api-keys/:id', requireAdmin, async (req, res) => {
    try { const ok = await apiKeyStore.revoke(req.params.id); if (!ok) return res.status(404).json({ error: 'Key not found.' }); res.json({ ok: true }); }
    catch (err) { res.status(500).json({ error: 'Failed to revoke key.' }); }
  });

  // ══════ SETTINGS ══════
  app.get('/api/settings', async (req, res) => {
    try { const t = await tenantStore.getById(req.tenantId || 'default'); res.json(t ? t.settings : {}); }
    catch (err) { res.json({}); }
  });

  app.patch('/api/settings', requireAdmin, async (req, res) => {
    try {
      const tenant = await tenantStore.getById(req.tenantId || 'default');
      if (!tenant) return res.status(404).json({ error: 'Tenant not found.' });
      await tenantStore.update(req.tenantId, { settings: { ...(tenant.settings || {}), ...(req.body || {}) } });
      res.json({ ok: true, settings: { ...(tenant.settings || {}), ...(req.body || {}) } });
    } catch (err) { res.status(500).json({ error: 'Failed to update settings.' }); }
  });

  // ══════ TENANTS ══════
  app.get('/api/tenants', async (req, res) => {
    try { res.json(await tenantStore.listAll()); }
    catch (err) { console.error('GET /api/tenants failed:', err); res.status(500).json({ error: 'Failed to list tenants.' }); }
  });

  app.post('/api/tenants', requireAdmin, async (req, res) => {
    try {
      const { name, plan } = req.body || {};
      if (!name || !name.trim()) return res.status(400).json({ error: 'Tenant name is required.' });
      const tenant = await tenantStore.create({ name: name.trim(), plan: plan || 'starter', status: 'active' });
      recordActivity({ type: 'TENANT', action: 'tenant_created', email: req.auth.email, detail: `Tenant "${tenant.name}" created (${tenant.id})` });
      res.status(201).json(tenant);
    } catch (err) { console.error('POST /api/tenants failed:', err); res.status(500).json({ error: 'Failed to create tenant.' }); }
  });

  app.patch('/api/tenants/:id', requireAdmin, async (req, res) => {
    try { const { name, plan, status } = req.body || {}; const t = await tenantStore.update(req.params.id, { name, plan, status }); if (!t) return res.status(404).json({ error: 'Tenant not found.' }); res.json(t); }
    catch (err) { console.error('PATCH /api/tenants/:id failed:', err); res.status(500).json({ error: 'Failed to update tenant.' }); }
  });

  app.delete('/api/tenants/:id', requireAdmin, async (req, res) => {
    try {
      if (req.params.id === 'default') return res.status(403).json({ error: 'Cannot delete the default tenant.' });
      const d = await tenantStore.delete(req.params.id); if (!d) return res.status(404).json({ error: 'Tenant not found.' }); res.json({ ok: true });
    } catch (err) { console.error('DELETE /api/tenants/:id failed:', err); res.status(500).json({ error: 'Failed to delete tenant.' }); }
  });

  // ══════ ACTIVITY ══════
  app.get('/api/activity', requireAdmin, async (req, res) => {
    try { const { type, email } = req.query; const limit = Number(req.query.limit) > 0 ? Number(req.query.limit) : undefined; res.json(await activityStore.readAll({ type, email, limit })); }
    catch (err) { console.error('GET /api/activity failed:', err); res.status(500).json({ error: 'failed to read activity log' }); }
  });
};

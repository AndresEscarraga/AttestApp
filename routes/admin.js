// routes/admin.js — Admin users, data uploads, API keys, settings, tenants
module.exports = function register(deps) {
  const { app, adminUserStore, dataStore, apiKeyStore, tenantStore, activityStore, roleCatalogStore, requireCapability, CAPABILITIES, upload, recordActivity, REPORTS_DIR, ROLES_FILE_NAME, TX_FILE_NAME, PROTECTED_ADMIN_EMAILS, refreshRoles, refreshTransactions } = deps;
  const path = require('path');
  const fs = require('fs');
  const crypto = require('crypto');
  const { loadWorkbook, worksheetRows, requireSheet } = require('../services/excelWorkbook');

  function tenantSourcePath(tenantId, fileName) {
    const tid = String(tenantId || '').trim();
    if (!/^[a-zA-Z0-9_-]+$/.test(tid)) throw new Error('Invalid tenant id');
    const dir = tid === 'default' ? REPORTS_DIR : path.join(REPORTS_DIR, tid);
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, fileName);
  }

  function cleanupFile(filePath) {
    if (!filePath || !fs.existsSync(filePath)) return;
    try { fs.unlinkSync(filePath); }
    catch (err) { console.error(`Could not remove temporary upload ${filePath}:`, err); }
  }

  async function validateRolesWorkbook(buffer) {
    const workbook = await loadWorkbook(buffer);
    const rows = worksheetRows(requireSheet(workbook, 'Complete'));
    const header = (rows[0] || []).map(value => String(value || '').trim().toLowerCase());
    if (!header[0] || !header[0].includes('role') || header.length < 4) {
      throw new Error('Roles workbook must include Role Name and Approver Full Name columns.');
    }
    if (rows.length < 2) throw new Error('Roles workbook contains no data rows.');
  }

  async function validateTransactionsWorkbook(buffer) {
    const workbook = await loadWorkbook(buffer);
    const rows = worksheetRows(requireSheet(workbook));
    const firstHeader = String((rows[0] || [])[0] || '').trim().toLowerCase();
    if (!firstHeader.includes('role')) throw new Error('Transactions workbook first column must identify the business role.');
    if (rows.length < 2) throw new Error('Transactions workbook contains no data rows.');
  }

  async function replaceSourceAtomically(uploadPath, targetPath, reload) {
    const backupPath = `${targetPath}.backup-${crypto.randomUUID()}`;
    const hadPrevious = fs.existsSync(targetPath);
    if (hadPrevious) fs.renameSync(targetPath, backupPath);
    try {
      fs.renameSync(uploadPath, targetPath);
      const result = await reload();
      cleanupFile(backupPath);
      return result;
    } catch (err) {
      cleanupFile(targetPath);
      if (hadPrevious && fs.existsSync(backupPath)) fs.renameSync(backupPath, targetPath);
      throw err;
    }
  }

  // ══════ ADMIN USERS ══════
  app.get('/api/admin-users', requireCapability(CAPABILITIES.MEMBERS_MANAGE), async (req, res) => {
    try {
      const members = await adminUserStore.listMembersWithRoles(req.context.tenantId);
      res.json({
        admins: members.filter(member => member.role === 'admin').map(member => member.email),
        members,
        protectedAdmins: members.filter(member => member.protected).map(member => member.email),
      });
    }
    catch (err) { console.error('GET /api/admin-users failed:', err); res.status(500).json({ error: 'failed to read admin users' }); }
  });

  app.post('/api/admin-users', requireCapability(CAPABILITIES.MEMBERS_MANAGE), async (req, res) => {
    try {
      const email = String((req.body && req.body.email) || '').trim();
      const role = String((req.body && req.body.role) || 'admin').trim();
      res.json({ ok: true, email: await adminUserStore.addMembership(email, req.context.tenantId, role) });
    }
    catch (err) { console.error('POST /api/admin-users failed:', err); res.status(400).json({ error: err.message || 'failed to add admin user' }); }
  });

  app.delete('/api/admin-users/:email', requireCapability(CAPABILITIES.MEMBERS_MANAGE), async (req, res) => {
    try { const removed = await adminUserStore.removeMembership(String(req.params.email || '').trim(), req.context.tenantId); if (!removed) return res.status(404).json({ error: 'Membership not found.' }); res.json({ ok: true, removed: true }); }
    catch (err) {
      if (err.code === 'PROTECTED_ADMIN') return res.status(403).json({ error: 'Superadmin accounts cannot be removed' });
      console.error('DELETE /api/admin-users/:email failed:', err); res.status(400).json({ error: err.message || 'failed to remove admin user' });
    }
  });

  app.patch('/api/admin-users/:email', requireCapability(CAPABILITIES.MEMBERS_MANAGE), async (req, res) => {
    try {
      const membership = await adminUserStore.updateMembershipRole(String(req.params.email || '').trim(), req.context.tenantId, String((req.body && req.body.role) || '').trim());
      if (!membership) return res.status(404).json({ error: 'Membership not found.' });
      recordActivity({ type: 'MEMBERSHIP', action: 'membership_role_updated', email: req.context.email, detail: `${membership.email} changed to ${membership.role}` }, req.context);
      res.json({ ok: true, membership });
    } catch (err) {
      if (err.code === 'PROTECTED_ADMIN') return res.status(403).json({ error: err.message });
      console.error('PATCH /api/admin-users/:email failed:', err); res.status(422).json({ error: err.message || 'failed to update member role' });
    }
  });

  // ══════ DATA UPLOADS ══════
  app.post('/api/admin/reload-data', requireCapability(CAPABILITIES.DATA_SOURCE_MANAGE), async (req, res) => {
    try { const roles = await refreshRoles({ force: true, tenantId: req.context.tenantId }); const tx = await refreshTransactions({ force: true, tenantId: req.context.tenantId }); res.json({ ok: true, reloaded: { roles, transactions: tx } }); }
    catch (err) { console.error('POST /api/admin/reload-data failed:', err); res.status(500).json({ error: 'failed to reload source data' }); }
  });

  app.post('/api/admin/upload-roles', requireCapability(CAPABILITIES.DATA_SOURCE_MANAGE), upload.single('file'), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
      const targetPath = tenantSourcePath(req.context.tenantId, ROLES_FILE_NAME);
      const buffer = fs.readFileSync(req.file.path);
      await validateRolesWorkbook(buffer);
      const reloaded = await replaceSourceAtomically(
        req.file.path,
        targetPath,
        () => refreshRoles({ force: true, tenantId: req.context.tenantId })
      );
      const roleNames = roleCatalogStore.listRoleNames(req.context.tenantId);
      const approvers = roleCatalogStore.listApprovers(req.context.tenantId);
      recordActivity({ type: 'DATA', action: 'roles_uploaded', email: req.context.email, detail: `${roleNames.length} roles uploaded` }, req.context);
      res.json({ ok: true, reloaded, stats: { roles: roleNames.length, approvers: approvers.length }, message: `Uploaded. ${roleNames.length} roles, ${approvers.length} approvers.` });
    } catch (err) { console.error('POST /api/admin/upload-roles failed:', err); cleanupFile(req.file && req.file.path); res.status(422).json({ error: err.message || 'Failed to upload.' }); }
  });

  app.post('/api/admin/upload-transactions', requireCapability(CAPABILITIES.DATA_SOURCE_MANAGE), upload.single('file'), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
      const targetPath = tenantSourcePath(req.context.tenantId, TX_FILE_NAME);
      const buffer = fs.readFileSync(req.file.path);
      await validateTransactionsWorkbook(buffer);
      const reloaded = await replaceSourceAtomically(
        req.file.path,
        targetPath,
        () => refreshTransactions({ force: true, tenantId: req.context.tenantId })
      );
      const stats = roleCatalogStore.getTransactionStats(req.context.tenantId);
      recordActivity({ type: 'DATA', action: 'transactions_uploaded', email: req.context.email, detail: `${stats.totalRows} transaction rows uploaded` }, req.context);
      res.json({ ok: true, reloaded, stats: { roles: stats.rolesWithData, totalRows: stats.totalRows }, message: `Uploaded. ${stats.rolesWithData} roles, ${stats.totalRows} rows.` });
    } catch (err) { console.error('POST /api/admin/upload-transactions failed:', err); cleanupFile(req.file && req.file.path); res.status(422).json({ error: err.message || 'Failed to upload.' }); }
  });

  app.get('/api/admin/data-status', requireCapability(CAPABILITIES.DATA_SOURCE_MANAGE), async (req, res) => {
    const txStats = roleCatalogStore.getTransactionStats(req.context.tenantId);
    let rolesFileInfo = null, txFileInfo = null;
    try { const rp = tenantSourcePath(req.context.tenantId, ROLES_FILE_NAME); if (fs.existsSync(rp)) { const s = fs.statSync(rp); rolesFileInfo = { name: ROLES_FILE_NAME, size: s.size, modified: s.mtime.toISOString() }; } } catch (err) { console.error('Roles source status failed:', err); }
    try { const tp = tenantSourcePath(req.context.tenantId, TX_FILE_NAME); if (fs.existsSync(tp)) { const s = fs.statSync(tp); txFileInfo = { name: TX_FILE_NAME, size: s.size, modified: s.mtime.toISOString() }; } } catch (err) { console.error('Transactions source status failed:', err); }
    const roles = roleCatalogStore.listRoleNames(req.context.tenantId);
    const approvers = roleCatalogStore.listApprovers(req.context.tenantId);
    res.json({ roles: { total: roles.length, approvers: approvers.length, file: rolesFileInfo }, transactions: { rolesWithData: txStats.rolesWithData, totalRows: txStats.totalRows, file: txFileInfo } });
  });

  // ══════ API KEYS ══════
  app.get('/api/api-keys', requireCapability(CAPABILITIES.API_KEY_MANAGE), async (req, res) => {
    try { res.json(await apiKeyStore.listAll(req.context.tenantId)); }
    catch (err) { res.status(500).json({ error: 'Failed to list API keys.' }); }
  });

  app.post('/api/api-keys', requireCapability(CAPABILITIES.API_KEY_MANAGE), async (req, res) => {
    try {
      const { name, permissions } = req.body || {};
      if (!name || !name.trim()) return res.status(400).json({ error: 'Key name is required.' });
      const key = await apiKeyStore.create({ name, permissions: permissions || 'read-only', created_by: req.context.email, tenant_id: req.context.tenantId });
      recordActivity({ type: 'API_KEY', action: 'api_key_created', email: req.context.email, detail: `API key "${key.name}" created (${key.id})` }, req.context);
      res.status(201).json(key);
    } catch (err) { res.status(500).json({ error: 'Failed to generate API key.' }); }
  });

  app.delete('/api/api-keys/:id', requireCapability(CAPABILITIES.API_KEY_MANAGE), async (req, res) => {
    try { const ok = await apiKeyStore.revoke(req.params.id, req.context.tenantId); if (!ok) return res.status(404).json({ error: 'Key not found.' }); res.json({ ok: true }); }
    catch (err) { res.status(500).json({ error: 'Failed to revoke key.' }); }
  });

  // ══════ SETTINGS ══════
  app.get('/api/settings', requireCapability(CAPABILITIES.SETTINGS_READ), async (req, res) => {
    try { const t = await tenantStore.getById(req.context.tenantId); if (!t) return res.status(404).json({ error: 'Tenant not found.' }); res.json(t.settings); }
    catch (err) { console.error('GET /api/settings failed:', err); res.status(500).json({ error: 'Failed to load settings.' }); }
  });

  app.patch('/api/settings', requireCapability(CAPABILITIES.SETTINGS_MANAGE), async (req, res) => {
    try {
      const tenant = await tenantStore.getById(req.context.tenantId);
      if (!tenant) return res.status(404).json({ error: 'Tenant not found.' });
      const body = req.body || {};
      const patch = body.key ? { [String(body.key)]: body.value } : body;
      const settings = { ...(tenant.settings || {}), ...patch };
      await tenantStore.update(req.context.tenantId, { settings });
      res.json({ ok: true, settings });
    } catch (err) { res.status(500).json({ error: 'Failed to update settings.' }); }
  });

  // ══════ TENANTS ══════
  app.get('/api/tenants', requireCapability(CAPABILITIES.TENANT_READ), async (req, res) => {
    try { res.json(await tenantStore.listForUser(req.context.email)); }
    catch (err) { console.error('GET /api/tenants failed:', err); res.status(500).json({ error: 'Failed to list tenants.' }); }
  });

  app.post('/api/tenants', requireCapability(CAPABILITIES.TENANT_CREATE), async (req, res) => {
    try {
      const { name, plan } = req.body || {};
      if (!name || !name.trim()) return res.status(400).json({ error: 'Tenant name is required.' });
      const tenant = await tenantStore.create({ name: name.trim(), plan: plan || 'starter', status: 'active' });
      await adminUserStore.addMembership(req.context.email, tenant.id, 'admin');
      recordActivity({ type: 'TENANT', action: 'tenant_created', email: req.context.email, detail: `Tenant "${tenant.name}" created (${tenant.id})` }, tenant.id);
      res.status(201).json(tenant);
    } catch (err) { console.error('POST /api/tenants failed:', err); res.status(500).json({ error: 'Failed to create tenant.' }); }
  });

  app.patch('/api/tenants/:id', requireCapability(CAPABILITIES.TENANT_MANAGE), async (req, res) => {
    try {
      if (req.params.id !== req.context.tenantId) return res.status(404).json({ error: 'Tenant not found.' });
      const { name, plan, status } = req.body || {}; const t = await tenantStore.update(req.params.id, { name, plan, status }); if (!t) return res.status(404).json({ error: 'Tenant not found.' }); res.json(t);
    }
    catch (err) { console.error('PATCH /api/tenants/:id failed:', err); res.status(500).json({ error: 'Failed to update tenant.' }); }
  });

  app.delete('/api/tenants/:id', requireCapability(CAPABILITIES.TENANT_MANAGE), async (req, res) => {
    try {
      if (req.params.id !== req.context.tenantId) return res.status(404).json({ error: 'Tenant not found.' });
      return res.status(409).json({ error: 'The active tenant cannot be deleted. Switch-based tenant deletion is intentionally disabled.' });
    } catch (err) { console.error('DELETE /api/tenants/:id failed:', err); res.status(500).json({ error: 'Failed to delete tenant.' }); }
  });

  // ══════ ACTIVITY ══════
  app.get('/api/activity', requireCapability(CAPABILITIES.ACTIVITY_READ), async (req, res) => {
    try { const { type, email } = req.query; const limit = Number(req.query.limit) > 0 ? Number(req.query.limit) : undefined; const offset = Number(req.query.offset) > 0 ? Number(req.query.offset) : 0; res.json(await activityStore.readAll({ tenantId: req.context.tenantId, type, email, limit, offset })); }
    catch (err) { console.error('GET /api/activity failed:', err); res.status(500).json({ error: 'failed to read activity log' }); }
  });
};

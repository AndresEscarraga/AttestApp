// routes/review.js — Roles, approvers, transactions, submission log
module.exports = function register(deps) {
  const { app, logStore, roleCatalogStore, campaignStore, recordActivity, createNotification, requireCapability, CAPABILITIES, MAX_TRANSACTION_ROLE_LOOKUPS, MAX_SUBMISSION_ROWS } = deps;
  const validActions = new Set(['Keep Business Role', 'Modify Business Role', 'Modify Technical Role', 'Reject Business Role']);

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

  function sendRolesForApprover(req, res, requestedApprover) {
    const context = req.context;
    if (context.isAdmin) {
      if (requestedApprover) return res.json(roleCatalogStore.getRolesForApprover(context.tenantId, requestedApprover));
      return res.json(roleCatalogStore.listRoleNames(context.tenantId));
    }
    if (requestedApprover && requestedApprover !== context.approverName) {
      return res.status(403).json({ error: 'You can only access roles assigned to your approver profile.' });
    }
    return res.json(context.roles);
  }

  // GET /api/approvers
  app.get('/api/approvers', requireCapability(CAPABILITIES.REVIEW_READ), (req, res) => {
    if (!req.context.isAdmin) return res.json(req.context.approverName ? [req.context.approverName] : []);
    res.json(roleCatalogStore.listApprovers(req.context.tenantId).map(item => item.name));
  });

  // GET /api/roles
  app.get('/api/roles', requireCapability(CAPABILITIES.REVIEW_READ), (req, res) => sendRolesForApprover(req, res, getRequestedApprover(req)));

  // POST /api/roles/by-approver
  app.post('/api/roles/by-approver', requireCapability(CAPABILITIES.REVIEW_READ), (req, res) => sendRolesForApprover(req, res, getBodyApprover(req)));

  // GET /api/approver
  app.get('/api/approver', requireCapability(CAPABILITIES.REVIEW_READ), (req, res) => {
    const role = String(req.query.role || '').trim();
    if (!role) return res.json({ role: '', fullName: '' });
    if (!hasRoleAccess(req.context, role)) {
      return res.status(403).json({ error: 'You can only access roles assigned to your approver profile.' });
    }
    res.json({ role, fullName: roleCatalogStore.getApproverForRole(req.context.tenantId, role) });
  });

  // GET /api/transactions
  app.get('/api/transactions', requireCapability(CAPABILITIES.REVIEW_READ), (req, res) => {
    const role = String(req.query.role || '').trim();
    if (role && !hasRoleAccess(req.context, role)) {
      return res.status(403).json({ error: 'You can only access transactions for roles assigned to your approver profile.' });
    }
    const rows = role ? roleCatalogStore.getTransactions(req.context.tenantId, role) : [];
    res.json({ header: roleCatalogStore.getTransactionHeader(req.context.tenantId), rows });
  });

  // POST /api/transactions/bulk
  app.post('/api/transactions/bulk', requireCapability(CAPABILITIES.REVIEW_READ), (req, res) => {
    const roles = Array.isArray(req.body && req.body.roles) ? req.body.roles : [];
    if (roles.length > MAX_TRANSACTION_ROLE_LOOKUPS) {
      return res.status(413).json({ error: `Too many roles requested; max is ${MAX_TRANSACTION_ROLE_LOOKUPS}` });
    }
    const out = {};
    const boundedRoles = roles.slice(0, MAX_TRANSACTION_ROLE_LOOKUPS);
    for (const r of boundedRoles) {
      const role = String(r || '').trim();
      if (!role) continue;
      if (!hasRoleAccess(req.context, role)) {
        return res.status(403).json({ error: 'You can only access transactions for roles assigned to your approver profile.' });
      }
      out[role] = roleCatalogStore.getTransactions(req.context.tenantId, role);
    }
    res.json({ header: roleCatalogStore.getTransactionHeader(req.context.tenantId), byRole: out });
  });

  // POST /api/log — submit certification
  app.post('/api/log', requireCapability(CAPABILITIES.REVIEW_SUBMIT), async (req, res) => {
    try {
      const context = req.context;
      const body = req.body || {};
      const requestedApprover = String(body.approver || '').trim();
      const approver = context.isAdmin ? requestedApprover : context.approverName;
      const rows = Array.isArray(body.rows) ? body.rows : [];
      if (!approver || !rows.length) return res.status(400).json({ error: 'approver and rows are required' });
      if (rows.length > MAX_SUBMISSION_ROWS) return res.status(413).json({ error: `Too many submitted rows; max is ${MAX_SUBMISSION_ROWS}` });
      const approverRoles = roleCatalogStore.getRolesForApprover(context.tenantId, approver);
      if (!approverRoles.length) return res.status(400).json({ error: 'Unknown approver' });
      if (!context.isAdmin && requestedApprover && requestedApprover !== context.approverName) {
        return res.status(403).json({ error: 'You can only submit reviews for your approver profile.' });
      }
      const allowedRoles = new Set(approverRoles);
      for (const row of rows) {
        const roleName = String(row.roleName || '').trim();
        const action = String(row.action || '').trim();
        if (!roleName || !allowedRoles.has(roleName)) {
          return res.status(403).json({ error: 'A submitted role is not assigned to this approver in the active tenant.' });
        }
        if (!validActions.has(action)) {
          return res.status(422).json({ error: `Invalid certification action for ${roleName}.` });
        }
        if (row.txAcknowledged !== true) {
          return res.status(422).json({ error: `Permission acknowledgement is required for ${roleName}.` });
        }
        if (action !== 'Keep Business Role' && !String(row.actionDetails || row.comments || '').trim()) {
          return res.status(422).json({ error: `Action details are required for ${roleName}.` });
        }
      }
      const campaignId = String(body.campaignId || '').trim();
      if (campaignId) {
        const campaign = await campaignStore.readById(campaignId, context.tenantId);
        if (!campaign) return res.status(404).json({ error: 'Campaign not found.' });
        if (campaign.status !== 'active') return res.status(409).json({ error: 'Decisions can only be submitted to an active campaign.' });
        if (campaign.approvers.length && !campaign.approvers.includes(approver)) {
          return res.status(403).json({ error: 'The approver is not in this campaign scope.' });
        }
        const existing = await logStore.readAll({ tenantId: context.tenantId, campaignId, approver, limit: MAX_SUBMISSION_ROWS });
        const duplicates = new Set(existing.map(entry => entry.roleName));
        if (rows.some(row => duplicates.has(String(row.roleName || '').trim()))) {
          return res.status(409).json({ error: 'A decision already exists for one or more roles in this campaign.' });
        }
      }
      const ts = new Date().toISOString();
      const maxRow = deps.db.prepare("SELECT MAX(CAST(submission_id AS INTEGER)) as max_id FROM submissions WHERE submission_id GLOB '[0-9][0-9][0-9][0-9][0-9][0-9]'").get();
      const nextId = String((maxRow && maxRow.max_id ? Number(maxRow.max_id) : 0) + 1).padStart(6, '0');
      const boundedRows = rows.slice(0, MAX_SUBMISSION_ROWS);
      const entries = boundedRows.map((r, idx) => ({
        logEntryId: nextId + '-' + String(idx + 1).padStart(3, '0'),
        submissionId: nextId, timestamp: ts, approver,
        submittedByEmail: context.email,
        impersonated: context.isAdmin && approver !== context.approverName,
        roleName: String(r.roleName || '').trim(),
        action: String(r.action || '').trim(),
        ritm: String(r.ritm || '').trim(), ritmStatus: 'Open',
        actionDetails: String(r.actionDetails || r.comments || '').trim(),
        comments: String(r.actionDetails || r.comments || '').trim(),
        rejectionReason: String(r.rejectionReason || '').trim(),
        rowIndex: idx + 1,
        campaignId: String(campaignId || r.campaignId || '').trim(),
        tenantId: context.tenantId,
      })).filter(e => e.roleName && allowedRoles.has(e.roleName));
      if (!entries.length) return res.status(400).json({ error: 'No submitted rows match the authorized approver roles.' });
      await logStore.appendEntries(entries);
      recordActivity({ type: 'SUBMISSION', action: 'submission_created', email: context.email,
        detail: `Submission ${nextId} for ${approver}: ${entries.length} role(s)` + (context.isAdmin && approver !== context.approverName ? ' (impersonated)' : '') }, context);
      createNotification({ tenant_id: context.tenantId, type: 'submission', title: 'New certification submitted',
        body: `${approver} certified ${entries.length} role(s).`, link: '/audit-trail.html', icon: '✅' });
      res.json({ ok: true, submissionId: nextId, recorded: entries.length });
    } catch (err) {
      console.error('POST /api/log failed:', err);
      res.status(500).json({ error: 'failed to record submission' });
    }
  });

  // GET /api/log (admin only)
  app.get('/api/log', requireCapability(CAPABILITIES.AUDIT_READ), async (req, res) => {
    try {
      const { approver, action, role, limit, offset } = req.query;
      res.json(await logStore.readAll({ tenantId: req.context.tenantId, approver, action, role, limit: Number(limit) || undefined, offset: Number(offset) || 0 }));
    } catch (err) {
      console.error('GET /api/log failed:', err);
      res.status(500).json({ error: 'failed to read submissions' });
    }
  });

  // PATCH /api/log/:logEntryId/ritm
  app.patch('/api/log/:logEntryId/ritm', requireCapability(CAPABILITIES.AUDIT_UPDATE), async (req, res) => {
    try {
      const logEntryId = String(req.params.logEntryId || '').trim();
      const ritm = String((req.body && req.body.ritm) || '').trim();
      if (!logEntryId) return res.status(400).json({ error: 'logEntryId is required' });
      const ok = await logStore.updateRitm(logEntryId, req.context.tenantId, ritm);
      if (!ok) return res.status(404).json({ error: 'log entry not found' });
      recordActivity({ type: 'RITM', action: 'ritm_updated', email: req.context.email, detail: `RITM for ${logEntryId} set to "${ritm || '(cleared)'}"` }, req.context);
      res.json({ ok: true, logEntryId, ritm });
    } catch (err) { console.error('PATCH /api/log/:logEntryId/ritm failed:', err); res.status(500).json({ error: 'failed to update RITM' }); }
  });

  // PATCH /api/log/:logEntryId/ritm-status
  app.patch('/api/log/:logEntryId/ritm-status', requireCapability(CAPABILITIES.AUDIT_UPDATE), async (req, res) => {
    try {
      const logEntryId = String(req.params.logEntryId || '').trim();
      const ritmStatus = String((req.body && req.body.ritmStatus) || '').trim();
      if (!logEntryId) return res.status(400).json({ error: 'logEntryId is required' });
      if (ritmStatus && !['Open','Resolved','On Hold','Cancelled'].includes(ritmStatus)) {
        return res.status(400).json({ error: 'invalid RITM update status' });
      }
      const ok = await logStore.updateRitmStatus(logEntryId, req.context.tenantId, ritmStatus);
      if (!ok) return res.status(404).json({ error: 'log entry not found' });
      recordActivity({ type: 'RITM', action: 'ritm_status_updated', email: req.context.email, detail: `RITM status for ${logEntryId} set to "${ritmStatus || '(cleared)'}"` }, req.context);
      res.json({ ok: true, logEntryId, ritmStatus });
    } catch (err) { console.error('PATCH /api/log/:logEntryId/ritm-status failed:', err); res.status(500).json({ error: 'failed to update RITM status' }); }
  });
};

// routes/review.js — Roles, approvers, transactions, submission log
module.exports = function register(deps) {
  const { app, logStore, activityStore, uniqueApprovers, approverToRoles, uniqueRoleNames, txByRole, txHeader, recordActivity, createNotification, requireAdmin, MAX_TRANSACTION_ROLE_LOOKUPS, MAX_SUBMISSION_ROWS } = deps;

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
    if (req.auth.isAdmin) {
      if (requestedApprover) return res.json(approverToRoles[requestedApprover] || []);
      return res.json(uniqueRoleNames);
    }
    if (requestedApprover && requestedApprover !== req.auth.approverName) {
      return res.status(403).json({ error: 'You can only access roles assigned to your approver profile.' });
    }
    return res.json(req.auth.roles);
  }

  // GET /api/approvers
  app.get('/api/approvers', (req, res) => {
    if (!req.auth.isAdmin) return res.json(req.auth.approverName ? [req.auth.approverName] : []);
    res.json(uniqueApprovers);
  });

  // GET /api/roles
  app.get('/api/roles', (req, res) => sendRolesForApprover(req, res, getRequestedApprover(req)));

  // POST /api/roles/by-approver
  app.post('/api/roles/by-approver', (req, res) => sendRolesForApprover(req, res, getBodyApprover(req)));

  // GET /api/approver
  app.get('/api/approver', (req, res) => {
    const role = String(req.query.role || '').trim();
    if (!role) return res.json({ role: '', fullName: '' });
    if (!hasRoleAccess(req.auth, role)) {
      return res.status(403).json({ error: 'You can only access roles assigned to your approver profile.' });
    }
    res.json({ role, fullName: deps.roleToApprover[role] || '' });
  });

  // GET /api/transactions
  app.get('/api/transactions', (req, res) => {
    const role = String(req.query.role || '').trim();
    if (role && !hasRoleAccess(req.auth, role)) {
      return res.status(403).json({ error: 'You can only access transactions for roles assigned to your approver profile.' });
    }
    const rows = role && txByRole[role] ? txByRole[role] : [];
    res.json({ header: txHeader, rows });
  });

  // POST /api/transactions/bulk
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

  // POST /api/log — submit certification
  app.post('/api/log', async (req, res) => {
    try {
      const body = req.body || {};
      const requestedApprover = String(body.approver || '').trim();
      const approver = req.auth.isAdmin ? requestedApprover : req.auth.approverName;
      const rows = Array.isArray(body.rows) ? body.rows : [];
      if (!approver || !rows.length) return res.status(400).json({ error: 'approver and rows are required' });
      if (rows.length > MAX_SUBMISSION_ROWS) return res.status(413).json({ error: `Too many submitted rows; max is ${MAX_SUBMISSION_ROWS}` });
      if (!approverToRoles[approver]) return res.status(400).json({ error: 'Unknown approver' });
      if (!req.auth.isAdmin && requestedApprover && requestedApprover !== req.auth.approverName) {
        return res.status(403).json({ error: 'You can only submit reviews for your approver profile.' });
      }
      const allowedRoles = new Set(approverToRoles[approver] || []);
      const ts = new Date().toISOString();
      const maxRow = deps.db.prepare("SELECT MAX(CAST(submission_id AS INTEGER)) as max_id FROM submissions WHERE submission_id GLOB '[0-9][0-9][0-9][0-9][0-9][0-9]'").get();
      const nextId = String((maxRow && maxRow.max_id ? Number(maxRow.max_id) : 0) + 1).padStart(6, '0');
      const boundedRows = rows.slice(0, MAX_SUBMISSION_ROWS);
      const entries = boundedRows.map((r, idx) => ({
        logEntryId: nextId + '-' + String(idx + 1).padStart(3, '0'),
        submissionId: nextId, timestamp: ts, approver,
        submittedByEmail: req.auth.email,
        impersonated: req.auth.isAdmin && approver !== req.auth.approverName,
        roleName: String(r.roleName || '').trim(),
        action: String(r.action || '').trim(),
        ritm: String(r.ritm || '').trim(), ritmStatus: 'Open',
        actionDetails: String(r.actionDetails || r.comments || '').trim(),
        comments: String(r.actionDetails || r.comments || '').trim(),
        rejectionReason: String(r.rejectionReason || '').trim(),
        rowIndex: idx + 1,
      })).filter(e => e.roleName && allowedRoles.has(e.roleName));
      if (!entries.length) return res.status(400).json({ error: 'No submitted rows match the authorized approver roles.' });
      await logStore.appendEntries(entries);
      recordActivity({ type: 'SUBMISSION', action: 'submission_created', email: req.auth.email,
        detail: `Submission ${nextId} for ${approver}: ${entries.length} role(s)` + (req.auth.isAdmin && approver !== req.auth.approverName ? ' (impersonated)' : '') });
      createNotification({ tenant_id: req.tenantId || 'default', type: 'submission', title: 'New certification submitted',
        body: `${approver} certified ${entries.length} role(s).`, link: '/audit-trail.html', icon: '✅' });
      res.json({ ok: true, submissionId: nextId, recorded: entries.length });
    } catch (err) {
      console.error('POST /api/log failed:', err);
      res.status(500).json({ error: 'failed to record submission' });
    }
  });

  // GET /api/log (admin only)
  app.get('/api/log', requireAdmin, async (req, res) => {
    try {
      const { approver, action, role, limit, offset } = req.query;
      res.json(await logStore.readAll({ approver, action, role, limit: Number(limit) || undefined, offset: Number(offset) || 0 }));
    } catch (err) {
      console.error('GET /api/log failed:', err);
      res.status(500).json({ error: 'failed to read submissions' });
    }
  });

  // PATCH /api/log/:logEntryId/ritm
  app.patch('/api/log/:logEntryId/ritm', requireAdmin, async (req, res) => {
    try {
      const logEntryId = String(req.params.logEntryId || '').trim();
      const ritm = String((req.body && req.body.ritm) || '').trim();
      if (!logEntryId) return res.status(400).json({ error: 'logEntryId is required' });
      const ok = await logStore.updateRitm(logEntryId, ritm);
      if (!ok) return res.status(404).json({ error: 'log entry not found' });
      recordActivity({ type: 'RITM', action: 'ritm_updated', email: req.auth.email, detail: `RITM for ${logEntryId} set to "${ritm || '(cleared)'}"` });
      res.json({ ok: true, logEntryId, ritm });
    } catch (err) { console.error('PATCH /api/log/:logEntryId/ritm failed:', err); res.status(500).json({ error: 'failed to update RITM' }); }
  });

  // PATCH /api/log/:logEntryId/ritm-status
  app.patch('/api/log/:logEntryId/ritm-status', requireAdmin, async (req, res) => {
    try {
      const logEntryId = String(req.params.logEntryId || '').trim();
      const ritmStatus = String((req.body && req.body.ritmStatus) || '').trim();
      if (!logEntryId) return res.status(400).json({ error: 'logEntryId is required' });
      if (ritmStatus && !['Open','Resolved','On Hold','Cancelled'].includes(ritmStatus)) {
        return res.status(400).json({ error: 'invalid RITM update status' });
      }
      const ok = await logStore.updateRitmStatus(logEntryId, ritmStatus);
      if (!ok) return res.status(404).json({ error: 'log entry not found' });
      recordActivity({ type: 'RITM', action: 'ritm_status_updated', email: req.auth.email, detail: `RITM status for ${logEntryId} set to "${ritmStatus || '(cleared)'}"` });
      res.json({ ok: true, logEntryId, ritmStatus });
    } catch (err) { console.error('PATCH /api/log/:logEntryId/ritm-status failed:', err); res.status(500).json({ error: 'failed to update RITM status' }); }
  });
};

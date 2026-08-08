// routes/dashboard.js — Dashboard stats, notifications
module.exports = function register(deps) {
  const { app, logStore, activityStore, campaignStore, sodStore, notificationStore, uniqueRoleNames } = deps;

  // ══════ DASHBOARD ══════
  app.get('/api/dashboard/stats', async (req, res) => {
    try {
      const submissions = await logStore.readAll();
      const totalRoles = uniqueRoleNames.length;
      const reviewedRolesSet = new Set();
      submissions.forEach(s => { if (s.action && s.action !== '') reviewedRolesSet.add(s.roleName); });
      const reviewedCount = reviewedRolesSet.size;
      const progress = totalRoles > 0 ? Math.round((reviewedCount / totalRoles) * 100) : 0;
      const pendingCount = Math.max(0, totalRoles - reviewedCount);
      const sodStats = await sodStore.getConflictStats();
      const recentActivity = await activityStore.readAll({ limit: 10 });
      res.json({ totalRoles, reviewedRoles: reviewedCount, progress, pendingCount, sodConflicts: sodStats.open, recentActivity });
    } catch (err) { console.error('GET /api/dashboard/stats failed:', err); res.status(500).json({ error: 'Failed to load dashboard stats.' }); }
  });

  app.get('/api/dashboard/recent-activity', async (req, res) => {
    try { res.json(await activityStore.readAll({ limit: 10 })); }
    catch (err) { console.error('GET /api/dashboard/recent-activity failed:', err); res.status(500).json({ error: 'Failed to load recent activity.' }); }
  });

  app.get('/api/dashboard/progress-by-system', async (req, res) => {
    try {
      const systems = {};
      uniqueRoleNames.forEach(role => {
        const parts = role.split(' - '); const system = parts.length >= 2 ? parts[1].trim() : 'Other';
        if (!system) return;
        if (!systems[system]) systems[system] = { total: 0, reviewed: 0 };
        systems[system].total += 1;
      });
      const submissions = await logStore.readAll();
      const reviewedRolesSet = new Set();
      submissions.forEach(s => { if (s.action && s.action !== '') reviewedRolesSet.add(s.roleName); });
      uniqueRoleNames.forEach(role => {
        const parts = role.split(' - '); const system = parts.length >= 2 ? parts[1].trim() : 'Other';
        if (!system || !systems[system]) return;
        if (reviewedRolesSet.has(role)) systems[system].reviewed += 1;
      });
      const result = Object.entries(systems).map(([name, data]) => ({ name, total: data.total, reviewed: data.reviewed, pct: data.total > 0 ? Math.round((data.reviewed / data.total) * 100) : 0 })).sort((a, b) => b.total - a.total);
      res.json(result);
    } catch (err) { console.error('GET /api/dashboard/progress-by-system failed:', err); res.status(500).json({ error: 'Failed to load system progress.' }); }
  });

  app.get('/api/dashboard/active-campaigns', async (req, res) => {
    try {
      const campaigns = await campaignStore.readAll({ status: 'active', limit: 5 });
      if (!campaigns.length) {
        const submissions = await logStore.readAll(); const approvers = new Set(submissions.map(s => s.approver));
        const reviewedRolesSet = new Set(); submissions.forEach(s => { if (s.action && s.action !== '') reviewedRolesSet.add(s.roleName); });
        const totalRoles = uniqueRoleNames.length; const progress = totalRoles > 0 ? Math.round((reviewedRolesSet.size / totalRoles) * 100) : 0;
        return res.json([{ id: 'current', name: 'Current Access Review', framework: 'ITGC', period: 'Q3 2026', status: progress >= 100 ? 'completed' : 'active', deadline: '2026-08-31', approvers: approvers.size, totalRoles, reviewedRoles: reviewedRolesSet.size, progress }]);
      }
      const result = await Promise.all(campaigns.map(async (c) => {
        const totalRoles = uniqueRoleNames.length; const submissions = await logStore.readAll();
        const reviewedRolesSet = new Set(); submissions.forEach(s => { if (s.action && s.action !== '' && s.campaignId === c.id) reviewedRolesSet.add(s.roleName); });
        const progress = totalRoles > 0 ? Math.round((reviewedRolesSet.size / totalRoles) * 100) : 0;
        return { id: c.id, name: c.name, framework: c.framework, period: c.period, status: c.status, deadline: c.deadline, approvers: c.approvers.length, totalRoles, reviewedRoles: reviewedRolesSet.size, progress };
      }));
      res.json(result);
    } catch (err) { console.error('GET /api/dashboard/active-campaigns failed:', err); res.json([]); }
  });

  // ══════ NOTIFICATIONS ══════
  app.get('/api/notifications', async (req, res) => {
    try {
      const tenantId = req.tenantId || 'default'; const type = req.query.type || ''; const unreadOnly = req.query.unread === '1';
      const limit = Math.min(Number(req.query.limit) || 20, 50);
      const filters = { tenant_id: tenantId, limit }; if (type) filters.type = type; if (unreadOnly) filters.read = false;
      const [notifications, unreadCount] = await Promise.all([notificationStore.readAll(filters), notificationStore.getUnreadCount(tenantId)]);
      res.json({ notifications, unreadCount });
    } catch (err) { console.error('GET /api/notifications failed:', err); res.status(500).json({ error: 'Failed to load notifications.' }); }
  });

  app.patch('/api/notifications/:id/read', async (req, res) => {
    try { await notificationStore.markRead(req.params.id); res.json({ ok: true }); }
    catch (err) { res.status(500).json({ error: 'Failed to update notification.' }); }
  });

  app.patch('/api/notifications/read-all', async (req, res) => {
    try { await notificationStore.markAllRead(req.tenantId || 'default'); res.json({ ok: true }); }
    catch (err) { res.status(500).json({ error: 'Failed to update notifications.' }); }
  });

  app.get('/api/notifications/unread-count', async (req, res) => {
    try { res.json({ count: await notificationStore.getUnreadCount(req.tenantId || 'default') }); }
    catch (err) { res.status(500).json({ error: 'Failed to get unread count.' }); }
  });
};

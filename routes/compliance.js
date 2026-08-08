// routes/compliance.js — Campaigns, SoD, Evidence Locker
module.exports = function register(deps) {
  const { app, campaignStore, sodStore, evidenceStore, logStore, activityStore, roleCatalogStore, requireAdmin, recordActivity, createNotification } = deps;

  // ══════ CAMPAIGNS ══════
  app.post('/api/campaigns', requireAdmin, async (req, res) => {
    try {
      const { name, description, framework, period, deadline, approvers } = req.body || {};
      if (!name || !name.trim()) return res.status(400).json({ error: 'Campaign name is required.' });
      if (!period || !period.trim()) return res.status(400).json({ error: 'Period is required (e.g. Q3 2026).' });
      const campaign = await campaignStore.create({ tenant_id: req.tenantId, name: name.trim(), description: description || '', framework: framework || 'SOX', period: period.trim(), deadline: deadline || '', approvers: Array.isArray(approvers) ? approvers : [], created_by: req.auth.email, status: 'draft' });
      recordActivity({ type: 'CAMPAIGN', action: 'campaign_created', email: req.auth.email, detail: `Campaign "${campaign.name}" created (${campaign.id})` }, req.tenantId);
      createNotification({ tenant_id: req.tenantId || 'default', type: 'campaign', title: 'New campaign created', body: `"${campaign.name}" is ready for review.`, link: '/campaigns.html', icon: '📋' });
      res.status(201).json(campaign);
    } catch (err) { console.error('POST /api/campaigns failed:', err); res.status(500).json({ error: 'Failed to create campaign.' }); }
  });

  app.get('/api/campaigns', async (req, res) => {
    try {
      const filters = { tenant_id: req.tenantId };
      if (req.query.status) filters.status = req.query.status;
      if (req.query.framework) filters.framework = req.query.framework;
      if (req.query.limit) filters.limit = Math.min(Number(req.query.limit), 100);
      const campaigns = await campaignStore.readAll(filters);
      const enriched = await Promise.all(campaigns.map(async campaign => {
        const scopedRoles = new Set();
        campaign.approvers.forEach(approver => {
          roleCatalogStore.getRolesForApprover(req.tenantId, approver).forEach(role => scopedRoles.add(role));
        });
        const progress = await campaignStore.getProgress(campaign.id, req.tenantId);
        const totalRoles = scopedRoles.size;
        const reviewedRoles = progress ? progress.totalReviewed : 0;
        return {
          ...campaign,
          totalRoles,
          reviewedRoles,
          progress: totalRoles > 0 ? Math.round((reviewedRoles / totalRoles) * 100) : 0,
        };
      }));
      res.json(enriched);
    } catch (err) { console.error('GET /api/campaigns failed:', err); res.status(500).json({ error: 'Failed to list campaigns.' }); }
  });

  app.get('/api/campaigns/:id', async (req, res) => {
    try {
      const campaign = await campaignStore.readById(req.params.id, req.tenantId);
      if (!campaign) return res.status(404).json({ error: 'Campaign not found.' });
      const progress = await campaignStore.getProgress(req.params.id, req.tenantId);
      const enrichedApprovers = campaign.approvers.map(name => {
        const approverRoles = roleCatalogStore.getRolesForApprover(req.tenantId, name);
        const progressInfo = (progress && progress.approverProgress.find(p => p.approver === name)) || {};
        return { name, totalRoles: approverRoles.length, roles: approverRoles, reviewedCount: progressInfo.reviewedCount || 0, reviewedRoles: progressInfo.reviewedRoles || [] };
      });
      const totalRoles = new Set(enrichedApprovers.flatMap(item => item.roles)).size;
      const totalReviewed = progress ? progress.totalReviewed : 0;
      res.json({ ...campaign, approvers: enrichedApprovers, totalRoles, totalReviewed, progress: totalRoles > 0 ? Math.round((totalReviewed / totalRoles) * 100) : 0 });
    } catch (err) { console.error('GET /api/campaigns/:id failed:', err); res.status(500).json({ error: 'Failed to load campaign.' }); }
  });

  app.patch('/api/campaigns/:id', requireAdmin, async (req, res) => {
    try {
      const { name, description, framework, period, status, deadline, approvers } = req.body || {};
      const updates = {};
      if (name !== undefined) updates.name = name;
      if (description !== undefined) updates.description = description;
      if (framework !== undefined) updates.framework = framework;
      if (period !== undefined) updates.period = period;
      if (status !== undefined) updates.status = status;
      if (deadline !== undefined) updates.deadline = deadline;
      if (approvers !== undefined) updates.approvers = approvers;
      const campaign = await campaignStore.update(req.params.id, req.tenantId, updates);
      if (!campaign) return res.status(404).json({ error: 'Campaign not found.' });
      recordActivity({ type: 'CAMPAIGN', action: 'campaign_updated', email: req.auth.email, detail: `Campaign "${campaign.name}" updated (status: ${campaign.status})` }, req.tenantId);
      if (updates.status) {
        const statusLabels = { active: 'activated', completed: 'completed', archived: 'archived', draft: 'set to draft' };
        createNotification({ tenant_id: req.tenantId || 'default', type: 'campaign', title: `Campaign ${statusLabels[updates.status] || 'updated'}`, body: `"${campaign.name}" was ${statusLabels[updates.status] || 'updated'}.`, link: '/campaigns.html', icon: '📋' });
      }
      res.json(campaign);
    } catch (err) { console.error('PATCH /api/campaigns/:id failed:', err); res.status(500).json({ error: 'Failed to update campaign.' }); }
  });

  app.delete('/api/campaigns/:id', requireAdmin, async (req, res) => {
    try {
      const campaign = await campaignStore.readById(req.params.id, req.tenantId);
      if (!campaign) return res.status(404).json({ error: 'Campaign not found.' });
      await campaignStore.delete(req.params.id, req.tenantId);
      recordActivity({ type: 'CAMPAIGN', action: 'campaign_deleted', email: req.auth.email, detail: `Campaign "${campaign.name}" deleted` }, req.tenantId);
      res.json({ ok: true });
    } catch (err) { console.error('DELETE /api/campaigns/:id failed:', err); res.status(500).json({ error: 'Failed to delete campaign.' }); }
  });

  // ══════ SoD ══════
  app.get('/api/sod/rules', requireAdmin, async (req, res) => {
    try { res.json(await sodStore.listRules({ tenant_id: req.tenantId, severity: req.query.severity, framework: req.query.framework })); }
    catch (err) { console.error('GET /api/sod/rules failed:', err); res.status(500).json({ error: 'Failed to list SoD rules.' }); }
  });

  app.post('/api/sod/rules', requireAdmin, async (req, res) => {
    try {
      const { name, role_a, role_b, severity, description, framework } = req.body || {};
      const rule = await sodStore.createRule({ tenant_id: req.tenantId, name, role_a, role_b, severity, description, framework, created_by: req.auth.email });
      recordActivity({ type: 'SOD', action: 'sod_rule_created', email: req.auth.email, detail: `SoD rule "${rule.name}": ${rule.role_a} ↔ ${rule.role_b} (${rule.severity})` }, req.tenantId);
      res.status(201).json(rule);
    } catch (err) { console.error('POST /api/sod/rules failed:', err); res.status(400).json({ error: err.message || 'Failed to create SoD rule.' }); }
  });

  app.delete('/api/sod/rules/:id', requireAdmin, async (req, res) => {
    try { const d = await sodStore.deleteRule(req.params.id, req.tenantId); if (!d) return res.status(404).json({ error: 'Rule not found.' }); res.json({ ok: true }); }
    catch (err) { console.error('DELETE /api/sod/rules/:id failed:', err); res.status(500).json({ error: 'Failed to delete rule.' }); }
  });

  app.get('/api/sod/conflicts', async (req, res) => {
    try { res.json(await sodStore.listConflicts({ tenant_id: req.tenantId, status: req.query.status, severity: req.query.severity, approver_name: req.query.approver_name })); }
    catch (err) { console.error('GET /api/sod/conflicts failed:', err); res.status(500).json({ error: 'Failed to list conflicts.' }); }
  });

  app.patch('/api/sod/conflicts/:id', requireAdmin, async (req, res) => {
    try {
      const { status, mitigation_notes } = req.body || {};
      const conflict = await sodStore.updateConflict(req.params.id, req.tenantId, { status: status || 'mitigated', mitigated_by: req.auth.email, mitigation_notes: mitigation_notes || '' });
      if (!conflict) return res.status(404).json({ error: 'Conflict not found.' });
      recordActivity({ type: 'SOD', action: 'sod_conflict_resolved', email: req.auth.email, detail: `SoD conflict ${conflict.id} marked as ${conflict.status}: ${conflict.role_a} ↔ ${conflict.role_b}` }, req.tenantId);
      res.json(conflict);
    } catch (err) { console.error('PATCH /api/sod/conflicts/:id failed:', err); res.status(500).json({ error: 'Failed to update conflict.' }); }
  });

  app.post('/api/sod/detect', requireAdmin, async (req, res) => {
    try {
      const allConflicts = [];
      for (const approver of roleCatalogStore.listApprovers(req.tenantId)) {
        const roles = roleCatalogStore.getRolesForApprover(req.tenantId, approver.name);
        const conflicts = await sodStore.detectConflicts(req.tenantId, approver.name, roles);
        allConflicts.push(...conflicts);
      }
      if (allConflicts.length > 0) {
        const criticalCount = allConflicts.filter(c => c.severity === 'critical').length;
        createNotification({ tenant_id: req.tenantId || 'default', type: 'sod', title: `${allConflicts.length} SoD conflict(s) detected`, body: `${criticalCount} critical, ${allConflicts.length - criticalCount} high severity.`, link: '/sod.html', icon: '⚠️' });
      }
      res.json({ detected: allConflicts.length, conflicts: allConflicts });
    } catch (err) { console.error('POST /api/sod/detect failed:', err); res.status(500).json({ error: 'Failed to run SoD detection.' }); }
  });

  app.get('/api/sod/stats', async (req, res) => {
    try { res.json(await sodStore.getConflictStats(req.tenantId)); }
    catch (err) { res.json({ total: 0, open: 0, criticalOpen: 0 }); }
  });

  // ══════ EVIDENCE ══════
  app.get('/api/evidence', async (req, res) => {
    try { res.json(await evidenceStore.listAll({ ...req.query, tenant_id: req.tenantId })); }
    catch (err) { console.error('GET /api/evidence failed:', err); res.status(500).json({ error: 'Failed to list evidence packages.' }); }
  });

  app.post('/api/evidence/generate', requireAdmin, async (req, res) => {
    try {
      const { name, campaignId, description } = req.body || {};
      const submissions = await logStore.readAll({ tenantId: req.tenantId, campaignId: campaignId || undefined, limit: 1000 });
      const activityLog = await activityStore.readAll({ tenantId: req.tenantId, limit: 5000 });
      let campaign = null;
      if (campaignId) campaign = await campaignStore.readById(campaignId, req.tenantId);
      if (campaignId && !campaign) return res.status(404).json({ error: 'Campaign not found.' });
      const pkg = await evidenceStore.generate({ tenantId: req.tenantId, name: name || `Evidence_Package_${new Date().toISOString().slice(0, 10)}`, campaignId: campaignId || '', description: description || '', generatedBy: req.auth.email, submissions, activityLog, campaign });
      recordActivity({ type: 'EVIDENCE', action: 'evidence_generated', email: req.auth.email, detail: `Evidence package "${pkg.name}" generated (${(pkg.file_size / 1024).toFixed(1)} KB)` }, req.tenantId);
      createNotification({ tenant_id: req.tenantId || 'default', type: 'evidence', title: 'Evidence package ready', body: `"${pkg.name}" has been generated and is ready for auditor download.`, link: '/evidence.html', icon: '📦' });
      res.status(201).json(pkg);
    } catch (err) { console.error('POST /api/evidence/generate failed:', err); res.status(500).json({ error: 'Failed to generate evidence package.' }); }
  });

  app.get('/api/evidence/:id/download', async (req, res) => {
    try {
      const pkg = await evidenceStore.getById(req.params.id, req.tenantId);
      if (!pkg) return res.status(404).json({ error: 'Package not found.' });
      const fs = require('fs');
      if (!fs.existsSync(pkg.file_path)) return res.status(404).json({ error: 'Package file missing from disk.' });
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${pkg.name.replace(/[^a-z0-9_.-]/gi, '_')}.zip"`);
      res.setHeader('Content-Length', pkg.file_size);
      fs.createReadStream(pkg.file_path).pipe(res);
    } catch (err) { console.error('GET /api/evidence/:id/download failed:', err); res.status(500).json({ error: 'Failed to download package.' }); }
  });

  app.post('/api/evidence/:id/share', requireAdmin, async (req, res) => {
    try {
      const result = await evidenceStore.generateShareLink(req.params.id, req.tenantId);
      if (!result) return res.status(404).json({ error: 'Package not found.' });
      res.json({ shareUrl: `/api/evidence/share/${result.token}`, expiresAt: result.expiresAt });
    } catch (err) { console.error('POST /api/evidence/:id/share failed:', err); res.status(500).json({ error: 'Failed to generate share link.' }); }
  });

  app.get('/api/evidence/share/:token', async (req, res) => {
    try {
      const pkg = await evidenceStore.getByShareToken(req.params.token);
      if (!pkg) return res.status(404).type('html').send(deps.unauthorizedHtml('This share link is invalid or has expired.'));
      const fs = require('fs');
      if (!fs.existsSync(pkg.file_path)) return res.status(404).json({ error: 'Package file missing.' });
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${pkg.name.replace(/[^a-z0-9_.-]/gi, '_')}.zip"`);
      res.setHeader('Content-Length', pkg.file_size);
      fs.createReadStream(pkg.file_path).pipe(res);
    } catch (err) { console.error('GET /api/evidence/share/:token failed:', err); res.status(500).json({ error: 'Failed to download shared package.' }); }
  });

  app.delete('/api/evidence/:id', requireAdmin, async (req, res) => {
    try { const d = await evidenceStore.delete(req.params.id, req.tenantId); if (!d) return res.status(404).json({ error: 'Package not found.' }); res.json({ ok: true }); }
    catch (err) { console.error('DELETE /api/evidence/:id failed:', err); res.status(500).json({ error: 'Failed to delete package.' }); }
  });
};

// routes/compliance.js — Campaigns, SoD, Evidence Locker
module.exports = function register(deps) {
  const { app, campaignStore, sodStore, evidenceStore, logStore, activityStore, roleCatalogStore, requireCapability, CAPABILITIES, recordActivity, createNotification } = deps;
  const { VALID_STATUSES, VALID_FRAMEWORKS } = require('../stores/campaignStore');
  const CAMPAIGN_TRANSITIONS = {
    draft: new Set(['draft', 'active']),
    active: new Set(['active', 'completed']),
    completed: new Set(['completed', 'archived']),
    archived: new Set(['archived']),
  };

  function validateApprovers(tenantId, approvers) {
    if (!Array.isArray(approvers)) return { error: 'approvers must be an array.' };
    const unique = [...new Set(approvers.map(value => String(value || '').trim()).filter(Boolean))];
    const known = new Set(roleCatalogStore.listApprovers(tenantId).map(item => item.name));
    const unknown = unique.filter(name => !known.has(name));
    if (unknown.length) return { error: `Unknown approver(s): ${unknown.join(', ')}` };
    return { value: unique };
  }

  function validDate(value) {
    return !value || /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
  }

  // ══════ CAMPAIGNS ══════
  app.post('/api/campaigns', requireCapability(CAPABILITIES.CAMPAIGN_MANAGE), async (req, res) => {
    try {
      const context = req.context;
      const { name, description, framework, period, deadline, approvers } = req.body || {};
      if (!name || !name.trim()) return res.status(400).json({ error: 'Campaign name is required.' });
      if (!period || !period.trim()) return res.status(400).json({ error: 'Period is required (e.g. Q3 2026).' });
      if (framework && !VALID_FRAMEWORKS.includes(framework)) return res.status(422).json({ error: 'Invalid framework.' });
      if (!validDate(deadline)) return res.status(422).json({ error: 'deadline must use YYYY-MM-DD.' });
      const approverValidation = validateApprovers(context.tenantId, approvers || []);
      if (approverValidation.error) return res.status(422).json({ error: approverValidation.error });
      const campaign = await campaignStore.create({ tenant_id: context.tenantId, name: name.trim(), description: description || '', framework: framework || 'SOX', period: period.trim(), deadline: deadline || '', approvers: approverValidation.value, created_by: context.email, status: 'draft' });
      recordActivity({ type: 'CAMPAIGN', action: 'campaign_created', email: context.email, detail: `Campaign "${campaign.name}" created (${campaign.id})` }, context);
      createNotification({ tenant_id: context.tenantId, type: 'campaign', title: 'New campaign created', body: `"${campaign.name}" is ready for review.`, link: '/campaigns.html', icon: '📋' });
      res.status(201).json(campaign);
    } catch (err) { console.error('POST /api/campaigns failed:', err); res.status(500).json({ error: 'Failed to create campaign.' }); }
  });

  app.get('/api/campaigns', requireCapability(CAPABILITIES.CAMPAIGN_READ), async (req, res) => {
    try {
      const filters = { tenant_id: req.context.tenantId };
      if (req.query.status) filters.status = req.query.status;
      if (req.query.framework) filters.framework = req.query.framework;
      if (req.query.limit) filters.limit = Math.min(Number(req.query.limit), 100);
      const campaigns = await campaignStore.readAll(filters);
      const enriched = await Promise.all(campaigns.map(async campaign => {
        const scopedRoles = new Set();
        campaign.approvers.forEach(approver => {
          roleCatalogStore.getRolesForApprover(req.context.tenantId, approver).forEach(role => scopedRoles.add(role));
        });
        const progress = await campaignStore.getProgress(campaign.id, req.context.tenantId);
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

  app.get('/api/campaigns/:id', requireCapability(CAPABILITIES.CAMPAIGN_READ), async (req, res) => {
    try {
      const campaign = await campaignStore.readById(req.params.id, req.context.tenantId);
      if (!campaign) return res.status(404).json({ error: 'Campaign not found.' });
      const progress = await campaignStore.getProgress(req.params.id, req.context.tenantId);
      const enrichedApprovers = campaign.approvers.map(name => {
        const approverRoles = roleCatalogStore.getRolesForApprover(req.context.tenantId, name);
        const progressInfo = (progress && progress.approverProgress.find(p => p.approver === name)) || {};
        return { name, totalRoles: approverRoles.length, roles: approverRoles, reviewedCount: progressInfo.reviewedCount || 0, reviewedRoles: progressInfo.reviewedRoles || [] };
      });
      const totalRoles = new Set(enrichedApprovers.flatMap(item => item.roles)).size;
      const totalReviewed = progress ? progress.totalReviewed : 0;
      res.json({ ...campaign, approvers: enrichedApprovers, totalRoles, totalReviewed, progress: totalRoles > 0 ? Math.round((totalReviewed / totalRoles) * 100) : 0 });
    } catch (err) { console.error('GET /api/campaigns/:id failed:', err); res.status(500).json({ error: 'Failed to load campaign.' }); }
  });

  app.patch('/api/campaigns/:id', requireCapability(CAPABILITIES.CAMPAIGN_MANAGE), async (req, res) => {
    try {
      const context = req.context;
      const existing = await campaignStore.readById(req.params.id, context.tenantId);
      if (!existing) return res.status(404).json({ error: 'Campaign not found.' });
      const { name, description, framework, period, status, deadline, approvers } = req.body || {};
      if (name !== undefined && !String(name).trim()) return res.status(422).json({ error: 'Campaign name cannot be empty.' });
      if (period !== undefined && !String(period).trim()) return res.status(422).json({ error: 'Campaign period cannot be empty.' });
      if (framework !== undefined && !VALID_FRAMEWORKS.includes(framework)) return res.status(422).json({ error: 'Invalid framework.' });
      if (status !== undefined && (!VALID_STATUSES.includes(status) || !CAMPAIGN_TRANSITIONS[existing.status].has(status))) {
        return res.status(409).json({ error: `Invalid campaign transition: ${existing.status} → ${status}.` });
      }
      if (deadline !== undefined && !validDate(deadline)) return res.status(422).json({ error: 'deadline must use YYYY-MM-DD.' });
      const updates = {};
      if (name !== undefined) updates.name = name;
      if (description !== undefined) updates.description = description;
      if (framework !== undefined) updates.framework = framework;
      if (period !== undefined) updates.period = period;
      if (status !== undefined) updates.status = status;
      if (deadline !== undefined) updates.deadline = deadline;
      if (approvers !== undefined) {
        const validation = validateApprovers(context.tenantId, approvers);
        if (validation.error) return res.status(422).json({ error: validation.error });
        updates.approvers = validation.value;
      }
      const campaign = await campaignStore.update(req.params.id, context.tenantId, updates);
      if (!campaign) return res.status(404).json({ error: 'Campaign not found.' });
      recordActivity({ type: 'CAMPAIGN', action: 'campaign_updated', email: context.email, detail: `Campaign "${campaign.name}" updated (status: ${campaign.status})` }, context);
      if (updates.status) {
        const statusLabels = { active: 'activated', completed: 'completed', archived: 'archived', draft: 'set to draft' };
        createNotification({ tenant_id: context.tenantId, type: 'campaign', title: `Campaign ${statusLabels[updates.status] || 'updated'}`, body: `"${campaign.name}" was ${statusLabels[updates.status] || 'updated'}.`, link: '/campaigns.html', icon: '📋' });
      }
      res.json(campaign);
    } catch (err) { console.error('PATCH /api/campaigns/:id failed:', err); res.status(500).json({ error: 'Failed to update campaign.' }); }
  });

  app.delete('/api/campaigns/:id', requireCapability(CAPABILITIES.CAMPAIGN_MANAGE), async (req, res) => {
    try {
      const campaign = await campaignStore.readById(req.params.id, req.context.tenantId);
      if (!campaign) return res.status(404).json({ error: 'Campaign not found.' });
      if (campaign.status !== 'draft') return res.status(409).json({ error: 'Only draft campaigns can be deleted.' });
      const submissions = await logStore.readAll({ tenantId: req.context.tenantId, campaignId: campaign.id, limit: 1 });
      if (submissions.length) return res.status(409).json({ error: 'Campaigns with decisions cannot be deleted.' });
      const evidence = await evidenceStore.listAll({ tenant_id: req.context.tenantId, campaign_id: campaign.id });
      if (evidence.length) return res.status(409).json({ error: 'Campaigns with evidence packages cannot be deleted.' });
      await campaignStore.delete(req.params.id, req.context.tenantId);
      recordActivity({ type: 'CAMPAIGN', action: 'campaign_deleted', email: req.context.email, detail: `Campaign "${campaign.name}" deleted` }, req.context);
      res.json({ ok: true });
    } catch (err) { console.error('DELETE /api/campaigns/:id failed:', err); res.status(500).json({ error: 'Failed to delete campaign.' }); }
  });

  // ══════ SoD ══════
  app.get('/api/sod/rules', requireCapability(CAPABILITIES.SOD_READ), async (req, res) => {
    try { res.json(await sodStore.listRules({ tenant_id: req.context.tenantId, severity: req.query.severity, framework: req.query.framework })); }
    catch (err) { console.error('GET /api/sod/rules failed:', err); res.status(500).json({ error: 'Failed to list SoD rules.' }); }
  });

  app.post('/api/sod/rules', requireCapability(CAPABILITIES.SOD_MANAGE), async (req, res) => {
    try {
      const { name, role_a, role_b, severity, description, framework } = req.body || {};
      if (framework && !VALID_FRAMEWORKS.includes(framework)) return res.status(422).json({ error: 'Invalid framework.' });
      const knownRoles = new Set(roleCatalogStore.listRoleNames(req.context.tenantId));
      if (!knownRoles.has(String(role_a || '').trim()) || !knownRoles.has(String(role_b || '').trim())) {
        return res.status(422).json({ error: 'Both SoD entitlements must exist in the active tenant catalog.' });
      }
      const rule = await sodStore.createRule({ tenant_id: req.context.tenantId, name, role_a, role_b, severity, description, framework, created_by: req.context.email });
      recordActivity({ type: 'SOD', action: 'sod_rule_created', email: req.context.email, detail: `SoD rule "${rule.name}": ${rule.role_a} ↔ ${rule.role_b} (${rule.severity})` }, req.context);
      res.status(201).json(rule);
    } catch (err) {
      console.error('POST /api/sod/rules failed:', err);
      const status = err.code === 'DUPLICATE_SOD_RULE' ? 409 : 422;
      res.status(status).json({ error: err.message || 'Failed to create SoD rule.', code: err.code || 'INVALID_SOD_RULE' });
    }
  });

  app.delete('/api/sod/rules/:id', requireCapability(CAPABILITIES.SOD_MANAGE), async (req, res) => {
    try { const d = await sodStore.archiveRule(req.params.id, req.context.tenantId); if (!d) return res.status(404).json({ error: 'Rule not found.' }); res.json({ ok: true, status: 'archived' }); }
    catch (err) { console.error('DELETE /api/sod/rules/:id failed:', err); res.status(500).json({ error: 'Failed to delete rule.' }); }
  });

  app.get('/api/sod/conflicts', requireCapability(CAPABILITIES.SOD_READ), async (req, res) => {
    try { res.json(await sodStore.listConflicts({ tenant_id: req.context.tenantId, status: req.query.status, severity: req.query.severity, subject_id: req.query.subject_id, approver_name: req.query.approver_name })); }
    catch (err) { console.error('GET /api/sod/conflicts failed:', err); res.status(500).json({ error: 'Failed to list conflicts.' }); }
  });

  app.patch('/api/sod/conflicts/:id', requireCapability(CAPABILITIES.SOD_MANAGE), async (req, res) => {
    try {
      const { status, resolution_reason, resolution_owner, resolution_expires_at, resolution_evidence } = req.body || {};
      if (status === 'risk_accepted' && req.context.role !== 'admin') {
        return res.status(403).json({ error: 'Risk acceptance requires tenant administrator approval.' });
      }
      const conflict = await sodStore.resolveConflict(req.params.id, req.context.tenantId, {
        status,
        reason: resolution_reason,
        owner: resolution_owner,
        expiresAt: resolution_expires_at,
        evidence: resolution_evidence,
        actor: req.context.email,
      });
      if (!conflict) return res.status(404).json({ error: 'Conflict not found.' });
      recordActivity({ type: 'SOD', action: 'sod_conflict_transitioned', email: req.context.email, detail: `SoD conflict ${conflict.id} moved to ${conflict.status} for subject ${conflict.subject_name || conflict.user_email}` }, req.context);
      res.json(conflict);
    } catch (err) {
      console.error('PATCH /api/sod/conflicts/:id failed:', err);
      const statusCode = err.code === 'INVALID_SOD_TRANSITION' ? 409 : err.code && err.code.startsWith('INVALID_SOD_') ? 422 : 500;
      res.status(statusCode).json({ error: err.message || 'Failed to update conflict.', code: err.code || 'SOD_UPDATE_FAILED' });
    }
  });

  app.get('/api/sod/conflicts/:id/history', requireCapability(CAPABILITIES.SOD_READ), async (req, res) => {
    try {
      const conflict = await sodStore.getConflict(req.params.id, req.context.tenantId);
      if (!conflict) return res.status(404).json({ error: 'Conflict not found.' });
      res.json(await sodStore.listResolutionEvents(req.params.id, req.context.tenantId));
    } catch (err) { console.error('GET /api/sod/conflicts/:id/history failed:', err); res.status(500).json({ error: 'Failed to load resolution history.' }); }
  });

  app.get('/api/sod/access-assignments', requireCapability(CAPABILITIES.SOD_READ), async (req, res) => {
    try { res.json(await sodStore.listEffectiveAssignments(req.context.tenantId, req.query.subject_id)); }
    catch (err) { console.error('GET /api/sod/access-assignments failed:', err); res.status(500).json({ error: 'Failed to load effective assignments.' }); }
  });

  app.post('/api/sod/detect', requireCapability(CAPABILITIES.SOD_MANAGE), async (req, res) => {
    try {
      const result = await sodStore.detectConflicts(req.context.tenantId);
      const changed = [...result.created, ...result.reopened];
      if (changed.length > 0) {
        const criticalCount = changed.filter(c => c.severity === 'critical').length;
        createNotification({ tenant_id: req.context.tenantId, type: 'sod', title: `${changed.length} SoD conflict(s) require review`, body: `${criticalCount} critical; evaluated against effective subject assignments.`, link: '/sod.html', icon: '⚠️' });
      }
      res.json({ detected: changed.length, created: result.created.length, reopened: result.reopened.length, evaluated: result.evaluated, conflicts: changed });
    } catch (err) { console.error('POST /api/sod/detect failed:', err); res.status(500).json({ error: 'Failed to run SoD detection.' }); }
  });

  app.get('/api/sod/stats', requireCapability(CAPABILITIES.SOD_READ), async (req, res) => {
    try { res.json(await sodStore.getConflictStats(req.context.tenantId)); }
    catch (err) { console.error('GET /api/sod/stats failed:', err); res.status(500).json({ error: 'Failed to load SoD stats.' }); }
  });

  // ══════ EVIDENCE ══════
  app.get('/api/evidence', requireCapability(CAPABILITIES.EVIDENCE_READ), async (req, res) => {
    try { res.json(await evidenceStore.listAll({ ...req.query, tenant_id: req.context.tenantId })); }
    catch (err) { console.error('GET /api/evidence failed:', err); res.status(500).json({ error: 'Failed to list evidence packages.' }); }
  });

  app.post('/api/evidence/generate', requireCapability(CAPABILITIES.EVIDENCE_MANAGE), async (req, res) => {
    try {
      const { name, campaignId, description } = req.body || {};
      const submissions = await logStore.readAll({ tenantId: req.context.tenantId, campaignId: campaignId || undefined, limit: 1000 });
      const activityLog = await activityStore.readAll({ tenantId: req.context.tenantId, limit: 5000 });
      let campaign = null;
      if (campaignId) campaign = await campaignStore.readById(campaignId, req.context.tenantId);
      if (campaignId && !campaign) return res.status(404).json({ error: 'Campaign not found.' });
      const pkg = await evidenceStore.generate({ tenantId: req.context.tenantId, name: name || `Evidence_Package_${new Date().toISOString().slice(0, 10)}`, campaignId: campaignId || '', description: description || '', generatedBy: req.context.email, submissions, activityLog, campaign });
      recordActivity({ type: 'EVIDENCE', action: 'evidence_generated', email: req.context.email, detail: `Evidence package "${pkg.name}" generated (${(pkg.file_size / 1024).toFixed(1)} KB)` }, req.context);
      createNotification({ tenant_id: req.context.tenantId, type: 'evidence', title: 'Evidence package ready', body: `"${pkg.name}" has been generated and is ready for auditor download.`, link: '/evidence.html', icon: '📦' });
      res.status(201).json(pkg);
    } catch (err) { console.error('POST /api/evidence/generate failed:', err); res.status(500).json({ error: 'Failed to generate evidence package.' }); }
  });

  app.get('/api/evidence/:id/download', requireCapability(CAPABILITIES.EVIDENCE_DOWNLOAD), async (req, res) => {
    try {
      const pkg = await evidenceStore.getById(req.params.id, req.context.tenantId);
      if (!pkg) return res.status(404).json({ error: 'Package not found.' });
      const fs = require('fs');
      if (!fs.existsSync(pkg.file_path)) return res.status(404).json({ error: 'Package file missing from disk.' });
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${pkg.name.replace(/[^a-z0-9_.-]/gi, '_')}.zip"`);
      res.setHeader('Content-Length', pkg.file_size);
      fs.createReadStream(pkg.file_path).pipe(res);
    } catch (err) { console.error('GET /api/evidence/:id/download failed:', err); res.status(500).json({ error: 'Failed to download package.' }); }
  });

  app.post('/api/evidence/:id/share', requireCapability(CAPABILITIES.EVIDENCE_MANAGE), async (req, res) => {
    try {
      const result = await evidenceStore.generateShareLink(req.params.id, req.context.tenantId);
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

  app.delete('/api/evidence/:id', requireCapability(CAPABILITIES.EVIDENCE_MANAGE), async (req, res) => {
    try { const d = await evidenceStore.delete(req.params.id, req.context.tenantId); if (!d) return res.status(404).json({ error: 'Package not found.' }); res.json({ ok: true }); }
    catch (err) { console.error('DELETE /api/evidence/:id failed:', err); res.status(500).json({ error: 'Failed to delete package.' }); }
  });
};

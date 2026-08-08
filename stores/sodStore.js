// Tenant-scoped SoD engine evaluated against effective subject/account/entitlement
// assignments. Review owners are metadata; they are never treated as the subject.

const crypto = require('crypto');
const { getDb } = require('./db');

const VALID_SEVERITIES = Object.freeze(['critical', 'high', 'medium', 'low']);
const VALID_CONFLICT_STATUSES = Object.freeze(['open', 'mitigated', 'risk_accepted', 'false_positive']);
const STATUS_TRANSITIONS = Object.freeze({
  open: new Set(['mitigated', 'risk_accepted', 'false_positive']),
  mitigated: new Set(['open']),
  risk_accepted: new Set(['open']),
  false_positive: new Set(['open']),
});

function newId(prefix) {
  return `${prefix || 'sod_'}${crypto.randomUUID().slice(0, 12)}`;
}

function requireTenantId(value) {
  const tenantId = String(value || '').trim();
  if (!tenantId) throw domainError('TENANT_REQUIRED', 'tenantId is required.');
  return tenantId;
}

function domainError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isFutureIso(value) {
  const timestamp = Date.parse(String(value || ''));
  return Number.isFinite(timestamp) && timestamp > Date.now();
}

class SodStore {
  constructor() {
    this.db = getDb();
  }

  async createRule(rule) {
    const tenantId = requireTenantId(rule && rule.tenant_id);
    const normalized = {
      id: rule.id || newId('rule_'),
      tenant_id: tenantId,
      name: String(rule.name || '').trim(),
      role_a: String(rule.role_a || '').trim(),
      role_b: String(rule.role_b || '').trim(),
      severity: String(rule.severity || 'high').trim(),
      description: String(rule.description || '').trim(),
      framework: String(rule.framework || 'SOX').trim(),
      status: 'active',
      created_by: String(rule.created_by || '').trim(),
      created_at: new Date().toISOString(),
    };
    if (!normalized.name || !normalized.role_a || !normalized.role_b) {
      throw domainError('INVALID_SOD_RULE', 'Rule name, role_a, and role_b are required.');
    }
    if (normalized.role_a === normalized.role_b) {
      throw domainError('INVALID_SOD_RULE', 'A SoD rule must compare two different entitlements.');
    }
    if (!VALID_SEVERITIES.includes(normalized.severity)) {
      throw domainError('INVALID_SOD_RULE', 'Invalid SoD severity.');
    }
    if (normalized.role_a > normalized.role_b) {
      [normalized.role_a, normalized.role_b] = [normalized.role_b, normalized.role_a];
    }
    const duplicate = this.db.prepare(`
      SELECT id FROM sod_rules WHERE tenant_id = ? AND role_a = ? AND role_b = ?
    `).get(tenantId, normalized.role_a, normalized.role_b);
    if (duplicate) throw domainError('DUPLICATE_SOD_RULE', 'An SoD rule already covers this entitlement pair.');
    this.db.prepare(`
      INSERT INTO sod_rules
        (id, tenant_id, name, role_a, role_b, severity, description, framework,
         created_by, created_at, status, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)
    `).run(normalized.id, tenantId, normalized.name, normalized.role_a, normalized.role_b,
      normalized.severity, normalized.description, normalized.framework,
      normalized.created_by, normalized.created_at, normalized.created_at);
    return normalized;
  }

  async listRules(filters = {}) {
    let sql = 'SELECT * FROM sod_rules WHERE tenant_id = ?';
    const params = [requireTenantId(filters.tenant_id)];
    if (filters.status) { sql += ' AND status = ?'; params.push(filters.status); }
    else if (!filters.include_archived) sql += " AND status = 'active'";
    if (filters.severity) { sql += ' AND severity = ?'; params.push(filters.severity); }
    if (filters.framework) { sql += ' AND framework = ?'; params.push(filters.framework); }
    sql += ' ORDER BY created_at DESC';
    return this.db.prepare(sql).all(...params).map(row => this._ruleRow(row));
  }

  async getRule(id, tenantId) {
    const row = this.db.prepare('SELECT * FROM sod_rules WHERE id = ? AND tenant_id = ?')
      .get(String(id || ''), requireTenantId(tenantId));
    return row ? this._ruleRow(row) : null;
  }

  async archiveRule(id, tenantId) {
    const tid = requireTenantId(tenantId);
    const result = this.db.prepare(`
      UPDATE sod_rules SET status = 'archived', updated_at = ?
      WHERE id = ? AND tenant_id = ? AND status = 'active'
    `).run(new Date().toISOString(), String(id || ''), tid);
    return result.changes > 0;
  }

  async detectConflicts(tenantId) {
    const tid = requireTenantId(tenantId);
    const now = new Date().toISOString();
    const evaluations = this.db.prepare(`
      SELECT
        r.id AS rule_id, r.name AS rule_name, r.role_a, r.role_b, r.severity,
        s.id AS subject_id, s.email AS user_email, s.display_name AS subject_name,
        aa.id AS assignment_a_id, ab.id AS assignment_b_id,
        aa.source_snapshot_id,
        aca.account_name AS account_a, acb.account_name AS account_b,
        apa.name AS application_a, apb.name AS application_b,
        aa.review_owner_name AS owner_a, ab.review_owner_name AS owner_b
      FROM sod_rules r
      JOIN access_entitlements ea
        ON ea.tenant_id = r.tenant_id AND ea.name = r.role_a AND ea.status = 'active'
      JOIN access_entitlement_assignments aa
        ON aa.tenant_id = r.tenant_id AND aa.entitlement_id = ea.id AND aa.status = 'active'
      JOIN access_entitlement_assignments ab
        ON ab.tenant_id = aa.tenant_id AND ab.subject_id = aa.subject_id
       AND ab.source_snapshot_id = aa.source_snapshot_id AND ab.status = 'active'
      JOIN access_entitlements eb
        ON eb.tenant_id = r.tenant_id AND eb.id = ab.entitlement_id
       AND eb.name = r.role_b AND eb.status = 'active'
      JOIN access_subjects s
        ON s.tenant_id = aa.tenant_id AND s.id = aa.subject_id AND s.status = 'active'
      JOIN access_accounts aca
        ON aca.tenant_id = aa.tenant_id AND aca.id = aa.account_id AND aca.status = 'active'
      JOIN access_accounts acb
        ON acb.tenant_id = ab.tenant_id AND acb.id = ab.account_id AND acb.status = 'active'
      JOIN access_applications apa
        ON apa.tenant_id = aca.tenant_id AND apa.id = aca.application_id AND apa.status = 'active'
      JOIN access_applications apb
        ON apb.tenant_id = acb.tenant_id AND apb.id = acb.application_id AND apb.status = 'active'
      WHERE r.tenant_id = ? AND r.status = 'active'
        AND aa.valid_from <= ? AND (aa.valid_to = '' OR aa.valid_to > ?)
        AND ab.valid_from <= ? AND (ab.valid_to = '' OR ab.valid_to > ?)
    `).all(tid, now, now, now, now);

    const created = [];
    const reopened = [];
    const insert = this.db.prepare(`
      INSERT INTO sod_conflicts
        (id, tenant_id, rule_id, user_email, approver_name, role_a, role_b, severity,
         detected_at, status, mitigated_by, mitigated_at, mitigation_notes,
         subject_id, subject_name, assignment_a_id, assignment_b_id, source_snapshot_id,
         resolution_reason, resolution_owner, resolution_expires_at, resolution_evidence,
         approved_by, approved_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', '', '', '', ?, ?, ?, ?, ?, '', '', '', '', '', '', ?)
    `);
    const tx = this.db.transaction(rows => {
      for (const row of rows) {
        const existing = this.db.prepare(`
          SELECT * FROM sod_conflicts
          WHERE tenant_id = ? AND rule_id = ? AND subject_id = ? AND source_snapshot_id = ?
        `).get(tid, row.rule_id, row.subject_id, row.source_snapshot_id);
        if (!existing) {
          const conflict = {
            id: newId('conf_'), tenant_id: tid, ...row, status: 'open', detected_at: now,
            approver_name: row.owner_a || row.owner_b || '',
          };
          insert.run(conflict.id, tid, row.rule_id, row.user_email, conflict.approver_name,
            row.role_a, row.role_b, row.severity, now, row.subject_id, row.subject_name,
            row.assignment_a_id, row.assignment_b_id, row.source_snapshot_id, now);
          created.push(conflict);
          continue;
        }
        if (existing.status !== 'open' && existing.resolution_expires_at && Date.parse(existing.resolution_expires_at) <= Date.now()) {
          this._transition(existing, {
            status: 'open', reason: 'Resolution expired; conflict reopened by the SoD engine.',
            owner: 'system:sod-engine', evidence: existing.resolution_evidence || '', actor: 'system:sod-engine',
          });
          reopened.push(this.db.prepare('SELECT * FROM sod_conflicts WHERE id = ? AND tenant_id = ?').get(existing.id, tid));
        }
      }
    });
    tx(evaluations);
    return {
      evaluated: evaluations.length,
      created: created.map(row => this._conflictRow(row)),
      reopened: reopened.map(row => this._conflictRow(row)),
    };
  }

  async listConflicts(filters = {}) {
    let sql = `
      SELECT c.*, aa.account_name AS account_a, ab.account_name AS account_b,
             apa.name AS application_a, apb.name AS application_b
      FROM sod_conflicts c
      LEFT JOIN access_entitlement_assignments asa
        ON asa.tenant_id = c.tenant_id AND asa.id = c.assignment_a_id
      LEFT JOIN access_entitlement_assignments asb
        ON asb.tenant_id = c.tenant_id AND asb.id = c.assignment_b_id
      LEFT JOIN access_accounts aa ON aa.tenant_id = c.tenant_id AND aa.id = asa.account_id
      LEFT JOIN access_accounts ab ON ab.tenant_id = c.tenant_id AND ab.id = asb.account_id
      LEFT JOIN access_applications apa ON apa.tenant_id = c.tenant_id AND apa.id = aa.application_id
      LEFT JOIN access_applications apb ON apb.tenant_id = c.tenant_id AND apb.id = ab.application_id
      WHERE c.tenant_id = ?`;
    const params = [requireTenantId(filters.tenant_id)];
    if (filters.status) { sql += ' AND c.status = ?'; params.push(filters.status); }
    if (filters.severity) { sql += ' AND c.severity = ?'; params.push(filters.severity); }
    if (filters.subject_id) { sql += ' AND c.subject_id = ?'; params.push(filters.subject_id); }
    if (filters.approver_name) { sql += ' AND c.approver_name = ?'; params.push(filters.approver_name); }
    sql += ' ORDER BY c.detected_at DESC';
    return this.db.prepare(sql).all(...params).map(row => this._conflictRow(row));
  }

  async getConflict(id, tenantId) {
    const rows = await this.listConflicts({ tenant_id: requireTenantId(tenantId) });
    return rows.find(row => row.id === String(id || '')) || null;
  }

  async resolveConflict(id, tenantId, resolution) {
    const tid = requireTenantId(tenantId);
    const existing = this.db.prepare('SELECT * FROM sod_conflicts WHERE id = ? AND tenant_id = ?')
      .get(String(id || ''), tid);
    if (!existing) return null;
    const target = String(resolution.status || '').trim();
    if (!VALID_CONFLICT_STATUSES.includes(target)) {
      throw domainError('INVALID_SOD_STATUS', 'Invalid SoD conflict status.');
    }
    if (target === existing.status) throw domainError('INVALID_SOD_TRANSITION', 'The conflict is already in that status.');
    if (!STATUS_TRANSITIONS[existing.status] || !STATUS_TRANSITIONS[existing.status].has(target)) {
      throw domainError('INVALID_SOD_TRANSITION', `Invalid SoD transition: ${existing.status} -> ${target}.`);
    }
    const reason = String(resolution.reason || '').trim();
    const owner = String(resolution.owner || '').trim();
    const evidence = String(resolution.evidence || '').trim();
    const expiresAt = String(resolution.expiresAt || '').trim();
    const actor = String(resolution.actor || '').trim();
    if (!reason || !owner) throw domainError('INVALID_SOD_RESOLUTION', 'Resolution reason and owner are required.');
    if ((target === 'mitigated' || target === 'risk_accepted') && !evidence) {
      throw domainError('INVALID_SOD_RESOLUTION', 'Mitigation and risk acceptance require an evidence reference.');
    }
    if ((target === 'mitigated' || target === 'risk_accepted') && !isFutureIso(expiresAt)) {
      throw domainError('INVALID_SOD_RESOLUTION', 'Mitigation and risk acceptance require a future expiry/review date.');
    }
    this._transition(existing, { status: target, reason, owner, evidence, expiresAt, actor });
    return this.getConflict(id, tid);
  }

  _transition(existing, resolution) {
    const now = new Date().toISOString();
    const resolved = resolution.status !== 'open';
    const approvedBy = resolution.status === 'risk_accepted' ? resolution.actor : '';
    const eventId = newId('sod_evt_');
    this.db.prepare(`
      INSERT INTO sod_resolution_events
        (id, tenant_id, conflict_id, from_status, to_status, reason, owner,
         expires_at, evidence_ref, actor, approved_by, approved_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(eventId, existing.tenant_id, existing.id, existing.status, resolution.status,
      resolution.reason, resolution.owner, resolution.expiresAt || '', resolution.evidence || '',
      resolution.actor || '', approvedBy, approvedBy ? now : '', now);
    this.db.prepare(`
      UPDATE sod_conflicts
      SET status = ?, resolution_reason = ?, resolution_owner = ?, resolution_expires_at = ?,
          resolution_evidence = ?, approved_by = ?, approved_at = ?,
          mitigated_by = ?, mitigated_at = ?, mitigation_notes = ?, updated_at = ?
      WHERE id = ? AND tenant_id = ?
    `).run(resolution.status, resolution.reason, resolution.owner, resolution.expiresAt || '',
      resolution.evidence || '', approvedBy, approvedBy ? now : '', resolved ? resolution.actor : '',
      resolved ? now : '', resolution.reason, now, existing.id, existing.tenant_id);
  }

  async listResolutionEvents(conflictId, tenantId) {
    return this.db.prepare(`
      SELECT * FROM sod_resolution_events
      WHERE tenant_id = ? AND conflict_id = ? ORDER BY created_at DESC
    `).all(requireTenantId(tenantId), String(conflictId || ''));
  }

  async listEffectiveAssignments(tenantId, subjectId) {
    const tid = requireTenantId(tenantId);
    let sql = `
      SELECT a.id, a.subject_id, s.display_name AS subject_name, s.email,
             a.account_id, ac.account_name, e.id AS entitlement_id, e.name AS entitlement_name,
             ap.id AS application_id, ap.name AS application_name, a.status, a.valid_from,
             a.valid_to, a.source_snapshot_id, a.review_owner_name
      FROM access_entitlement_assignments a
      JOIN access_subjects s ON s.tenant_id = a.tenant_id AND s.id = a.subject_id
      JOIN access_accounts ac ON ac.tenant_id = a.tenant_id AND ac.id = a.account_id
      JOIN access_entitlements e ON e.tenant_id = a.tenant_id AND e.id = a.entitlement_id
      JOIN access_applications ap ON ap.tenant_id = a.tenant_id AND ap.id = ac.application_id
      WHERE a.tenant_id = ?`;
    const params = [tid];
    if (subjectId) { sql += ' AND a.subject_id = ?'; params.push(String(subjectId)); }
    sql += ' ORDER BY s.display_name, ap.name, e.name';
    return this.db.prepare(sql).all(...params);
  }

  async getConflictStats(tenantId) {
    const tid = requireTenantId(tenantId);
    const rows = this.db.prepare(`
      SELECT status, COUNT(*) AS count FROM sod_conflicts WHERE tenant_id = ? GROUP BY status
    `).all(tid);
    const counts = Object.fromEntries(rows.map(row => [row.status, row.count]));
    const critical = this.db.prepare(`
      SELECT COUNT(*) AS count FROM sod_conflicts
      WHERE tenant_id = ? AND severity = 'critical' AND status = 'open'
    `).get(tid);
    return {
      total: Object.values(counts).reduce((sum, value) => sum + value, 0),
      open: counts.open || 0,
      criticalOpen: critical ? critical.count : 0,
      mitigated: counts.mitigated || 0,
      riskAccepted: counts.risk_accepted || 0,
      falsePositive: counts.false_positive || 0,
    };
  }

  _ruleRow(row) {
    return {
      id: row.id, tenant_id: row.tenant_id, name: row.name, role_a: row.role_a,
      role_b: row.role_b, severity: row.severity, description: row.description,
      framework: row.framework, status: row.status || 'active', created_by: row.created_by,
      created_at: row.created_at, updated_at: row.updated_at || row.created_at,
    };
  }

  _conflictRow(row) {
    return {
      id: row.id, tenant_id: row.tenant_id, rule_id: row.rule_id,
      subject_id: row.subject_id || '', subject_name: row.subject_name || '',
      user_email: row.user_email || '', approver_name: row.approver_name || '',
      role_a: row.role_a, role_b: row.role_b, severity: row.severity,
      assignment_a_id: row.assignment_a_id || '', assignment_b_id: row.assignment_b_id || '',
      application_a: row.application_a || '', application_b: row.application_b || '',
      account_a: row.account_a || '', account_b: row.account_b || '',
      source_snapshot_id: row.source_snapshot_id || '', detected_at: row.detected_at,
      status: row.status, resolution_reason: row.resolution_reason || row.mitigation_notes || '',
      resolution_owner: row.resolution_owner || '', resolution_expires_at: row.resolution_expires_at || '',
      resolution_evidence: row.resolution_evidence || '', approved_by: row.approved_by || '',
      approved_at: row.approved_at || '', updated_at: row.updated_at || row.detected_at,
    };
  }
}

function createSodStore() {
  return new SodStore();
}

module.exports = {
  createSodStore,
  VALID_SEVERITIES,
  VALID_CONFLICT_STATUSES,
  STATUS_TRANSITIONS,
};

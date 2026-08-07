// Persistence layer for Segregation of Duties (SoD) rules and conflicts.
// Phase 3 — SoD Engine

const crypto = require('crypto');
const { getDb } = require('./db');

const VALID_SEVERITIES = ['critical', 'high', 'medium', 'low'];
const VALID_CONFLICT_STATUSES = ['open', 'mitigated', 'false_positive'];

function newId(prefix) {
  return (prefix || 'sod_') + crypto.randomUUID().slice(0, 8);
}

class SodStore {
  constructor() {
    this.db = getDb();
  }

  // ────────── RULES ──────────

  async createRule(rule) {
    const r = {
      id: rule.id || newId('rule_'),
      tenant_id: rule.tenant_id || 'default',
      name: String(rule.name || '').trim(),
      role_a: String(rule.role_a || '').trim(),
      role_b: String(rule.role_b || '').trim(),
      severity: VALID_SEVERITIES.includes(rule.severity) ? rule.severity : 'high',
      description: String(rule.description || '').trim(),
      framework: String(rule.framework || 'SOX').trim(),
      created_by: String(rule.created_by || '').trim(),
      created_at: new Date().toISOString(),
    };

    if (!r.name || !r.role_a || !r.role_b) {
      throw new Error('Rule name, role_a, and role_b are required.');
    }

    // Normalize: sort roles alphabetically so rule A+B == B+A
    if (r.role_a > r.role_b) {
      [r.role_a, r.role_b] = [r.role_b, r.role_a];
    }

    this.db.prepare(`
      INSERT INTO sod_rules (id, tenant_id, name, role_a, role_b, severity, description, framework, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(r.id, r.tenant_id, r.name, r.role_a, r.role_b, r.severity, r.description, r.framework, r.created_by, r.created_at);

    return r;
  }

  async listRules(filters = {}) {
    let sql = 'SELECT * FROM sod_rules WHERE 1=1';
    const params = [];
    if (filters.severity) { sql += ' AND severity = ?'; params.push(filters.severity); }
    if (filters.framework) { sql += ' AND framework = ?'; params.push(filters.framework); }
    sql += ' ORDER BY created_at DESC';
    const rows = this.db.prepare(sql).all(...params);
    return rows.map(r => this._ruleRow(r));
  }

  async getRule(id) {
    const row = this.db.prepare('SELECT * FROM sod_rules WHERE id = ?').get(id);
    return row ? this._ruleRow(row) : null;
  }

  async deleteRule(id) {
    // Delete associated conflicts too
    this.db.prepare('DELETE FROM sod_conflicts WHERE rule_id = ?').run(id);
    const result = this.db.prepare('DELETE FROM sod_rules WHERE id = ?').run(id);
    return result.changes > 0;
  }

  // ────────── CONFLICTS ──────────

  async detectConflicts(approverName, approverRoles) {
    if (!approverRoles || approverRoles.length < 2) return [];

    const rules = await this.listRules();
    const conflicts = [];

    for (const rule of rules) {
      const hasA = approverRoles.includes(rule.role_a);
      const hasB = approverRoles.includes(rule.role_b);
      if (!hasA || !hasB) continue;

      // Check if this conflict already exists for this approver
      const existing = this.db.prepare(
        "SELECT id FROM sod_conflicts WHERE rule_id = ? AND approver_name = ? AND status = 'open'"
      ).get(rule.id, approverName);

      if (existing) continue; // Already recorded

      const conflict = {
        id: newId('conf_'),
        tenant_id: rule.tenant_id,
        rule_id: rule.id,
        user_email: '',
        approver_name: approverName,
        role_a: rule.role_a,
        role_b: rule.role_b,
        severity: rule.severity,
        detected_at: new Date().toISOString(),
        status: 'open',
        mitigated_by: '',
        mitigated_at: '',
        mitigation_notes: '',
      };

      this.db.prepare(`
        INSERT INTO sod_conflicts (id, tenant_id, rule_id, user_email, approver_name, role_a, role_b, severity, detected_at, status, mitigated_by, mitigated_at, mitigation_notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(conflict.id, conflict.tenant_id, conflict.rule_id, conflict.user_email, conflict.approver_name,
        conflict.role_a, conflict.role_b, conflict.severity, conflict.detected_at, conflict.status,
        conflict.mitigated_by, conflict.mitigated_at, conflict.mitigation_notes);

      conflicts.push(conflict);
    }

    return conflicts;
  }

  async listConflicts(filters = {}) {
    let sql = 'SELECT * FROM sod_conflicts WHERE 1=1';
    const params = [];
    if (filters.status) { sql += ' AND status = ?'; params.push(filters.status); }
    if (filters.severity) { sql += ' AND severity = ?'; params.push(filters.severity); }
    if (filters.approver_name) { sql += ' AND approver_name = ?'; params.push(filters.approver_name); }
    sql += ' ORDER BY detected_at DESC';
    const rows = this.db.prepare(sql).all(...params);
    return rows.map(r => this._conflictRow(r));
  }

  async getConflict(id) {
    const row = this.db.prepare('SELECT * FROM sod_conflicts WHERE id = ?').get(id);
    return row ? this._conflictRow(row) : null;
  }

  async updateConflict(id, updates) {
    const existing = await this.getConflict(id);
    if (!existing) return null;

    const merged = { ...existing, ...updates };
    merged.mitigated_at = merged.status === 'mitigated' ? new Date().toISOString() : '';

    this.db.prepare(`
      UPDATE sod_conflicts
      SET status = ?, mitigated_by = ?, mitigated_at = ?, mitigation_notes = ?
      WHERE id = ?
    `).run(merged.status, merged.mitigated_by || '', merged.mitigated_at, merged.mitigation_notes || '', id);

    return merged;
  }

  async getConflictStats() {
    const total = this.db.prepare("SELECT COUNT(*) as cnt FROM sod_conflicts").get();
    const open = this.db.prepare("SELECT COUNT(*) as cnt FROM sod_conflicts WHERE status = 'open'").get();
    const critical = this.db.prepare("SELECT COUNT(*) as cnt FROM sod_conflicts WHERE severity = 'critical' AND status = 'open'").get();
    return {
      total: total ? total.cnt : 0,
      open: open ? open.cnt : 0,
      criticalOpen: critical ? critical.cnt : 0,
    };
  }

  // ────────── HELPERS ──────────

  _ruleRow(r) {
    return {
      id: r.id,
      tenant_id: r.tenant_id,
      name: r.name,
      role_a: r.role_a,
      role_b: r.role_b,
      severity: r.severity,
      description: r.description,
      framework: r.framework,
      created_by: r.created_by,
      created_at: r.created_at,
    };
  }

  _conflictRow(r) {
    return {
      id: r.id,
      tenant_id: r.tenant_id,
      rule_id: r.rule_id,
      user_email: r.user_email,
      approver_name: r.approver_name,
      role_a: r.role_a,
      role_b: r.role_b,
      severity: r.severity,
      detected_at: r.detected_at,
      status: r.status,
      mitigated_by: r.mitigated_by,
      mitigated_at: r.mitigated_at,
      mitigation_notes: r.mitigation_notes,
    };
  }
}

function createSodStore() {
  return new SodStore();
}

module.exports = { createSodStore, VALID_SEVERITIES, VALID_CONFLICT_STATUSES };

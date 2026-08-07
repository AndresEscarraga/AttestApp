// Persistence layer for certification campaigns using SQLite.
// Phase 2 — Campaign Management System

const crypto = require('crypto');
const { getDb } = require('./db');

const VALID_STATUSES = ['draft', 'active', 'completed', 'archived'];
const VALID_FRAMEWORKS = ['SOX', 'ISO27001', 'SOC2', 'GDPR', 'NIST', 'COBIT', 'ITGC', 'PCI', 'HIPAA', 'Other'];

function newCampaignId() {
  return 'camp_' + crypto.randomUUID().slice(0, 8);
}

function normalizeCampaign(raw) {
  const c = raw || {};
  return {
    id: c.id || newCampaignId(),
    tenant_id: c.tenant_id || 'default',
    name: String(c.name || '').trim(),
    description: String(c.description || '').trim(),
    framework: VALID_FRAMEWORKS.includes(c.framework) ? c.framework : 'SOX',
    period: String(c.period || '').trim(),
    status: VALID_STATUSES.includes(c.status) ? c.status : 'draft',
    deadline: String(c.deadline || '').trim(),
    approvers: Array.isArray(c.approvers) ? c.approvers : parseApproversJson(c.approvers),
    created_by: String(c.created_by || '').trim(),
    created_at: c.created_at || new Date().toISOString(),
    updated_at: c.updated_at || new Date().toISOString(),
  };
}

function parseApproversJson(val) {
  if (Array.isArray(val)) return val;
  try { const parsed = JSON.parse(val); return Array.isArray(parsed) ? parsed : []; }
  catch { return []; }
}

function serializeApprovers(arr) {
  return JSON.stringify(Array.isArray(arr) ? arr : []);
}

class SqliteCampaignStore {
  constructor() {
    this.db = getDb();
  }

  // ── Create ──
  async create(campaign) {
    const c = normalizeCampaign(campaign);
    c.id = c.id || newCampaignId();
    c.created_at = new Date().toISOString();
    c.updated_at = c.created_at;

    this.db.prepare(`
      INSERT INTO campaigns (id, tenant_id, name, description, framework, period, status, deadline, approvers, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      c.id, c.tenant_id, c.name, c.description, c.framework, c.period,
      c.status, c.deadline, serializeApprovers(c.approvers),
      c.created_by, c.created_at, c.updated_at
    );

    return c;
  }

  // ── Read all ──
  async readAll(filters = {}) {
    let sql = 'SELECT * FROM campaigns WHERE 1=1';
    const params = [];

    if (filters.status) {
      sql += ' AND status = ?';
      params.push(filters.status);
    }
    if (filters.framework) {
      sql += ' AND framework = ?';
      params.push(filters.framework);
    }
    if (filters.tenant_id) {
      sql += ' AND tenant_id = ?';
      params.push(filters.tenant_id);
    }

    sql += ' ORDER BY created_at DESC';

    if (filters.limit > 0) {
      sql += ' LIMIT ?';
      params.push(filters.limit);
    }

    const rows = this.db.prepare(sql).all(...params);
    return rows.map(r => this._rowToCampaign(r));
  }

  // ── Read by ID ──
  async readById(id) {
    const row = this.db.prepare('SELECT * FROM campaigns WHERE id = ?').get(id);
    return row ? this._rowToCampaign(row) : null;
  }

  // ── Update ──
  async update(id, updates) {
    const existing = await this.readById(id);
    if (!existing) return null;

    const merged = { ...existing, ...updates, id, updated_at: new Date().toISOString() };
    const c = normalizeCampaign(merged);

    this.db.prepare(`
      UPDATE campaigns
      SET name = ?, description = ?, framework = ?, period = ?, status = ?,
          deadline = ?, approvers = ?, updated_at = ?
      WHERE id = ?
    `).run(
      c.name, c.description, c.framework, c.period, c.status,
      c.deadline, serializeApprovers(c.approvers), c.updated_at, c.id
    );

    return c;
  }

  // ── Delete ──
  async delete(id) {
    const result = this.db.prepare('DELETE FROM campaigns WHERE id = ?').run(id);
    return result.changes > 0;
  }

  // ── Get progress stats for a campaign ──
  async getProgress(campaignId) {
    const campaign = await this.readById(campaignId);
    if (!campaign) return null;

    const approvers = campaign.approvers;
    const approverProgress = [];

    for (const approver of approvers) {
      const submissions = this.db.prepare(
        "SELECT DISTINCT role_name FROM submissions WHERE approver = ? AND campaign_id = ? AND action != ''"
      ).all(approver, campaignId);

      // Get roles assigned to this approver from the in-memory data
      const reviewedRoles = submissions.map(s => s.role_name);

      approverProgress.push({
        approver,
        reviewedCount: reviewedRoles.length,
        reviewedRoles,
      });
    }

    // Count total unique roles reviewed across all approvers
    const totalReviewed = this.db.prepare(
      "SELECT COUNT(DISTINCT role_name) as cnt FROM submissions WHERE campaign_id = ? AND action != ''"
    ).get(campaignId);

    return {
      campaignId,
      approverProgress,
      totalReviewed: totalReviewed ? totalReviewed.cnt : 0,
    };
  }

  // ── Private helpers ──
  _rowToCampaign(row) {
    return {
      id: row.id,
      tenant_id: row.tenant_id,
      name: row.name,
      description: row.description,
      framework: row.framework,
      period: row.period,
      status: row.status,
      deadline: row.deadline,
      approvers: parseApproversJson(row.approvers),
      created_by: row.created_by,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }
}

function createCampaignStore() {
  return new SqliteCampaignStore();
}

module.exports = { createCampaignStore, VALID_STATUSES, VALID_FRAMEWORKS };

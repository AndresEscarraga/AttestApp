// Multi-tenant store — manages organizations/tenants.
// Phase 4 — Multi-Tenant Architecture

const crypto = require('crypto');
const { getDb } = require('./db');

const VALID_PLANS = ['starter', 'professional', 'enterprise'];
const VALID_STATUSES = ['active', 'suspended', 'inactive'];

function newTenantId() {
  return 'tnt_' + crypto.randomUUID().slice(0, 8);
}

class TenantStore {
  constructor() {
    this.db = getDb();
  }

  async create({ name, plan, status }) {
    const id = newTenantId();
    const now = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO tenants (id, name, plan, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, name.trim(), VALID_PLANS.includes(plan) ? plan : 'starter',
      VALID_STATUSES.includes(status) ? status : 'active', now, now);

    return this.getById(id);
  }

  async getById(id) {
    const row = this.db.prepare('SELECT * FROM tenants WHERE id = ?').get(id);
    return row ? this._row(row) : null;
  }

  async listAll() {
    const rows = this.db.prepare('SELECT * FROM tenants ORDER BY name').all();
    return rows.map(r => this._row(r));
  }

  async update(id, updates) {
    const existing = await this.getById(id);
    if (!existing) return null;

    const name = updates.name !== undefined ? String(updates.name).trim() : existing.name;
    const plan = updates.plan !== undefined ? (VALID_PLANS.includes(updates.plan) ? updates.plan : existing.plan) : existing.plan;
    const status = updates.status !== undefined ? (VALID_STATUSES.includes(updates.status) ? updates.status : existing.status) : existing.status;
    const settings = updates.settings !== undefined ? JSON.stringify(updates.settings) : JSON.stringify(existing.settings || {});
    const now = new Date().toISOString();

    this.db.prepare('UPDATE tenants SET name = ?, plan = ?, status = ?, settings = ?, updated_at = ? WHERE id = ?')
      .run(name, plan, status, settings, now, id);

    return this.getById(id);
  }

  async delete(id) {
    if (id === 'default') throw new Error('Cannot delete the default tenant.');
    const result = this.db.prepare('DELETE FROM tenants WHERE id = ?').run(id);
    return result.changes > 0;
  }

  // ── Helpers ──
  _row(r) {
    return {
      id: r.id,
      name: r.name,
      plan: r.plan,
      status: r.status,
      settings: safeJson(r.settings),
      created_at: r.created_at,
      updated_at: r.updated_at,
    };
  }
}

function safeJson(str) {
  try { return JSON.parse(str); } catch { return {}; }
}

function createTenantStore() {
  return new TenantStore();
}

module.exports = { createTenantStore, VALID_PLANS, VALID_STATUSES };

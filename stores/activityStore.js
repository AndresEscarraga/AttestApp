// Persistence layer for the application activity log using SQLite.

const crypto = require('crypto');
const { getDb } = require('./db');

const DEFAULT_LIMIT = 1000;

function newActivityId() {
  return crypto.randomUUID();
}

function normalizeEvent(event) {
  const e = event || {};
  return {
    activityId: e.activityId || newActivityId(),
    timestamp: e.timestamp || new Date().toISOString(),
    type: String(e.type || '').trim() || 'AUTH',
    action: String(e.action || '').trim(),
    email: String(e.email || '').trim(),
    detail: String(e.detail || '').trim(),
    tenantId: String(e.tenantId || '').trim(),
  };
}

class SqliteActivityStore {
  constructor() {
    this.db = getDb();
  }

  async record(event) {
    const e = normalizeEvent(event);
    if (!e.tenantId) throw new Error('tenantId is required');
    this.db.prepare(
      'INSERT OR REPLACE INTO activity (activity_id, tenant_id, timestamp, type, action, email, detail) VALUES (?,?,?,?,?,?,?)'
    ).run(e.activityId, e.tenantId, e.timestamp, e.type, e.action, e.email, e.detail);
  }

  async readAll(filters = {}) {
    let sql = 'SELECT * FROM activity WHERE 1=1';
    const params = [];
    const tenantId = String(filters.tenantId || '').trim();
    if (!tenantId) throw new Error('tenantId is required');
    sql += ' AND tenant_id = ?';
    params.push(tenantId);
    if (filters.type) { sql += ' AND type = ?'; params.push(filters.type); }
    if (filters.email) { sql += ' AND email = ?'; params.push(filters.email); }
    sql += ' ORDER BY timestamp DESC';
    const limit = Number(filters.limit) > 0 ? Number(filters.limit) : DEFAULT_LIMIT;
    const offset = Number(filters.offset) > 0 ? Number(filters.offset) : 0;
    sql += ' LIMIT ? OFFSET ?';
    params.push(limit, offset);
    const rows = this.db.prepare(sql).all(...params);
    return rows.map(r => ({
      activityId: r.activity_id,
      tenantId: r.tenant_id,
      timestamp: r.timestamp,
      type: r.type,
      action: r.action,
      email: r.email,
      detail: r.detail,
    }));
  }
}

function createActivityStore() {
  return new SqliteActivityStore();
}

module.exports = { createActivityStore };

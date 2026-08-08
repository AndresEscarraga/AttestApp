// API Key management store — Phase 5
const crypto = require('crypto');
const { getDb } = require('./db');

const VALID_PERMISSIONS = ['read-only', 'read-write', 'health-check'];

function newId() { return 'key_' + crypto.randomUUID().slice(0, 8); }
function generateKey() { return 'att_live_' + crypto.randomBytes(24).toString('hex'); }
function hashKey(key) { return crypto.createHash('sha256').update(key).digest('hex'); }
function keyPrefix(key) { return key.substring(0, 12) + '...'; }

class ApiKeyStore {
  constructor() { this.db = getDb(); }

  async create({ name, permissions, created_by, tenant_id }) {
    const id = newId();
    const key = generateKey();
    const hash = hashKey(key);
    const prefix = keyPrefix(key);
    const now = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO api_keys (id, tenant_id, name, key_prefix, key_hash, permissions, created_by, created_at)
      VALUES (?,?,?,?,?,?,?,?)
    `).run(id, tenant_id || 'default', name.trim(), prefix, hash,
      VALID_PERMISSIONS.includes(permissions) ? permissions : 'read-only',
      created_by, now);

    return { id, name: name.trim(), key_prefix: prefix, key, permissions, created_by, created_at: now };
  }

  async listAll(tenant_id) {
    const rows = this.db.prepare(
      "SELECT id, tenant_id, name, key_prefix, permissions, created_by, created_at, last_used_at, revoked FROM api_keys WHERE tenant_id = ? AND revoked = 0 ORDER BY created_at DESC"
    ).all(tenant_id || 'default');
    return rows.map(r => ({
      id: r.id, tenant_id: r.tenant_id, name: r.name, key_prefix: r.key_prefix,
      permissions: r.permissions, created_by: r.created_by, created_at: r.created_at,
      last_used_at: r.last_used_at, revoked: !!r.revoked
    }));
  }

  async revoke(id, tenantId) {
    const r = this.db.prepare("UPDATE api_keys SET revoked = 1 WHERE id = ? AND tenant_id = ?")
      .run(id, String(tenantId || ''));
    return r.changes > 0;
  }

  async validateKey(key) {
    if (!key || !key.startsWith('att_live_')) return null;
    const hash = hashKey(key);
    const row = this.db.prepare(
      "SELECT * FROM api_keys WHERE key_hash = ? AND revoked = 0"
    ).get(hash);
    if (!row) return null;
    // Update last_used_at
    this.db.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?")
      .run(new Date().toISOString(), row.id);
    return { id: row.id, tenant_id: row.tenant_id, permissions: row.permissions };
  }
}

function createApiKeyStore() { return new ApiKeyStore(); }
module.exports = { createApiKeyStore, VALID_PERMISSIONS };

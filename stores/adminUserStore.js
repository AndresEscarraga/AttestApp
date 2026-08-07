// Admin user persistence using SQLite.

const { getDb } = require('./db');

const DEFAULT_ADMIN_EMAILS = [
  'admin.one@attest.local',
  'admin.two@attest.local',
  'admin.three@attest.local',
  'admin.four@attest.local',
  'admin.five@attest.local',
  'admin.six@attest.local',
  'superadmin.one@attest.local',
  'superadmin.two@attest.local',
  'approver.one@attest.local',
  'approver.two@attest.local',
  'auditor.one@attest.local',
  'auditor.two@attest.local',
];

const PROTECTED_ADMIN_EMAILS = [
  'superadmin.one@attest.local',
  'superadmin.two@attest.local',
];

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

class SqliteAdminUserStore {
  constructor() {
    this.db = getDb();
    this._seedIfEmpty();
  }

  _seedIfEmpty() {
    const count = this.db.prepare('SELECT COUNT(*) as cnt FROM admin_users').get();
    if (count.cnt > 0) return;
    const insert = this.db.prepare('INSERT OR IGNORE INTO admin_users (email, protected, role) VALUES (?, ?, ?)');
    const seedMany = this.db.transaction((emails) => {
      for (const email of emails) {
        const normalized = normalizeEmail(email);
        const isProtected = PROTECTED_ADMIN_EMAILS.includes(normalized) ? 1 : 0;
        const role = normalized.includes('superadmin') ? 'admin' :
                     normalized.includes('approver') ? 'approver' :
                     normalized.includes('auditor') ? 'auditor' : 'admin';
        insert.run(normalized, isProtected, role);
      }
    });
    seedMany(DEFAULT_ADMIN_EMAILS);
  }

  async listAdmins(tenantId) {
    const tid = tenantId || 'default';
    const rows = this.db.prepare('SELECT email, role FROM admin_users WHERE tenant_id = ? ORDER BY email').all(tid);
    return rows.map(r => r.email);
  }

  async listAdminsWithRoles(tenantId) {
    const tid = tenantId || 'default';
    return this.db.prepare('SELECT email, role, protected FROM admin_users WHERE tenant_id = ? ORDER BY email').all(tid);
  }

  async getUserRole(email) {
    const normalized = normalizeEmail(email);
    const row = this.db.prepare('SELECT role FROM admin_users WHERE email = ?').get(normalized);
    return row ? row.role : null;
  }

  async addAdmin(email, tenantId, role) {
    const tid = tenantId || 'default';
    const normalized = normalizeEmail(email);
    if (!isValidEmail(normalized)) throw new Error('Invalid email');
    const userRole = role || 'admin';
    this.db.prepare('INSERT OR IGNORE INTO admin_users (email, tenant_id, protected, role) VALUES (?, ?, 0, ?)').run(normalized, tid, userRole);
    return normalized;
  }

  async setPassword(email, plainPassword) {
    const bcrypt = require('bcrypt');
    const normalized = normalizeEmail(email);
    const hash = await bcrypt.hash(plainPassword, 10);
    this.db.prepare('UPDATE admin_users SET password_hash = ? WHERE email = ?').run(hash, normalized);
    return true;
  }

  async verifyPassword(email, plainPassword) {
    const normalized = normalizeEmail(email);
    const row = this.db.prepare('SELECT password_hash FROM admin_users WHERE email = ?').get(normalized);
    if (!row || !row.password_hash) {
      // Legacy: no hash set → accept 'admin' as master password
      return plainPassword === 'admin';
    }
    const bcrypt = require('bcrypt');
    return await bcrypt.compare(plainPassword, row.password_hash);
  }

  async removeAdmin(email) {
    const normalized = normalizeEmail(email);
    if (PROTECTED_ADMIN_EMAILS.includes(normalized)) {
      const err = new Error('Protected admin cannot be removed');
      err.code = 'PROTECTED_ADMIN';
      throw err;
    }
    const result = this.db.prepare(
      'DELETE FROM admin_users WHERE email = ? AND protected = 0'
    ).run(normalized);
    return result.changes > 0;
  }
}

function createAdminUserStore() {
  return new SqliteAdminUserStore();
}

module.exports = {
  createAdminUserStore,
  PROTECTED_ADMIN_EMAILS,
  normalizeEmail,
};

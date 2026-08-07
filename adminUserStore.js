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
    const insert = this.db.prepare('INSERT OR IGNORE INTO admin_users (email, protected) VALUES (?, ?)');
    const seedMany = this.db.transaction((emails) => {
      for (const email of emails) {
        const normalized = normalizeEmail(email);
        const isProtected = PROTECTED_ADMIN_EMAILS.includes(normalized) ? 1 : 0;
        insert.run(normalized, isProtected);
      }
    });
    seedMany(DEFAULT_ADMIN_EMAILS);
  }

  async listAdmins() {
    const rows = this.db.prepare('SELECT email FROM admin_users ORDER BY email').all();
    return rows.map(r => r.email);
  }

  async addAdmin(email) {
    const normalized = normalizeEmail(email);
    if (!isValidEmail(normalized)) throw new Error('Invalid email');
    this.db.prepare('INSERT OR IGNORE INTO admin_users (email, protected) VALUES (?, 0)').run(normalized);
    return normalized;
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

// User accounts and tenant memberships using SQLite.

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

const VALID_ROLES = ['admin', 'approver', 'auditor'];

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function requireTenantId(value) {
  const tenantId = String(value || '').trim();
  if (!tenantId) throw new Error('tenantId is required');
  return tenantId;
}

class SqliteAdminUserStore {
  constructor() {
    this.db = getDb();
  }

  async listAdmins(tenantId) {
    const rows = this.db.prepare(`
      SELECT email FROM tenant_memberships
      WHERE tenant_id = ? AND role = 'admin' AND status = 'active'
      ORDER BY email
    `).all(requireTenantId(tenantId));
    return rows.map(row => row.email);
  }

  async listAdminsWithRoles(tenantId) {
    return this.listMembersWithRoles(tenantId);
  }

  async listMembersWithRoles(tenantId) {
    return this.db.prepare(`
      SELECT email, role, protected, status, approver_name
      FROM tenant_memberships
      WHERE tenant_id = ? ORDER BY email
    `).all(requireTenantId(tenantId)).map(row => ({
      ...row,
      protected: !!row.protected,
    }));
  }

  async getMembership(email, tenantId) {
    const row = this.db.prepare(`
      SELECT email, tenant_id, role, approver_name, status, protected
      FROM tenant_memberships
      WHERE email = ? AND tenant_id = ?
    `).get(normalizeEmail(email), requireTenantId(tenantId));
    return row ? { ...row, protected: !!row.protected } : null;
  }

  async listMemberships(email, { activeOnly = true } = {}) {
    let sql = `
      SELECT m.email, m.tenant_id, m.role, m.approver_name, m.status,
             m.protected, t.name AS tenant_name, t.plan, t.status AS tenant_status
      FROM tenant_memberships m
      JOIN tenants t ON t.id = m.tenant_id
      WHERE m.email = ?`;
    if (activeOnly) sql += " AND m.status = 'active' AND t.status = 'active'";
    sql += ' ORDER BY t.name';
    return this.db.prepare(sql).all(normalizeEmail(email)).map(row => ({
      ...row,
      protected: !!row.protected,
    }));
  }

  async getUserRole(email, tenantId) {
    const membership = await this.getMembership(email, requireTenantId(tenantId));
    return membership && membership.status === 'active' ? membership.role : null;
  }

  async addMembership(email, tenantId, role = 'admin', options = {}) {
    const tid = requireTenantId(tenantId);
    const normalized = normalizeEmail(email);
    if (!isValidEmail(normalized)) throw new Error('Invalid email');
    if (!VALID_ROLES.includes(role)) throw new Error('Invalid role');
    const existingMembership = await this.getMembership(normalized, tid);
    if (existingMembership && existingMembership.role === 'admin' && role !== 'admin' && this._activeAdminCount(tid) <= 1) {
      const err = new Error('A tenant must retain at least one active administrator');
      err.code = 'LAST_TENANT_ADMIN';
      throw err;
    }
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT OR IGNORE INTO user_accounts (email, display_name, created_at, updated_at)
      VALUES (?, ?, ?, ?)
    `).run(normalized, String(options.displayName || '').trim(), now, now);
    this.db.prepare(`
      INSERT INTO tenant_memberships
        (email, tenant_id, role, approver_name, status, protected, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(email, tenant_id) DO UPDATE SET
        role = CASE WHEN tenant_memberships.protected = 1 THEN tenant_memberships.role ELSE excluded.role END,
        approver_name = CASE WHEN excluded.approver_name = '' THEN tenant_memberships.approver_name ELSE excluded.approver_name END,
        status = excluded.status,
        protected = CASE WHEN tenant_memberships.protected = 1 THEN 1 ELSE excluded.protected END,
        updated_at = excluded.updated_at
    `).run(
      normalized,
      tid,
      role,
      String(options.approverName || '').trim(),
      options.status === 'inactive' ? 'inactive' : 'active',
      options.protected ? 1 : 0,
      now,
      now
    );
    return normalized;
  }

  async addAdmin(email, tenantId, role) {
    return this.addMembership(email, requireTenantId(tenantId), role || 'admin');
  }

  async setPassword(email, plainPassword) {
    const bcrypt = require('bcrypt');
    const normalized = normalizeEmail(email);
    const hash = await bcrypt.hash(plainPassword, 10);
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO user_accounts (email, password_hash, created_at, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(email) DO UPDATE SET
        password_hash = excluded.password_hash,
        updated_at = excluded.updated_at
    `).run(normalized, hash, now, now);
    return true;
  }

  async verifyPassword(email, plainPassword) {
    const row = this.db.prepare(
      'SELECT password_hash FROM user_accounts WHERE email = ?'
    ).get(normalizeEmail(email));
    if (!row || !row.password_hash) return false;
    const bcrypt = require('bcrypt');
    return bcrypt.compare(plainPassword, row.password_hash);
  }

  async removeMembership(email, tenantId) {
    const normalized = normalizeEmail(email);
    const tid = requireTenantId(tenantId);
    const membership = await this.getMembership(normalized, tid);
    if (!membership) return false;
    if (membership.protected || PROTECTED_ADMIN_EMAILS.includes(normalized)) {
      const err = new Error('Protected admin cannot be removed');
      err.code = 'PROTECTED_ADMIN';
      throw err;
    }
    if (membership.role === 'admin' && this._activeAdminCount(tid) <= 1) {
      const err = new Error('A tenant must retain at least one active administrator');
      err.code = 'LAST_TENANT_ADMIN';
      throw err;
    }
    const result = this.db.prepare(
      'DELETE FROM tenant_memberships WHERE email = ? AND tenant_id = ? AND protected = 0'
    ).run(normalized, tid);
    return result.changes > 0;
  }

  async updateMembershipRole(email, tenantId, role) {
    const normalized = normalizeEmail(email);
    const tid = requireTenantId(tenantId);
    if (!VALID_ROLES.includes(role)) throw new Error('Invalid role');
    const membership = await this.getMembership(normalized, tid);
    if (!membership) return null;
    if (membership.protected || PROTECTED_ADMIN_EMAILS.includes(normalized)) {
      const err = new Error('Protected admin role cannot be changed');
      err.code = 'PROTECTED_ADMIN';
      throw err;
    }
    if (membership.role === 'admin' && role !== 'admin' && this._activeAdminCount(tid) <= 1) {
      const err = new Error('A tenant must retain at least one active administrator');
      err.code = 'LAST_TENANT_ADMIN';
      throw err;
    }
    this.db.prepare(`
      UPDATE tenant_memberships SET role = ?, updated_at = ?
      WHERE email = ? AND tenant_id = ? AND protected = 0
    `).run(role, new Date().toISOString(), normalized, tid);
    return this.getMembership(normalized, tid);
  }

  _activeAdminCount(tenantId) {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count FROM tenant_memberships
      WHERE tenant_id = ? AND role = 'admin' AND status = 'active'
    `).get(requireTenantId(tenantId));
    return row ? row.count : 0;
  }

  async removeAdmin(email, tenantId) {
    return this.removeMembership(email, requireTenantId(tenantId));
  }
}

function createAdminUserStore() {
  return new SqliteAdminUserStore();
}

module.exports = {
  createAdminUserStore,
  PROTECTED_ADMIN_EMAILS,
  VALID_ROLES,
  normalizeEmail,
};

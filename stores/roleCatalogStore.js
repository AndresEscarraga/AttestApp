// Tenant-scoped business-role catalog and transaction data.

const { getDb } = require('./db');

class RoleCatalogStore {
  constructor() {
    this.db = getDb();
  }

  replaceAssignments(tenantId, assignments) {
    const tid = requireTenantId(tenantId);
    const remove = this.db.prepare('DELETE FROM tenant_role_assignments WHERE tenant_id = ?');
    const insert = this.db.prepare(`
      INSERT INTO tenant_role_assignments
        (tenant_id, role_name, approver_name, approver_email, system_name)
      VALUES (?, ?, ?, ?, ?)
    `);
    this.db.transaction((rows) => {
      remove.run(tid);
      for (const row of rows || []) {
        const roleName = String(row.roleName || '').trim();
        if (!roleName) continue;
        insert.run(
          tid,
          roleName,
          String(row.approverName || '').trim(),
          String(row.approverEmail || '').trim().toLowerCase(),
          String(row.systemName || '').trim()
        );
      }
    })(assignments);
  }

  replaceTransactions(tenantId, byRole) {
    const tid = requireTenantId(tenantId);
    const remove = this.db.prepare('DELETE FROM tenant_role_transactions WHERE tenant_id = ?');
    const insert = this.db.prepare(`
      INSERT INTO tenant_role_transactions (tenant_id, role_name, row_index, row_json)
      VALUES (?, ?, ?, ?)
    `);
    this.db.transaction((catalog) => {
      remove.run(tid);
      for (const [roleName, rows] of Object.entries(catalog || {})) {
        (rows || []).forEach((row, index) => {
          insert.run(tid, roleName, index, JSON.stringify(row));
        });
      }
    })(byRole);
  }

  listRoleNames(tenantId) {
    return this.db.prepare(`
      SELECT role_name FROM tenant_role_assignments
      WHERE tenant_id = ? ORDER BY role_name
    `).all(requireTenantId(tenantId)).map(row => row.role_name);
  }

  listApprovers(tenantId) {
    return this.db.prepare(`
      SELECT approver_name, MIN(approver_email) AS approver_email
      FROM tenant_role_assignments
      WHERE tenant_id = ? AND approver_name != ''
      GROUP BY approver_name ORDER BY approver_name
    `).all(requireTenantId(tenantId)).map(row => ({
      name: row.approver_name,
      email: row.approver_email || '',
    }));
  }

  getRolesForApprover(tenantId, approverName) {
    return this.db.prepare(`
      SELECT role_name FROM tenant_role_assignments
      WHERE tenant_id = ? AND approver_name = ? ORDER BY role_name
    `).all(requireTenantId(tenantId), String(approverName || '').trim())
      .map(row => row.role_name);
  }

  getApproverByEmail(tenantId, email) {
    const row = this.db.prepare(`
      SELECT approver_name, approver_email
      FROM tenant_role_assignments
      WHERE tenant_id = ? AND approver_email = ? AND approver_name != ''
      ORDER BY role_name LIMIT 1
    `).get(requireTenantId(tenantId), String(email || '').trim().toLowerCase());
    return row ? { name: row.approver_name, email: row.approver_email } : null;
  }

  getApproverForRole(tenantId, roleName) {
    const row = this.db.prepare(`
      SELECT approver_name FROM tenant_role_assignments
      WHERE tenant_id = ? AND role_name = ?
    `).get(requireTenantId(tenantId), String(roleName || '').trim());
    return row ? row.approver_name : '';
  }

  getTransactions(tenantId, roleName) {
    return this.db.prepare(`
      SELECT row_json FROM tenant_role_transactions
      WHERE tenant_id = ? AND role_name = ? ORDER BY row_index
    `).all(requireTenantId(tenantId), String(roleName || '').trim()).map(row => {
      try { return JSON.parse(row.row_json); } catch { return []; }
    });
  }

  getTransactionStats(tenantId) {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS total_rows, COUNT(DISTINCT role_name) AS role_count
      FROM tenant_role_transactions WHERE tenant_id = ?
    `).get(requireTenantId(tenantId));
    return {
      totalRows: row ? row.total_rows : 0,
      rolesWithData: row ? row.role_count : 0,
    };
  }

  getSystemCounts(tenantId) {
    return this.db.prepare(`
      SELECT CASE WHEN system_name = '' THEN 'Other' ELSE system_name END AS name,
             COUNT(*) AS total
      FROM tenant_role_assignments
      WHERE tenant_id = ?
      GROUP BY CASE WHEN system_name = '' THEN 'Other' ELSE system_name END
      ORDER BY total DESC, name
    `).all(requireTenantId(tenantId));
  }
}

function requireTenantId(value) {
  const tenantId = String(value || '').trim();
  if (!tenantId) throw new Error('tenantId is required');
  return tenantId;
}

function createRoleCatalogStore() {
  return new RoleCatalogStore();
}

module.exports = { createRoleCatalogStore, RoleCatalogStore };

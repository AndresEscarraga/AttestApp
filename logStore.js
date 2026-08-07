// Persistence layer for submission logs using SQLite.

const { getDb } = require('./db');

class SqliteLogStore {
  constructor() {
    this.db = getDb();
  }

  async appendEntries(entries) {
    if (!entries.length) return;
    const insert = this.db.prepare(`
      INSERT OR REPLACE INTO submissions
        (log_entry_id, submission_id, timestamp, approver, submitted_by_email,
         impersonated, role_name, action, ritm, ritm_status, action_details,
         comments, rejection_reason, row_index)
      VALUES
        (@logEntryId, @submissionId, @timestamp, @approver, @submittedByEmail,
         @impersonated, @roleName, @action, @ritm, @ritmStatus, @actionDetails,
         @comments, @rejectionReason, @rowIndex)
    `);
    const insertMany = this.db.transaction((entries) => {
      for (const e of entries) {
        insert.run({
          logEntryId: e.logEntryId,
          submissionId: e.submissionId,
          timestamp: e.timestamp,
          approver: e.approver,
          submittedByEmail: e.submittedByEmail || '',
          impersonated: e.impersonated ? 1 : 0,
          roleName: e.roleName,
          action: e.action,
          ritm: e.ritm || '',
          ritmStatus: e.ritmStatus || 'Open',
          actionDetails: e.actionDetails || '',
          comments: e.comments || '',
          rejectionReason: e.rejectionReason || '',
          rowIndex: e.rowIndex,
        });
      }
    });
    insertMany(entries);
  }

  async readAll(filters = {}) {
    let sql = 'SELECT * FROM submissions WHERE 1=1';
    const params = {};
    if (filters.approver) { sql += ' AND approver = @approver'; params.approver = filters.approver; }
    if (filters.action)   { sql += ' AND action = @action';     params.action = filters.action; }
    if (filters.role)     { sql += ' AND role_name = @role';    params.role = filters.role; }
    sql += ' ORDER BY timestamp DESC';
    const rows = this.db.prepare(sql).all(params);
    return rows.map(r => ({
      logEntryId: r.log_entry_id,
      submissionId: r.submission_id,
      timestamp: r.timestamp,
      approver: r.approver,
      submittedByEmail: r.submitted_by_email,
      impersonated: !!r.impersonated,
      roleName: r.role_name,
      action: r.action,
      ritm: r.ritm,
      ritmStatus: r.ritm_status,
      actionDetails: r.action_details,
      comments: r.comments,
      rejectionReason: r.rejection_reason,
      rowIndex: r.row_index,
    }));
  }

  async updateRitm(logEntryId, ritm) {
    const result = this.db.prepare(
      'UPDATE submissions SET ritm = ? WHERE log_entry_id = ?'
    ).run(ritm, logEntryId);
    return result.changes > 0;
  }

  async updateRitmStatus(logEntryId, ritmStatus) {
    const result = this.db.prepare(
      'UPDATE submissions SET ritm_status = ? WHERE log_entry_id = ?'
    ).run(ritmStatus, logEntryId);
    return result.changes > 0;
  }
}

function createLogStore() {
  return new SqliteLogStore();
}

module.exports = { createLogStore };

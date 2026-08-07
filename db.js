// SQLite database connection singleton for Attest app.
// Provides a single shared database instance across all store modules.

const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'attest.db');

let db = null;

function getDb() {
  if (db) return db;

  // Ensure the data directory exists
  const fs = require('fs');
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Create tables if they don't exist
  db.exec(`
    CREATE TABLE IF NOT EXISTS submissions (
      log_entry_id TEXT PRIMARY KEY,
      submission_id TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      approver TEXT NOT NULL,
      submitted_by_email TEXT NOT NULL,
      impersonated INTEGER NOT NULL DEFAULT 0,
      role_name TEXT NOT NULL,
      action TEXT NOT NULL,
      ritm TEXT NOT NULL DEFAULT '',
      ritm_status TEXT NOT NULL DEFAULT 'Open',
      action_details TEXT NOT NULL DEFAULT '',
      comments TEXT NOT NULL DEFAULT '',
      rejection_reason TEXT NOT NULL DEFAULT '',
      row_index INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_submissions_approver ON submissions(approver);
    CREATE INDEX IF NOT EXISTS idx_submissions_action ON submissions(action);
    CREATE INDEX IF NOT EXISTS idx_submissions_role ON submissions(role_name);
    CREATE INDEX IF NOT EXISTS idx_submissions_timestamp ON submissions(timestamp DESC);

    CREATE TABLE IF NOT EXISTS activity (
      activity_id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'AUTH',
      action TEXT NOT NULL,
      email TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT ''
    );

    CREATE INDEX IF NOT EXISTS idx_activity_type ON activity(type);
    CREATE INDEX IF NOT EXISTS idx_activity_email ON activity(email);
    CREATE INDEX IF NOT EXISTS idx_activity_timestamp ON activity(timestamp DESC);

    CREATE TABLE IF NOT EXISTS admin_users (
      email TEXT PRIMARY KEY,
      protected INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  console.log(`[db] SQLite connected: ${DB_PATH}`);
  return db;
}

function closeDb() {
  if (db) {
    db.close();
    db = null;
    console.log('[db] SQLite connection closed.');
  }
}

module.exports = { getDb, closeDb, DB_PATH };

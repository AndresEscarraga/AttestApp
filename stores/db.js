// SQLite database connection singleton for Attest app.
// Provides a single shared database instance across all store modules.

const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'attest.db');

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

    CREATE TABLE IF NOT EXISTS campaigns (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      framework TEXT NOT NULL DEFAULT 'SOX',
      period TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      deadline TEXT NOT NULL DEFAULT '',
      approvers TEXT NOT NULL DEFAULT '[]',
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_campaigns_status ON campaigns(status);
    CREATE INDEX IF NOT EXISTS idx_campaigns_created_at ON campaigns(created_at DESC);

    -- Add campaign_id to submissions if it doesn't exist (safe migration)
  `);

  // Safe migration: add campaign_id column to submissions if it doesn't exist
  try {
    db.exec("ALTER TABLE submissions ADD COLUMN campaign_id TEXT DEFAULT ''");
    console.log('[db] Added campaign_id column to submissions.');
  } catch (e) {
    // Column already exists — ignore
  }

  // Phase 3: SoD tables + Evidence table
  db.exec(`
    CREATE TABLE IF NOT EXISTS sod_rules (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      name TEXT NOT NULL,
      role_a TEXT NOT NULL,
      role_b TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'high',
      description TEXT NOT NULL DEFAULT '',
      framework TEXT NOT NULL DEFAULT 'SOX',
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_sod_rules_severity ON sod_rules(severity);

    CREATE TABLE IF NOT EXISTS sod_conflicts (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      rule_id TEXT NOT NULL,
      user_email TEXT NOT NULL,
      approver_name TEXT NOT NULL,
      role_a TEXT NOT NULL,
      role_b TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'high',
      detected_at TEXT NOT NULL DEFAULT (datetime('now')),
      status TEXT NOT NULL DEFAULT 'open',
      mitigated_by TEXT NOT NULL DEFAULT '',
      mitigated_at TEXT NOT NULL DEFAULT '',
      mitigation_notes TEXT NOT NULL DEFAULT ''
    );

    CREATE INDEX IF NOT EXISTS idx_sod_conflicts_status ON sod_conflicts(status);
    CREATE INDEX IF NOT EXISTS idx_sod_conflicts_approver ON sod_conflicts(approver_name);

    CREATE TABLE IF NOT EXISTS evidence_packages (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      name TEXT NOT NULL,
      campaign_id TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      file_path TEXT NOT NULL DEFAULT '',
      file_size INTEGER NOT NULL DEFAULT 0,
      generated_by TEXT NOT NULL,
      generated_at TEXT NOT NULL DEFAULT (datetime('now')),
      share_token TEXT NOT NULL DEFAULT '',
      share_expires_at TEXT NOT NULL DEFAULT ''
    );

    CREATE INDEX IF NOT EXISTS idx_evidence_packages_campaign ON evidence_packages(campaign_id);
  `);

  // Phase 4: Multi-tenant — tenants table + tenant_id migrations
  db.exec(`
    CREATE TABLE IF NOT EXISTS tenants (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      plan TEXT NOT NULL DEFAULT 'starter',
      status TEXT NOT NULL DEFAULT 'active',
      settings TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Seed default tenant if not exists
  const defaultTenant = db.prepare("SELECT id FROM tenants WHERE id = 'default'").get();
  if (!defaultTenant) {
    db.prepare("INSERT INTO tenants (id, name, plan, status) VALUES (?, ?, ?, ?)")
      .run('default', 'Default Organization', 'starter', 'active');
    console.log('[db] Seeded default tenant.');
  }

  // Safe migrations: add tenant_id to core tables
  const tenantMigrations = [
    { table: 'submissions', col: 'tenant_id', def: "'default'" },
    { table: 'activity', col: 'tenant_id', def: "'default'" },
    { table: 'admin_users', col: 'tenant_id', def: "'default'" },
  ];

  for (const m of tenantMigrations) {
    try {
      db.exec(`ALTER TABLE ${m.table} ADD COLUMN ${m.col} TEXT NOT NULL DEFAULT ${m.def}`);
      console.log(`[db] Added ${m.col} column to ${m.table}.`);
    } catch (e) {
      // Column already exists — ignore
    }
  }

  // Create tenant indexes
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_submissions_tenant ON submissions(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_activity_tenant ON activity(tenant_id);
  `);

  // Phase 5: API Keys table
  db.exec(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      name TEXT NOT NULL,
      key_prefix TEXT NOT NULL,
      key_hash TEXT NOT NULL,
      permissions TEXT NOT NULL DEFAULT 'read-only',
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_used_at TEXT,
      revoked INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_api_keys_tenant ON api_keys(tenant_id);
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

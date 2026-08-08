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

  // ── Migrations tracking table ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Helper: run a migration only once
  function migrate(name, sql, ignoreError) {
    const exists = db.prepare("SELECT name FROM _migrations WHERE name = ?").get(name);
    if (exists) return;
    try {
      db.exec(sql);
      db.prepare("INSERT INTO _migrations (name) VALUES (?)").run(name);
      console.log('[db] Migration applied: ' + name);
    } catch(e) {
      if (ignoreError) {
        console.log('[db] Migration skipped (already exists): ' + name);
        db.prepare("INSERT OR IGNORE INTO _migrations (name) VALUES (?)").run(name);
      } else {
        throw e;
      }
    }
  }

  function migrateData(name, callback) {
    const exists = db.prepare("SELECT name FROM _migrations WHERE name = ?").get(name);
    if (exists) return;
    callback(db);
    db.prepare("INSERT INTO _migrations (name) VALUES (?)").run(name);
    console.log('[db] Migration applied: ' + name);
  }

  // ── Core tables ──
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

  // ── Phase 2b: Add campaign_id to submissions ──
  migrate('002b_campaign_id', "ALTER TABLE submissions ADD COLUMN campaign_id TEXT DEFAULT ''", true);

  // ── Phase 3: SoD Rules + Conflicts + Evidence ──
  migrate('003_sod_evidence', `
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

  // ── Phase 4: Tenants ──
  migrate('004_tenants', `
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

  // ── Phase 4b: Tenant ID columns ──
  const tenantMigrations = [
    { name: '004b_tenant_id_submissions', table: 'submissions', col: 'tenant_id', def: "'default'" },
    { name: '004c_tenant_id_activity', table: 'activity', col: 'tenant_id', def: "'default'" },
    { name: '004d_tenant_id_admin_users', table: 'admin_users', col: 'tenant_id', def: "'default'" },
  ];
  for (const m of tenantMigrations) {
    migrate(m.name, `ALTER TABLE ${m.table} ADD COLUMN ${m.col} TEXT NOT NULL DEFAULT ${m.def}`);
  }

  // Create tenant indexes
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_submissions_tenant ON submissions(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_activity_tenant ON activity(tenant_id);
  `);

  // ── Phase 4c: Password hash + role columns ──
  migrate('004e_admin_password_hash', "ALTER TABLE admin_users ADD COLUMN password_hash TEXT DEFAULT ''");
  migrate('004f_admin_role', "ALTER TABLE admin_users ADD COLUMN role TEXT DEFAULT 'admin'");

  // ── Phase 5: API Keys ──
  migrate('005_api_keys', `
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

  // ── Phase 5.1: Notifications ──
  migrate('005b_notifications', `
    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      link TEXT NOT NULL DEFAULT '',
      icon TEXT NOT NULL DEFAULT '🔔',
      read INTEGER NOT NULL DEFAULT 0,
      email TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_notifications_tenant ON notifications(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications(tenant_id, read);
    CREATE INDEX IF NOT EXISTS idx_notifications_created ON notifications(created_at DESC);
  `);

  // ── Phase 6: tenant memberships + tenant-scoped role catalog ──
  migrate('006_tenant_memberships', `
    CREATE TABLE IF NOT EXISTS user_accounts (
      email TEXT PRIMARY KEY,
      password_hash TEXT NOT NULL DEFAULT '',
      display_name TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS tenant_memberships (
      email TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'auditor',
      approver_name TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      protected INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (email, tenant_id)
    );
    CREATE INDEX IF NOT EXISTS idx_memberships_tenant_role
      ON tenant_memberships(tenant_id, role, status);
    CREATE INDEX IF NOT EXISTS idx_memberships_email_status
      ON tenant_memberships(email, status);

    INSERT OR IGNORE INTO user_accounts (email, password_hash, created_at, updated_at)
      SELECT email, COALESCE(password_hash, ''), created_at, created_at
      FROM admin_users;
    INSERT OR IGNORE INTO tenant_memberships
      (email, tenant_id, role, protected, created_at, updated_at)
      SELECT email, COALESCE(tenant_id, 'default'), COALESCE(role, 'admin'),
             protected, created_at, created_at
      FROM admin_users;
  `);

  migrate('006b_tenant_role_catalog', `
    CREATE TABLE IF NOT EXISTS tenant_role_assignments (
      tenant_id TEXT NOT NULL,
      role_name TEXT NOT NULL,
      approver_name TEXT NOT NULL DEFAULT '',
      approver_email TEXT NOT NULL DEFAULT '',
      system_name TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (tenant_id, role_name)
    );
    CREATE INDEX IF NOT EXISTS idx_role_assignments_approver
      ON tenant_role_assignments(tenant_id, approver_name);
    CREATE INDEX IF NOT EXISTS idx_role_assignments_email
      ON tenant_role_assignments(tenant_id, approver_email);

    CREATE TABLE IF NOT EXISTS tenant_role_transactions (
      tenant_id TEXT NOT NULL,
      role_name TEXT NOT NULL,
      row_index INTEGER NOT NULL,
      row_json TEXT NOT NULL,
      PRIMARY KEY (tenant_id, role_name, row_index)
    );
    CREATE INDEX IF NOT EXISTS idx_role_transactions_role
      ON tenant_role_transactions(tenant_id, role_name);
  `);

  migrate('007_tenant_transaction_metadata', `
    CREATE TABLE IF NOT EXISTS tenant_transaction_metadata (
      tenant_id TEXT PRIMARY KEY,
      header_json TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Effective identity/account/entitlement assignments and auditable SoD resolution.
  migrate('008_sod_effective_access', `
    CREATE TABLE IF NOT EXISTS access_subjects (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      external_key TEXT NOT NULL,
      email TEXT NOT NULL DEFAULT '',
      display_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      source_snapshot_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (tenant_id, id),
      UNIQUE (tenant_id, external_key)
    );
    CREATE TABLE IF NOT EXISTS access_applications (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      external_key TEXT NOT NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (tenant_id, id),
      UNIQUE (tenant_id, external_key)
    );
    CREATE TABLE IF NOT EXISTS access_accounts (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      application_id TEXT NOT NULL,
      account_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (tenant_id, id),
      UNIQUE (tenant_id, application_id, account_name),
      FOREIGN KEY (tenant_id, subject_id) REFERENCES access_subjects(tenant_id, id),
      FOREIGN KEY (tenant_id, application_id) REFERENCES access_applications(tenant_id, id)
    );
    CREATE TABLE IF NOT EXISTS access_entitlements (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      application_id TEXT NOT NULL,
      external_key TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      entitlement_type TEXT NOT NULL DEFAULT 'business_role',
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (tenant_id, id),
      UNIQUE (tenant_id, application_id, external_key),
      FOREIGN KEY (tenant_id, application_id) REFERENCES access_applications(tenant_id, id)
    );
    CREATE TABLE IF NOT EXISTS access_entitlement_assignments (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      entitlement_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      valid_from TEXT NOT NULL,
      valid_to TEXT NOT NULL DEFAULT '',
      source_snapshot_id TEXT NOT NULL,
      review_owner_name TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (tenant_id, id),
      UNIQUE (tenant_id, subject_id, account_id, entitlement_id, source_snapshot_id),
      FOREIGN KEY (tenant_id, subject_id) REFERENCES access_subjects(tenant_id, id),
      FOREIGN KEY (tenant_id, account_id) REFERENCES access_accounts(tenant_id, id),
      FOREIGN KEY (tenant_id, entitlement_id) REFERENCES access_entitlements(tenant_id, id)
    );
    CREATE INDEX IF NOT EXISTS idx_access_subjects_tenant ON access_subjects(tenant_id, status);
    CREATE INDEX IF NOT EXISTS idx_access_assignments_subject ON access_entitlement_assignments(tenant_id, subject_id, status);
    CREATE INDEX IF NOT EXISTS idx_access_assignments_entitlement ON access_entitlement_assignments(tenant_id, entitlement_id, status);
  `);
  migrate('008b_sod_rule_lifecycle', `
    ALTER TABLE sod_rules ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
    ALTER TABLE sod_rules ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';
  `);
  migrate('008c_sod_conflict_evidence', `
    ALTER TABLE sod_conflicts ADD COLUMN subject_id TEXT NOT NULL DEFAULT '';
    ALTER TABLE sod_conflicts ADD COLUMN subject_name TEXT NOT NULL DEFAULT '';
    ALTER TABLE sod_conflicts ADD COLUMN assignment_a_id TEXT NOT NULL DEFAULT '';
    ALTER TABLE sod_conflicts ADD COLUMN assignment_b_id TEXT NOT NULL DEFAULT '';
    ALTER TABLE sod_conflicts ADD COLUMN source_snapshot_id TEXT NOT NULL DEFAULT '';
    ALTER TABLE sod_conflicts ADD COLUMN resolution_reason TEXT NOT NULL DEFAULT '';
    ALTER TABLE sod_conflicts ADD COLUMN resolution_owner TEXT NOT NULL DEFAULT '';
    ALTER TABLE sod_conflicts ADD COLUMN resolution_expires_at TEXT NOT NULL DEFAULT '';
    ALTER TABLE sod_conflicts ADD COLUMN resolution_evidence TEXT NOT NULL DEFAULT '';
    ALTER TABLE sod_conflicts ADD COLUMN approved_by TEXT NOT NULL DEFAULT '';
    ALTER TABLE sod_conflicts ADD COLUMN approved_at TEXT NOT NULL DEFAULT '';
    ALTER TABLE sod_conflicts ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';
  `);
  migrate('008d_sod_resolution_events', `
    CREATE TABLE IF NOT EXISTS sod_resolution_events (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      conflict_id TEXT NOT NULL,
      from_status TEXT NOT NULL,
      to_status TEXT NOT NULL,
      reason TEXT NOT NULL,
      owner TEXT NOT NULL,
      expires_at TEXT NOT NULL DEFAULT '',
      evidence_ref TEXT NOT NULL DEFAULT '',
      actor TEXT NOT NULL,
      approved_by TEXT NOT NULL DEFAULT '',
      approved_at TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sod_resolution_history
      ON sod_resolution_events(tenant_id, conflict_id, created_at DESC);
  `);
  migrateData('008e_sod_effective_access_backfill', database => {
    require('./sodAccessModel').backfillLegacySodConflicts(database);
  });
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_sod_rule_pair
      ON sod_rules(tenant_id, role_a, role_b);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_sod_conflict_effective_unique
      ON sod_conflicts(tenant_id, rule_id, subject_id, source_snapshot_id)
      WHERE subject_id <> '' AND source_snapshot_id <> '';
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_campaigns_tenant_status
      ON campaigns(tenant_id, status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_submissions_tenant_campaign
      ON submissions(tenant_id, campaign_id, timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_activity_tenant_timestamp
      ON activity(tenant_id, timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_sod_rules_tenant
      ON sod_rules(tenant_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sod_conflicts_tenant_status
      ON sod_conflicts(tenant_id, status, detected_at DESC);
    CREATE INDEX IF NOT EXISTS idx_evidence_tenant_campaign
      ON evidence_packages(tenant_id, campaign_id, generated_at DESC);
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

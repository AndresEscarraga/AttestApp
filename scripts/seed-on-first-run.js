// Seed on first run — generates sample Excel files + populates SQLite with demo data.
// Called from server.js on startup when DB is empty.
// Usage: node scripts/seed-on-first-run.js

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { writeWorkbook } = require('../services/excelWorkbook');
const { backfillLegacySodConflicts } = require('../stores/sodAccessModel');

const REPORTS_DIR = process.env.REPORTS_DIR || path.join(__dirname, '..', 'Reports');
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'attest.db');

// ── Helpers ──
function uid(prefix) { return (prefix || 'id_') + crypto.randomUUID().slice(0, 8); }
function daysAgo(n) { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString(); }
function hoursAgo(h) { const d = new Date(); d.setHours(d.getHours() - h); return d.toISOString(); }

// ── Synthetic data ──
const approvers = [
  { fullName: 'Morgan Taylor', email: 'approver.one@attest.local' },
  { fullName: 'Jamie Rivera', email: 'approver.two@attest.local' },
  { fullName: 'Casey Morrison', email: 'approver.three@attest.local' },
  { fullName: 'Riley Thompson', email: 'approver.four@attest.local' },
  { fullName: 'Quinn Harrison', email: 'approver.five@attest.local' },
];

const roles = [
  { roleName: 'BE - FINANCE - ACCOUNTS PAYABLE', approver: 'Morgan Taylor', system: 'SAP' },
  { roleName: 'BE - FINANCE - ACCOUNTS RECEIVABLE', approver: 'Morgan Taylor', system: 'SAP' },
  { roleName: 'BE - FINANCE - GENERAL LEDGER', approver: 'Morgan Taylor', system: 'SAP' },
  { roleName: 'BE - HR - EMPLOYEE DATA', approver: 'Jamie Rivera', system: 'SAP' },
  { roleName: 'BE - HR - PAYROLL PROCESSING', approver: 'Jamie Rivera', system: 'SAP' },
  { roleName: 'BE - IT - SYSTEM ADMINISTRATOR', approver: 'Casey Morrison', system: 'SAP' },
  { roleName: 'BE - IT - NETWORK ENGINEER', approver: 'Casey Morrison', system: 'AWS' },
  { roleName: 'BE - IT - HELP DESK SUPPORT', approver: 'Casey Morrison', system: 'Jira' },
  { roleName: 'BE - SALES - CUSTOMER MANAGEMENT', approver: 'Riley Thompson', system: 'Salesforce' },
  { roleName: 'BE - SALES - ORDER PROCESSING', approver: 'Riley Thompson', system: 'SAP' },
  { roleName: 'BE - WAREHOUSE - INVENTORY CONTROL', approver: 'Quinn Harrison', system: 'SAP' },
  { roleName: 'BE - WAREHOUSE - SHIPPING & RECEIVING', approver: 'Quinn Harrison', system: 'SAP' },
  { roleName: 'BE - PROCUREMENT - PURCHASE ORDERS', approver: 'Morgan Taylor', system: 'SAP' },
  { roleName: 'BE - PROCUREMENT - VENDOR MANAGEMENT', approver: 'Jamie Rivera', system: 'SAP' },
  { roleName: 'BE - QUALITY - INSPECTION CONTROL', approver: 'Riley Thompson', system: 'SAP' },
];

const technicalRoles = [
  { role: 'SAP_FI_AP_CLERK', desc: 'SAP FI Accounts Payable Clerk role', permission: 'F-43: Enter Vendor Invoice' },
  { role: 'SAP_FI_AP_CLERK', desc: 'SAP FI Accounts Payable Clerk role', permission: 'F-44: Clear Vendor Open Items' },
  { role: 'SAP_FI_AP_CLERK', desc: 'SAP FI Accounts Payable Clerk role', permission: 'FK01: Create Vendor Master' },
  { role: 'SAP_FI_AR_CLERK', desc: 'SAP FI Accounts Receivable Clerk role', permission: 'F-22: Enter Customer Invoice' },
  { role: 'SAP_FI_AR_CLERK', desc: 'SAP FI Accounts Receivable Clerk role', permission: 'F-28: Post Incoming Payment' },
  { role: 'SAP_FI_GL_ACCT', desc: 'SAP FI General Ledger Accountant role', permission: 'F-02: General Posting' },
  { role: 'SAP_FI_GL_ACCT', desc: 'SAP FI General Ledger Accountant role', permission: 'FB50: GL Account Document' },
  { role: 'SAP_HR_PA_ADMIN', desc: 'SAP HR Personnel Admin role', permission: 'PA30: Maintain HR Master Data' },
  { role: 'SAP_HR_PA_ADMIN', desc: 'SAP HR Personnel Admin role', permission: 'PA20: Display HR Master Data' },
  { role: 'SAP_HR_PY_PROC', desc: 'SAP HR Payroll Processing role', permission: 'PC00_M99_CALC: Payroll Calculation' },
  { role: 'SAP_HR_PY_PROC', desc: 'SAP HR Payroll Processing role', permission: 'PC00_M99_CLSTR: Display Payroll Results' },
  { role: 'SAP_BASIS_ADMIN', desc: 'SAP Basis Administrator role', permission: 'SU01: User Maintenance' },
  { role: 'SAP_BASIS_ADMIN', desc: 'SAP Basis Administrator role', permission: 'PFCG: Role Maintenance' },
  { role: 'SAP_BASIS_ADMIN', desc: 'SAP Basis Administrator role', permission: 'SM59: RFC Destinations' },
  { role: 'SAP_MM_IM_CLERK', desc: 'SAP MM Inventory Management Clerk role', permission: 'MIGO: Goods Movement' },
  { role: 'SAP_MM_IM_CLERK', desc: 'SAP MM Inventory Management Clerk role', permission: 'MB51: Material Document List' },
  { role: 'SAP_MM_PUR_BUYER', desc: 'SAP MM Purchasing Buyer role', permission: 'ME21N: Create Purchase Order' },
  { role: 'SAP_MM_PUR_BUYER', desc: 'SAP MM Purchasing Buyer role', permission: 'ME22N: Change Purchase Order' },
  { role: 'SAP_SD_SLS_REP', desc: 'SAP SD Sales Representative role', permission: 'VA01: Create Sales Order' },
  { role: 'SAP_SD_SLS_REP', desc: 'SAP SD Sales Representative role', permission: 'VA02: Change Sales Order' },
  { role: 'SAP_SD_SHP_CLERK', desc: 'SAP SD Shipping Clerk role', permission: 'VL01N: Create Outbound Delivery' },
  { role: 'SAP_SD_SHP_CLERK', desc: 'SAP SD Shipping Clerk role', permission: 'VL02N: Change Outbound Delivery' },
  { role: 'SAP_QM_INSPECTOR', desc: 'SAP QM Inspector role', permission: 'QA01: Create Inspection Lot' },
  { role: 'SAP_QM_INSPECTOR', desc: 'SAP QM Inspector role', permission: 'QE51N: Record Inspection Results' },
];

const roleToTechnical = {
  'BE - FINANCE - ACCOUNTS PAYABLE': ['SAP_FI_AP_CLERK'],
  'BE - FINANCE - ACCOUNTS RECEIVABLE': ['SAP_FI_AR_CLERK'],
  'BE - FINANCE - GENERAL LEDGER': ['SAP_FI_GL_ACCT'],
  'BE - HR - EMPLOYEE DATA': ['SAP_HR_PA_ADMIN'],
  'BE - HR - PAYROLL PROCESSING': ['SAP_HR_PY_PROC'],
  'BE - IT - SYSTEM ADMINISTRATOR': ['SAP_BASIS_ADMIN'],
  'BE - WAREHOUSE - INVENTORY CONTROL': ['SAP_MM_IM_CLERK'],
  'BE - PROCUREMENT - PURCHASE ORDERS': ['SAP_MM_PUR_BUYER'],
  'BE - SALES - CUSTOMER MANAGEMENT': ['SAP_SD_SLS_REP'],
  'BE - WAREHOUSE - SHIPPING & RECEIVING': ['SAP_SD_SHP_CLERK'],
  'BE - QUALITY - INSPECTION CONTROL': ['SAP_QM_INSPECTOR'],
};

const approverRoles = {
  'Morgan Taylor': ['BE - FINANCE - ACCOUNTS PAYABLE', 'BE - FINANCE - ACCOUNTS RECEIVABLE', 'BE - FINANCE - GENERAL LEDGER', 'BE - PROCUREMENT - PURCHASE ORDERS'],
  'Jamie Rivera': ['BE - HR - EMPLOYEE DATA', 'BE - HR - PAYROLL PROCESSING', 'BE - PROCUREMENT - VENDOR MANAGEMENT'],
  'Casey Morrison': ['BE - IT - HELP DESK SUPPORT', 'BE - IT - NETWORK ENGINEER', 'BE - IT - SYSTEM ADMINISTRATOR'],
  'Riley Thompson': ['BE - QUALITY - INSPECTION CONTROL', 'BE - SALES - CUSTOMER MANAGEMENT', 'BE - SALES - ORDER PROCESSING'],
  'Quinn Harrison': ['BE - WAREHOUSE - INVENTORY CONTROL', 'BE - WAREHOUSE - SHIPPING & RECEIVING'],
};

// ── Step 1: Generate Excel files ──
async function generateExcelFiles() {
  fs.mkdirSync(REPORTS_DIR, { recursive: true });

  // Roles Approvers.xlsx
  // "Complete" sheet
  const completeHeader = ['Role Name', 'Role Description', 'Department', 'Approver Full Name'];
  const completeRows = [completeHeader];
  for (const role of roles) {
    completeRows.push([role.roleName, `Description for ${role.roleName}`, role.roleName.split(' - ')[1] || '', role.approver]);
  }
  // "Emails" sheet — map approver names to emails + admin mapping
  const emailsHeader = ['Full Name', 'Email'];
  const emailsRows = [emailsHeader];
  for (const a of approvers) {
    emailsRows.push([a.fullName, a.email]);
  }
  // Map admin emails to approvers (so admins can see reviews without impersonation)
  emailsRows.push([approvers[0].fullName, 'admin.one@attest.local']);
  emailsRows.push([approvers[1].fullName, 'admin.two@attest.local']);
  // Also check for real admin email from env
  const realAdmin = process.env.DEV_AUTH_EMAIL || process.env.ADMIN_EMAIL || '';
  if (realAdmin && realAdmin.includes('@')) {
    emailsRows.push([approvers[0].fullName, realAdmin]);
  }
  const rolesPath = path.join(REPORTS_DIR, process.env.ROLES_FILE_NAME || 'Roles Approvers.xlsx');
  await writeWorkbook(rolesPath, [
    { name: 'Complete', rows: completeRows },
    { name: 'Emails', rows: emailsRows },
  ]);
  console.log(`[seed] Generated: ${rolesPath} (${roles.length} roles)`);

  // Transactions.xlsx
  const txHeader = ['Role Name', 'Associated Role', 'Associated Role Description', 'Permission Name'];
  const txRows = [txHeader];
  for (const [businessRole, techList] of Object.entries(roleToTechnical)) {
    for (const techRole of techList) {
      const perms = technicalRoles.filter(tr => tr.role === techRole);
      for (const perm of perms) {
        txRows.push([businessRole, perm.role, perm.desc, perm.permission]);
      }
    }
  }
  const txPath = path.join(REPORTS_DIR, process.env.TX_FILE_NAME || 'Transactions.xlsx');
  await writeWorkbook(txPath, [{ name: 'Transactions', rows: txRows }]);
  console.log(`[seed] Generated: ${txPath} (${txRows.length - 1} transaction rows)`);
}

function ensureIdentitySeed(db) {
  const bcrypt = require('bcrypt');
  const demoPassword = bcrypt.hashSync('password123', 10);
  const now = new Date().toISOString();
  const tenants = [
    { id: 'default', name: 'Default Organization', plan: 'starter', settings: '{}' },
    { id: 'tenant-beta', name: 'Beta Manufacturing', plan: 'professional', settings: '{"accent":"beta","email_notifications":true}' },
  ];
  const insertTenant = db.prepare(`
    INSERT OR IGNORE INTO tenants (id, name, plan, status, settings, created_at, updated_at)
    VALUES (?, ?, ?, 'active', ?, ?, ?)
  `);
  tenants.forEach(tenant => insertTenant.run(
    tenant.id, tenant.name, tenant.plan, tenant.settings, daysAgo(30), daysAgo(1)
  ));

  const identities = [
    { email: 'admin.one@attest.local', tenant: 'default', role: 'admin' },
    { email: 'admin.two@attest.local', tenant: 'default', role: 'admin' },
    { email: 'approver.one@attest.local', tenant: 'default', role: 'approver', approver: 'Morgan Taylor' },
    { email: 'approver.two@attest.local', tenant: 'default', role: 'approver', approver: 'Jamie Rivera' },
    { email: 'approver.three@attest.local', tenant: 'default', role: 'approver', approver: 'Casey Morrison' },
    { email: 'approver.four@attest.local', tenant: 'default', role: 'approver', approver: 'Riley Thompson' },
    { email: 'approver.five@attest.local', tenant: 'default', role: 'approver', approver: 'Quinn Harrison' },
    { email: 'auditor.one@attest.local', tenant: 'default', role: 'auditor' },
    { email: 'auditor.two@attest.local', tenant: 'default', role: 'auditor' },
    { email: 'superadmin.one@attest.local', tenant: 'default', role: 'admin', protected: 1 },
    { email: 'superadmin.two@attest.local', tenant: 'default', role: 'admin', protected: 1 },
    { email: 'admin.one@attest.local', tenant: 'tenant-beta', role: 'admin' },
    { email: 'admin.two@attest.local', tenant: 'tenant-beta', role: 'auditor' },
    { email: 'approver.one@attest.local', tenant: 'tenant-beta', role: 'approver', approver: 'Avery Chen' },
    { email: 'approver.two@attest.local', tenant: 'tenant-beta', role: 'approver', approver: 'Jordan Lee' },
    { email: 'auditor.one@attest.local', tenant: 'tenant-beta', role: 'auditor' },
    { email: 'admin.beta@attest.local', tenant: 'tenant-beta', role: 'admin' },
  ];
  const insertAccount = db.prepare(`
    INSERT OR IGNORE INTO user_accounts
      (email, password_hash, created_at, updated_at)
    VALUES (?, ?, ?, ?)
  `);
  const fillSeedPassword = db.prepare(`
    UPDATE user_accounts SET password_hash = ?, updated_at = ?
    WHERE email = ? AND password_hash = ''
  `);
  const insertMembership = db.prepare(`
    INSERT OR IGNORE INTO tenant_memberships
      (email, tenant_id, role, approver_name, status, protected, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'active', ?, ?, ?)
  `);
  const fillApprover = db.prepare(`
    UPDATE tenant_memberships SET approver_name = ?, updated_at = ?
    WHERE email = ? AND tenant_id = ? AND approver_name = ''
  `);
  db.transaction(() => {
    identities.forEach(identity => {
      insertAccount.run(identity.email, demoPassword, now, now);
      fillSeedPassword.run(demoPassword, now, identity.email);
      insertMembership.run(
        identity.email,
        identity.tenant,
        identity.role,
        identity.approver || '',
        identity.protected || 0,
        now,
        now
      );
      if (identity.approver) {
        fillApprover.run(identity.approver, now, identity.email, identity.tenant);
      }
    });
  })();
  return demoPassword;
}

function ensureBetaSeed(db) {
  const tenantId = 'tenant-beta';
  const betaRoles = [
    { role: 'BETA - FINANCE - BILLING', approver: 'Avery Chen', email: 'approver.one@attest.local', system: 'Oracle' },
    { role: 'BETA - FINANCE - CASH APPLICATION', approver: 'Avery Chen', email: 'approver.one@attest.local', system: 'Oracle' },
    { role: 'BETA - IT - CLOUD OPERATIONS', approver: 'Jordan Lee', email: 'approver.two@attest.local', system: 'Azure' },
    { role: 'BETA - IT - SECURITY MONITORING', approver: 'Jordan Lee', email: 'approver.two@attest.local', system: 'Sentinel' },
  ];
  const insertRole = db.prepare(`
    INSERT OR IGNORE INTO tenant_role_assignments
      (tenant_id, role_name, approver_name, approver_email, system_name)
    VALUES (?, ?, ?, ?, ?)
  `);
  const insertTransaction = db.prepare(`
    INSERT OR IGNORE INTO tenant_role_transactions
      (tenant_id, role_name, row_index, row_json)
    VALUES (?, ?, ?, ?)
  `);
  betaRoles.forEach((item, index) => {
    insertRole.run(tenantId, item.role, item.approver, item.email, item.system);
    insertTransaction.run(tenantId, item.role, 0, JSON.stringify([
      item.role,
      `BETA_TECH_${index + 1}`,
      `${item.system} synthetic technical role`,
      `BETA_PERMISSION_${index + 1}`,
    ]));
  });
  db.prepare(`
    INSERT INTO tenant_transaction_metadata (tenant_id, header_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(tenant_id) DO UPDATE SET
      header_json = excluded.header_json,
      updated_at = excluded.updated_at
  `).run(
    tenantId,
    JSON.stringify(['Business Role', 'Technical Role', 'Technical Role Description', 'Permission Name']),
    new Date().toISOString()
  );

  const insertCampaign = db.prepare(`
    INSERT OR IGNORE INTO campaigns
      (id, tenant_id, name, description, framework, period, status, deadline,
       approvers, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertCampaign.run(
    'beta_access_q4', tenantId, 'BETA — Q4 Access Review',
    'Synthetic Beta Manufacturing certification campaign', 'SOX', 'Q4 2026',
    'active', '2026-12-15', JSON.stringify(['Avery Chen', 'Jordan Lee']),
    'admin.one@attest.local', daysAgo(12), daysAgo(1)
  );
  insertCampaign.run(
    'beta_cloud_review', tenantId, 'BETA — Cloud Privileged Access',
    'Synthetic Azure privileged access campaign', 'NIST', '2026',
    'draft', '2026-12-31', JSON.stringify(['Jordan Lee']),
    'admin.one@attest.local', daysAgo(5), daysAgo(1)
  );

  db.prepare(`
    INSERT OR IGNORE INTO submissions
      (log_entry_id, submission_id, tenant_id, timestamp, approver,
       submitted_by_email, impersonated, role_name, action, ritm, ritm_status,
       action_details, comments, rejection_reason, row_index, campaign_id)
    VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, '', '', '', 1, ?)
  `).run(
    'beta-000001-001', 'B00001', tenantId, daysAgo(2), 'Avery Chen',
    'approver.one@attest.local', 'BETA - FINANCE - BILLING',
    'Keep Business Role', 'BETA-RITM-1001', 'Resolved', 'beta_access_q4'
  );

  db.prepare(`
    INSERT OR IGNORE INTO sod_rules
      (id, tenant_id, name, role_a, role_b, severity, description, framework,
       created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'beta_sod_finance', tenantId, 'BETA-SOD-001: Billing + Cash Application',
    'BETA - FINANCE - BILLING', 'BETA - FINANCE - CASH APPLICATION',
    'high', 'Synthetic incompatible finance duties', 'SOX',
    'admin.one@attest.local', daysAgo(8)
  );
  db.prepare(`
    INSERT OR IGNORE INTO sod_conflicts
      (id, tenant_id, rule_id, user_email, approver_name, role_a, role_b,
       severity, detected_at, status, mitigated_by, mitigated_at, mitigation_notes, subject_name)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', '', '', '', ?)
  `).run(
    'beta_conflict_001', tenantId, 'beta_sod_finance',
    'synthetic.finance.user@beta.test', 'Avery Chen',
    'BETA - FINANCE - BILLING', 'BETA - FINANCE - CASH APPLICATION',
    'high', daysAgo(3), 'Beta Finance User (Synthetic)'
  );

  db.prepare(`
    INSERT OR IGNORE INTO evidence_packages
      (id, tenant_id, name, campaign_id, description, file_path, file_size,
       generated_by, generated_at, share_token, share_expires_at)
    VALUES (?, ?, ?, ?, ?, '', 0, ?, ?, '', '')
  `).run(
    'beta_ev_001', tenantId, 'BETA — Synthetic Q4 Evidence',
    'beta_access_q4', 'Synthetic evidence placeholder for tenant wiring',
    'admin.one@attest.local', daysAgo(1)
  );

  db.prepare(`
    INSERT OR IGNORE INTO activity
      (activity_id, tenant_id, timestamp, type, action, email, detail)
    VALUES (?, ?, ?, 'CAMPAIGN', 'campaign_activated', ?, ?)
  `).run(
    'beta_activity_001', tenantId, hoursAgo(6), 'admin.one@attest.local',
    'BETA — Q4 Access Review activated'
  );
  db.prepare(`
    INSERT OR IGNORE INTO notifications
      (id, tenant_id, type, title, body, link, icon, read, email, created_at)
    VALUES (?, ?, 'campaign', ?, ?, '/campaigns.html', '📋', 0, ?, ?)
  `).run(
    'beta_notif_001', tenantId, 'BETA campaign active',
    'BETA — Q4 Access Review is ready for synthetic testing.',
    'admin.one@attest.local', hoursAgo(6)
  );
}

// ── Step 2: Seed SQLite ──
function seedDatabase() {
  // Import db module (after Excel files are generated so the data dir exists)
  const { getDb } = require('../stores/db');
  const db = getDb();
  const demoPassword = ensureIdentitySeed(db);

  // Check if already seeded
  const existingCampaigns = db.prepare('SELECT COUNT(*) as cnt FROM campaigns').get();
  if (existingCampaigns && existingCampaigns.cnt > 0) {
    console.log('[seed] Database already has campaigns — skipping seed.');
    // Still ensure default tenant exists
    const dt = db.prepare("SELECT id FROM tenants WHERE id = 'default'").get();
    if (!dt) {
      db.prepare("INSERT INTO tenants (id, name, plan, status) VALUES (?, ?, ?, ?)").run('default', 'Default Organization', 'starter', 'active');
    }
    ensureBetaSeed(db);
    backfillLegacySodConflicts(db);
    return;
  }

  console.log('[seed] Seeding database with demo data...');

  // Tenants
  const tenants = [
    { id: 'default', name: 'Default Organization', plan: 'starter', status: 'active' },
  ];
  const insertTenant = db.prepare('INSERT OR REPLACE INTO tenants (id, name, plan, status, created_at, updated_at) VALUES (?,?,?,?,?,?)');
  for (const t of tenants) {
    insertTenant.run(t.id, t.name, t.plan, t.status, daysAgo(30), daysAgo(1));
  }

  // Users with roles: admin, approver, auditor — password: "password123" for all
  const users = [
    { email: 'admin.one@attest.local', role: 'admin', protected: 0 },
    { email: 'admin.two@attest.local', role: 'admin', protected: 0 },
    { email: 'approver.one@attest.local', role: 'approver', protected: 0 },
    { email: 'approver.two@attest.local', role: 'approver', protected: 0 },
    { email: 'approver.three@attest.local', role: 'approver', protected: 0 },
    { email: 'approver.four@attest.local', role: 'approver', protected: 0 },
    { email: 'approver.five@attest.local', role: 'approver', protected: 0 },
    { email: 'auditor.one@attest.local', role: 'auditor', protected: 0 },
    { email: 'auditor.two@attest.local', role: 'auditor', protected: 0 },
    { email: 'superadmin.one@attest.local', role: 'admin', protected: 1 },
    { email: 'superadmin.two@attest.local', role: 'admin', protected: 1 },
  ];
  const insertUser = db.prepare('INSERT OR REPLACE INTO admin_users (email, tenant_id, protected, role, password_hash) VALUES (?,?,?,?,?)');
  for (const u of users) {
    insertUser.run(u.email, 'default', u.protected, u.role, demoPassword);
  }
  console.log('[seed] Users:', users.length);

  // Campaigns
  const campaigns = [
    { id: 'camp_sox_q3', name: 'Q3 SOX ITGC Access Review', framework: 'SOX', period: 'Q3 2026', status: 'active', deadline: '2026-08-31', approvers: ['Morgan Taylor', 'Jamie Rivera', 'Casey Morrison', 'Riley Thompson', 'Quinn Harrison'] },
    { id: 'camp_iso_annual', name: 'ISO 27001 Annual Re-certification', framework: 'ISO27001', period: '2026', status: 'draft', deadline: '2026-12-15', approvers: ['Morgan Taylor', 'Jamie Rivera', 'Casey Morrison', 'Riley Thompson', 'Quinn Harrison'] },
    { id: 'camp_soc2', name: 'SOC 2 Type II — CC6.1 Controls', framework: 'SOC2', period: 'H2 2026', status: 'completed', deadline: '2026-06-30', approvers: ['Morgan Taylor', 'Jamie Rivera', 'Casey Morrison'] },
    { id: 'camp_onboard_aug', name: 'New Hire Onboarding — Aug 2026', framework: 'ITGC', period: 'Aug 2026', status: 'active', deadline: '2026-08-20', approvers: ['Riley Thompson', 'Quinn Harrison'] },
  ];
  const insertCampaign = db.prepare(`INSERT INTO campaigns (id, tenant_id, name, description, framework, period, status, deadline, approvers, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const c of campaigns) {
    insertCampaign.run(c.id, 'default', c.name, '', c.framework, c.period, c.status, c.deadline, JSON.stringify(c.approvers), 'admin.one@attest.local', daysAgo(20), daysAgo(1));
  }
  console.log('[seed] Campaigns:', campaigns.length);

  // SoD Rules
  const sodRules = [
    { id: 'sod_ap_gl', name: 'SOX-AP-001: AP Clerk + GL Accountant', role_a: 'BE - FINANCE - ACCOUNTS PAYABLE', role_b: 'BE - FINANCE - GENERAL LEDGER', severity: 'critical', description: 'Cannot both disburse funds and reconcile the general ledger', framework: 'SOX' },
    { id: 'sod_po_inv', name: 'SOX-PO-003: PO Creator + Inventory Control', role_a: 'BE - PROCUREMENT - PURCHASE ORDERS', role_b: 'BE - WAREHOUSE - INVENTORY CONTROL', severity: 'high', description: 'Cannot create POs and manage inventory receiving', framework: 'SOX' },
    { id: 'sod_hr_pay', name: 'SOX-HR-007: HR Admin + Payroll', role_a: 'BE - HR - EMPLOYEE DATA', role_b: 'BE - HR - PAYROLL PROCESSING', severity: 'high', description: 'Cannot modify HR master data and process payroll', framework: 'SOX' },
  ];
  const insertSodRule = db.prepare('INSERT INTO sod_rules (id, tenant_id, name, role_a, role_b, severity, description, framework, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)');
  for (const r of sodRules) {
    insertSodRule.run(r.id, 'default', r.name, r.role_a, r.role_b, r.severity, r.description, r.framework, 'admin.one@attest.local', daysAgo(10));
  }
  console.log('[seed] SoD Rules:', sodRules.length);

  // SoD Conflicts
  const sodConflicts = [
    { id: 'conf_001', rule_id: 'sod_ap_gl', user_email: 'alex.carter@synthetic.default.test', subject_name: 'Alex Carter (Synthetic)', approver_name: 'Morgan Taylor', role_a: 'BE - FINANCE - ACCOUNTS PAYABLE', role_b: 'BE - FINANCE - GENERAL LEDGER', severity: 'critical', status: 'open', detected_at: daysAgo(5) },
    { id: 'conf_002', rule_id: 'sod_po_inv', user_email: 'sam.river@synthetic.default.test', subject_name: 'Sam River (Synthetic)', approver_name: 'Morgan Taylor', role_a: 'BE - PROCUREMENT - PURCHASE ORDERS', role_b: 'BE - WAREHOUSE - INVENTORY CONTROL', severity: 'high', status: 'open', detected_at: daysAgo(3) },
    { id: 'conf_003', rule_id: 'sod_hr_pay', user_email: 'taylor.gray@synthetic.default.test', subject_name: 'Taylor Gray (Synthetic)', approver_name: 'Jamie Rivera', role_a: 'BE - HR - EMPLOYEE DATA', role_b: 'BE - HR - PAYROLL PROCESSING', severity: 'high', status: 'mitigated', detected_at: daysAgo(7), mitigated_by: 'admin.one@attest.local', mitigated_at: daysAgo(6), mitigation_notes: 'Compensating review splits HR master-data and payroll approval.' },
  ];
  const insertSodConflict = db.prepare(`INSERT INTO sod_conflicts (id, tenant_id, rule_id, user_email, approver_name, role_a, role_b, severity, detected_at, status, mitigated_by, mitigated_at, mitigation_notes, subject_name) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const c of sodConflicts) {
    insertSodConflict.run(c.id, 'default', c.rule_id, c.user_email, c.approver_name, c.role_a, c.role_b, c.severity, c.detected_at, c.status, c.mitigated_by || '', c.mitigated_at || '', c.mitigation_notes || '', c.subject_name);
  }
  console.log('[seed] SoD Conflicts:', sodConflicts.length);

  // Submissions — simulate real certification workflow across approvers
  // SOX campaign: Morgan 4/4✓, Jamie 2/3 (in progress), Casey 3/3✓, Riley 0/3, Quinn 0/2
  // Total: 9 of 15 reviewed = 60% across 3 approvers
  const insertSubmission = db.prepare(`INSERT INTO submissions (log_entry_id, submission_id, tenant_id, timestamp, approver, submitted_by_email, impersonated, role_name, action, ritm, ritm_status, action_details, comments, rejection_reason, row_index, campaign_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

  const workflowSubmissions = [
    // Morgan Taylor — all 4 reviewed (100% complete) — approver.one@attest.local
    { idx:1, approver:'Morgan Taylor', role:'BE - FINANCE - ACCOUNTS PAYABLE', action:'Keep Business Role', ritm:'RITM004810', ritmStatus:'Resolved', days:4, email:'approver.one@attest.local' },
    { idx:2, approver:'Morgan Taylor', role:'BE - FINANCE - ACCOUNTS RECEIVABLE', action:'Keep Business Role', ritm:'', ritmStatus:'Resolved', days:3, email:'approver.one@attest.local' },
    { idx:3, approver:'Morgan Taylor', role:'BE - FINANCE - GENERAL LEDGER', action:'Modify Business Role', ritm:'RITM004795', ritmStatus:'Open', days:3, email:'approver.one@attest.local' },
    { idx:4, approver:'Morgan Taylor', role:'BE - PROCUREMENT - PURCHASE ORDERS', action:'Keep Business Role', ritm:'', ritmStatus:'Resolved', days:2, email:'approver.one@attest.local' },

    // Jamie Rivera — 2 of 3 reviewed, 1 pending (67% complete) — approver.two@attest.local
    { idx:5, approver:'Jamie Rivera', role:'BE - HR - EMPLOYEE DATA', action:'Keep Business Role', ritm:'', ritmStatus:'Resolved', days:5, email:'approver.two@attest.local' },
    { idx:6, approver:'Jamie Rivera', role:'BE - HR - PAYROLL PROCESSING', action:'Keep Business Role', ritm:'', ritmStatus:'Resolved', days:4, email:'approver.two@attest.local' },
    // BE - PROCUREMENT - VENDOR MANAGEMENT → NOT reviewed (pending)

    // Casey Morrison — all 3 reviewed (100% complete) — approver.three@attest.local
    { idx:7, approver:'Casey Morrison', role:'BE - IT - SYSTEM ADMINISTRATOR', action:'Keep Business Role', ritm:'', ritmStatus:'Resolved', days:6, email:'approver.three@attest.local' },
    { idx:8, approver:'Casey Morrison', role:'BE - IT - NETWORK ENGINEER', action:'Keep Business Role', ritm:'', ritmStatus:'Resolved', days:5, email:'approver.three@attest.local' },
    { idx:9, approver:'Casey Morrison', role:'BE - IT - HELP DESK SUPPORT', action:'Modify Technical Role', ritm:'RITM004812', ritmStatus:'Open', days:6, email:'approver.three@attest.local' },
  ];

  // Riley Thompson (0/3) and Quinn Harrison (0/2) have no submissions yet — pending

  let subIdx = 0;
  for (const s of workflowSubmissions) {
    subIdx++;
    const id = String(s.idx).padStart(6, '0');
    const ts = daysAgo(s.days);
    insertSubmission.run(
      id + '-001', id, 'default', ts, s.approver, s.email, 0,
      s.role, s.action, s.ritm, s.ritmStatus,
      '', '', '', subIdx, 'camp_sox_q3'
    );
  }
  console.log('[seed] Submissions:', subIdx, '(Morgan 4/4✓, Jamie 2/3, Casey 3/3✓, Riley 0/3 pending, Quinn 0/2 pending)');

  // Evidence packages
  const evidencePackages = [
    { id: 'ev_001', name: 'Q3 SOX ITGC — Final Certification Package', campaign_id: 'camp_sox_q3', description: 'Complete certification package for PwC audit review. Includes all role attestations, activity logs, and campaign summary.', file_size: 4200000, generated_at: daysAgo(2), share_token: '', share_expires_at: '' },
    { id: 'ev_002', name: 'SOC 2 Type II — CC6.1 Evidence Package', campaign_id: 'camp_soc2', description: 'SOC 2 evidence for access control certification. Covers all CC6.1 criteria for logical access.', file_size: 2800000, generated_at: daysAgo(5), share_token: 'share_demo_soc2', share_expires_at: new Date(Date.now() + 30 * 24 * 3600000).toISOString() },
  ];
  const insertEvidence = db.prepare('INSERT INTO evidence_packages (id, tenant_id, name, campaign_id, description, file_path, file_size, generated_by, generated_at, share_token, share_expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  for (const e of evidencePackages) {
    insertEvidence.run(e.id, 'default', e.name, e.campaign_id, e.description, '', e.file_size, 'admin.one@attest.local', e.generated_at, e.share_token, e.share_expires_at);
  }
  console.log('[seed] Evidence packages:', evidencePackages.length);

  // Activity log
  const activities = [
    { type: 'SUBMISSION', action: 'submission_created', email: 'jamie.rivera@attest.local', detail: 'Jamie Rivera approved 4 roles — SAP FI Module', hours: 2 },
    { type: 'CAMPAIGN', action: 'campaign_created', email: 'admin.one@attest.local', detail: 'New campaign created: Q3 SOX ITGC Review', hours: 10 },
    { type: 'SOD', action: 'sod_conflict_detected', email: 'admin.one@attest.local', detail: 'SoD conflict flagged: GL Accountant + AP Clerk (Morgan Taylor)', hours: 16 },
    { type: 'EVIDENCE', action: 'evidence_generated', email: 'admin.one@attest.local', detail: 'Evidence package exported for PwC audit — 4.2 MB', hours: 24 },
    { type: 'AUTH', action: 'data_uploaded', email: 'admin.one@attest.local', detail: 'Data source updated: Roles Approvers.xlsx (15 roles)', hours: 48 },
    { type: 'SUBMISSION', action: 'submission_created', email: 'casey.morrison@attest.local', detail: 'Casey Morrison certified 3 IT roles', hours: 30 },
    { type: 'CAMPAIGN', action: 'campaign_activated', email: 'admin.one@attest.local', detail: 'Campaign activated: ISO 27001 Annual Re-certification', hours: 36 },
    { type: 'SOD', action: 'sod_rule_created', email: 'admin.one@attest.local', detail: 'New SoD rule: PO Creator + Vendor Manager (high)', hours: 72 },
    { type: 'SUBMISSION', action: 'submission_created', email: 'riley.thompson@attest.local', detail: 'Riley Thompson reviewed 3 Sales roles', hours: 6 },
    { type: 'SUBMISSION', action: 'submission_created', email: 'morgan.taylor@attest.local', detail: 'Morgan Taylor approved 4 Finance roles', hours: 1 },
  ];
  const insertActivity = db.prepare('INSERT INTO activity (activity_id, tenant_id, timestamp, type, action, email, detail) VALUES (?,?,?,?,?,?,?)');
  for (const a of activities) {
    insertActivity.run(uid('act_'), 'default', hoursAgo(a.hours), a.type, a.action, a.email, a.detail);
  }
  console.log('[seed] Activity events:', activities.length);

  // Notifications
  const notifications = [
    { type:'campaign', title:'Campaign activated', body:'"Q3 SOX ITGC Access Review" is now active. 5 approvers assigned.', link:'/campaigns.html', icon:'📋', hours: 10 },
    { type:'submission', title:'New certifications submitted', body:'Jamie Rivera certified 4 roles in SAP FI Module.', link:'/audit-trail.html', icon:'✅', hours: 2 },
    { type:'sod', title:'2 SoD conflicts detected', body:'Critical: AP Clerk + GL Accountant (Morgan Taylor). Review needed.', link:'/sod.html', icon:'⚠️', hours: 16 },
    { type:'evidence', title:'Evidence package generated', body:'"Q3 SOX ITGC — Final Certification Package" ready for PwC audit.', link:'/evidence.html', icon:'📦', hours: 24 },
    { type:'submission', title:'IT roles certified', body:'Casey Morrison certified 3 IT roles (System Admin, Network, Help Desk).', link:'/audit-trail.html', icon:'✅', hours: 30 },
    { type:'campaign', title:'New campaign created', body:'"ISO 27001 Annual Re-certification" is in draft. Configure approvers to activate.', link:'/campaigns.html', icon:'📋', hours: 36 },
    { type:'system', title:'Data source updated', body:'Roles Approvers.xlsx uploaded with 15 business roles across 7 systems.', link:'/data-sources.html', icon:'📊', hours: 48 },
  ];
  const insertNotif = db.prepare('INSERT INTO notifications (id, tenant_id, type, title, body, link, icon, read, email, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)');
  for (const n of notifications) {
    insertNotif.run(uid('notif_'), 'default', n.type, n.title, n.body, n.link, n.icon, 0, 'admin.one@attest.local', hoursAgo(n.hours));
  }
  console.log('[seed] Notifications:', notifications.length);

  ensureBetaSeed(db);
  backfillLegacySodConflicts(db);

  console.log('[seed] ✅ Demo data seeded successfully!');
}

// ── Main ──
if (require.main === module) {
  console.log('[seed] Starting seed process...');
  generateExcelFiles()
    .then(() => {
      seedDatabase();
      console.log('[seed] Done.');
    })
    .catch(err => {
      console.error('[seed] Failed:', err);
      process.exitCode = 1;
    });
}

module.exports = { generateExcelFiles, seedDatabase };

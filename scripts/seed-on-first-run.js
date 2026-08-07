// Seed on first run — generates sample Excel files + populates SQLite with demo data.
// Called from server.js on startup when DB is empty.
// Usage: node scripts/seed-on-first-run.js

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const XLSX = require('xlsx');

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
function generateExcelFiles() {
  fs.mkdirSync(REPORTS_DIR, { recursive: true });

  // Roles Approvers.xlsx
  const rolesWb = XLSX.utils.book_new();

  // "Complete" sheet
  const completeHeader = ['Role Name', 'Role Description', 'Department', 'Approver Full Name'];
  const completeRows = [completeHeader];
  for (const role of roles) {
    completeRows.push([role.roleName, `Description for ${role.roleName}`, role.roleName.split(' - ')[1] || '', role.approver]);
  }
  const wsComplete = XLSX.utils.aoa_to_sheet(completeRows);
  XLSX.utils.book_append_sheet(rolesWb, wsComplete, 'Complete');

  // "Emails" sheet
  const emailsHeader = ['Full Name', 'Email'];
  const emailsRows = [emailsHeader];
  for (const a of approvers) {
    emailsRows.push([a.fullName, a.email]);
  }
  const wsEmails = XLSX.utils.aoa_to_sheet(emailsRows);
  XLSX.utils.book_append_sheet(rolesWb, wsEmails, 'Emails');

  const rolesPath = path.join(REPORTS_DIR, process.env.ROLES_FILE_NAME || 'Roles Approvers.xlsx');
  XLSX.writeFile(rolesWb, rolesPath);
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
  const wsTx = XLSX.utils.aoa_to_sheet(txRows);
  const txWb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(txWb, wsTx, 'Transactions');
  const txPath = path.join(REPORTS_DIR, process.env.TX_FILE_NAME || 'Transactions.xlsx');
  XLSX.writeFile(txWb, txPath);
  console.log(`[seed] Generated: ${txPath} (${txRows.length - 1} transaction rows)`);
}

// ── Step 2: Seed SQLite ──
function seedDatabase() {
  // Import db module (after Excel files are generated so the data dir exists)
  const { getDb } = require('../stores/db');
  const db = getDb();

  // Check if already seeded
  const existingCampaigns = db.prepare('SELECT COUNT(*) as cnt FROM campaigns').get();
  if (existingCampaigns && existingCampaigns.cnt > 0) {
    console.log('[seed] Database already has campaigns — skipping seed.');
    // Still ensure default tenant exists
    const dt = db.prepare("SELECT id FROM tenants WHERE id = 'default'").get();
    if (!dt) {
      db.prepare("INSERT INTO tenants (id, name, plan, status) VALUES (?, ?, ?, ?)").run('default', 'Default Organization', 'starter', 'active');
    }
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

  // Admin users
  const admins = ['admin.one@attest.local'];
  const insertAdmin = db.prepare('INSERT OR IGNORE INTO admin_users (email, tenant_id, protected) VALUES (?,?,?)');
  for (const a of admins) {
    insertAdmin.run(a, 'default', 0);
  }

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
    { id: 'conf_001', rule_id: 'sod_ap_gl', approver_name: 'Morgan Taylor', role_a: 'BE - FINANCE - ACCOUNTS PAYABLE', role_b: 'BE - FINANCE - GENERAL LEDGER', severity: 'critical', status: 'open', detected_at: daysAgo(5) },
    { id: 'conf_002', rule_id: 'sod_po_inv', approver_name: 'Morgan Taylor', role_a: 'BE - PROCUREMENT - PURCHASE ORDERS', role_b: 'BE - WAREHOUSE - INVENTORY CONTROL', severity: 'high', status: 'open', detected_at: daysAgo(3) },
    { id: 'conf_003', rule_id: 'sod_hr_pay', approver_name: 'Jamie Rivera', role_a: 'BE - HR - EMPLOYEE DATA', role_b: 'BE - HR - PAYROLL PROCESSING', severity: 'high', status: 'mitigated', detected_at: daysAgo(7), mitigated_by: 'admin.one@attest.local', mitigated_at: daysAgo(6), mitigation_notes: 'Role split between two departments.' },
  ];
  const insertSodConflict = db.prepare(`INSERT INTO sod_conflicts (id, tenant_id, rule_id, user_email, approver_name, role_a, role_b, severity, detected_at, status, mitigated_by, mitigated_at, mitigation_notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const c of sodConflicts) {
    insertSodConflict.run(c.id, 'default', c.rule_id, '', c.approver_name, c.role_a, c.role_b, c.severity, c.detected_at, c.status, c.mitigated_by || '', c.mitigated_at || '', c.mitigation_notes || '');
  }
  console.log('[seed] SoD Conflicts:', sodConflicts.length);

  // Submissions (role reviews)
  const actions = ['Keep Business Role', 'Modify Business Role', 'Modify Technical Role', 'Reject Business Role'];
  const insertSubmission = db.prepare(`INSERT INTO submissions (log_entry_id, submission_id, tenant_id, timestamp, approver, submitted_by_email, impersonated, role_name, action, ritm, ritm_status, action_details, comments, rejection_reason, row_index, campaign_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

  let subIdx = 0;
  const allApprovers = ['Morgan Taylor', 'Jamie Rivera', 'Casey Morrison', 'Riley Thompson', 'Quinn Harrison'];
  // Seed ~10 submissions (67% of 15 roles)
  const reviewedCount = 10;
  let reviewed = 0;
  for (const approver of allApprovers) {
    const rls = approverRoles[approver] || [];
    for (const role of rls) {
      if (reviewed < reviewedCount) {
        subIdx++;
        const id = String(subIdx).padStart(6, '0');
        const ts = daysAgo(Math.floor(Math.random() * 10));
        const action = actions[reviewed % actions.length];
        const ritm = ['RITM004810', 'RITM004788', 'RITM004795', 'RITM004812', 'RITM004820'][subIdx % 5];
        const ritmStatus = action === 'Keep Business Role' ? 'Resolved' : action === 'Reject Business Role' ? 'On Hold' : 'Open';
        insertSubmission.run(
          id + '-001', id, 'default', ts, approver, approver.toLowerCase().replace(' ', '.') + '@attest.local', 0,
          role, action, action !== 'Keep Business Role' ? ritm : '', ritmStatus,
          '', '', '', subIdx, 'camp_sox_q3'
        );
        reviewed++;
      }
    }
  }
  console.log('[seed] Submissions:', subIdx);

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

  console.log('[seed] ✅ Demo data seeded successfully!');
}

// ── Main ──
if (require.main === module) {
  console.log('[seed] Starting seed process...');
  generateExcelFiles();
  seedDatabase();
  console.log('[seed] Done.');
}

module.exports = { generateExcelFiles, seedDatabase };

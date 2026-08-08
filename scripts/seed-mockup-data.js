// Seed synthetic data for mockup-aligned demo
// Run: node scripts/seed-mockup-data.js

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// Delete old DB to start fresh
const dbPath = path.join(__dirname, '..', 'data', 'attest.db');
for (const f of [dbPath, dbPath + '-shm', dbPath + '-wal']) {
  try { fs.unlinkSync(f); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

const { getDb } = require('../stores/db');
const { backfillLegacySodConflicts } = require('../stores/sodAccessModel');
const db = getDb();

console.log('[seed] DB initialized with all tables.');

// ── Helpers ──
function uid(prefix) { return (prefix || 'id_') + crypto.randomUUID().slice(0, 8); }
function daysAgo(n) { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString(); }
function hoursAgo(h) { const d = new Date(); d.setHours(d.getHours() - h); return d.toISOString(); }

// ── Tenants ──
const tenants = [
  { id: 'default', name: 'Default Organization', plan: 'starter', status: 'active' },
  { id: 'tnt_acme', name: 'Acme Corporation', plan: 'enterprise', status: 'active' },
  { id: 'tnt_globalfin', name: 'Global Finance Ltd', plan: 'professional', status: 'active' },
];
const insertTenant = db.prepare('INSERT OR REPLACE INTO tenants (id, name, plan, status, created_at, updated_at) VALUES (?,?,?,?,?,?)');
for (const t of tenants) {
  insertTenant.run(t.id, t.name, t.plan, t.status, daysAgo(30), daysAgo(1));
}
console.log('[seed] Tenants:', tenants.length);

// ── Admin Users ──
const admins = [
  'admin.one@attest.local', 'admin.two@attest.local',
  'compliance@acmecorp.com', 'audit@globalfin.com',
];
const insertAdmin = db.prepare('INSERT OR IGNORE INTO admin_users (email, tenant_id, protected) VALUES (?,?,?)');
for (const a of admins) {
  insertAdmin.run(a, 'default', 0);
}
console.log('[seed] Admin users:', admins.length);

// ── Campaigns ──
const campaigns = [
  { id: 'camp_sox_q3', name: 'Q3 SOX ITGC Access Review', framework: 'SOX', period: 'Q3 2026', status: 'active', deadline: '2026-08-31', approvers: ['Morgan Taylor','Jamie Rivera','Casey Morrison','Riley Thompson','Quinn Harrison'] },
  { id: 'camp_iso_annual', name: 'ISO 27001 Annual Re-certification', framework: 'ISO27001', period: '2026', status: 'draft', deadline: '2026-12-15', approvers: ['Morgan Taylor','Jamie Rivera','Casey Morrison','Riley Thompson','Quinn Harrison'] },
  { id: 'camp_soc2', name: 'SOC 2 Type II — CC6.1 Controls', framework: 'SOC2', period: 'H2 2026', status: 'completed', deadline: '2026-06-30', approvers: ['Morgan Taylor','Jamie Rivera','Casey Morrison'] },
  { id: 'camp_gdpr', name: 'GDPR Access Minimization Review', framework: 'GDPR', period: 'Ongoing', status: 'active', deadline: '2026-09-30', approvers: ['Jamie Rivera','Casey Morrison'] },
  { id: 'camp_onboard_aug', name: 'New Hire Onboarding — Aug 2026', framework: 'ITGC', period: 'Aug 2026', status: 'active', deadline: '2026-08-20', approvers: ['Riley Thompson','Quinn Harrison'] },
];
const insertCampaign = db.prepare(`INSERT INTO campaigns (id, tenant_id, name, description, framework, period, status, deadline, approvers, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
for (const c of campaigns) {
  insertCampaign.run(c.id, 'default', c.name, '', c.framework, c.period, c.status, c.deadline, JSON.stringify(c.approvers), 'admin.one@attest.local', daysAgo(20), daysAgo(1));
}
console.log('[seed] Campaigns:', campaigns.length);

// ── SoD Rules ──
const sodRules = [
  { id: 'sod_ap_gl', name: 'SOX-AP-001: AP Clerk + GL Accountant', role_a: 'BE - FINANCE - ACCOUNTS PAYABLE', role_b: 'BE - FINANCE - GENERAL LEDGER', severity: 'critical', framework: 'SOX', description: 'Cannot both disburse funds and reconcile the general ledger' },
  { id: 'sod_po_inv', name: 'SOX-PO-003: PO Creator + Inventory Control', role_a: 'BE - PROCUREMENT - PURCHASE ORDERS', role_b: 'BE - WAREHOUSE - INVENTORY CONTROL', severity: 'high', framework: 'SOX', description: 'Cannot create POs and manage inventory receiving' },
  { id: 'sod_hr_pay', name: 'SOX-HR-007: HR Admin + Payroll', role_a: 'BE - HR - EMPLOYEE DATA', role_b: 'BE - HR - PAYROLL PROCESSING', severity: 'high', framework: 'SOX', description: 'Cannot modify HR master data and process payroll' },
  { id: 'sod_po_vendor', name: 'PO Creator + Vendor Manager', role_a: 'BE - PROCUREMENT - PURCHASE ORDERS', role_b: 'BE - PROCUREMENT - VENDOR MANAGEMENT', severity: 'high', framework: 'SOX', description: '' },
];
const insertSodRule = db.prepare('INSERT INTO sod_rules (id, tenant_id, name, role_a, role_b, severity, description, framework, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)');
for (const r of sodRules) {
  insertSodRule.run(r.id, 'default', r.name, r.role_a, r.role_b, r.severity, r.description, r.framework, 'admin.one@attest.local', daysAgo(10));
}
console.log('[seed] SoD Rules:', sodRules.length);

// ── SoD Conflicts ──
const sodConflicts = [
  { id: 'conf_001', rule_id: 'sod_ap_gl', approver_name: 'Morgan Taylor', role_a: 'BE - FINANCE - ACCOUNTS PAYABLE', role_b: 'BE - FINANCE - GENERAL LEDGER', severity: 'critical', status: 'open', detected_at: daysAgo(5) },
  { id: 'conf_002', rule_id: 'sod_po_inv', approver_name: 'Morgan Taylor', role_a: 'BE - PROCUREMENT - PURCHASE ORDERS', role_b: 'BE - WAREHOUSE - INVENTORY CONTROL', severity: 'high', status: 'open', detected_at: daysAgo(3) },
  { id: 'conf_003', rule_id: 'sod_hr_pay', approver_name: 'Jamie Rivera', role_a: 'BE - HR - EMPLOYEE DATA', role_b: 'BE - HR - PAYROLL PROCESSING', severity: 'high', status: 'open', detected_at: daysAgo(4) },
  { id: 'conf_004', rule_id: 'sod_po_vendor', approver_name: 'Morgan Taylor', role_a: 'BE - PROCUREMENT - PURCHASE ORDERS', role_b: 'BE - PROCUREMENT - VENDOR MANAGEMENT', severity: 'high', status: 'mitigated', detected_at: daysAgo(7), mitigated_by: 'admin.one@attest.local', mitigated_at: daysAgo(6), mitigation_notes: 'Role split between two departments.' },
];
const insertSodConflict = db.prepare(`INSERT INTO sod_conflicts (id, tenant_id, rule_id, user_email, approver_name, role_a, role_b, severity, detected_at, status, mitigated_by, mitigated_at, mitigation_notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
for (const c of sodConflicts) {
  insertSodConflict.run(c.id, 'default', c.rule_id, '', c.approver_name, c.role_a, c.role_b, c.severity, c.detected_at, c.status, c.mitigated_by || '', c.mitigated_at || '', c.mitigation_notes || '');
}
console.log('[seed] SoD Conflicts:', sodConflicts.length);

// ── Submissions (role reviews) ──
const approvers = ['Morgan Taylor', 'Jamie Rivera', 'Casey Morrison', 'Riley Thompson', 'Quinn Harrison'];
const approverRoles = {
  'Morgan Taylor': ['BE - FINANCE - ACCOUNTS PAYABLE','BE - FINANCE - ACCOUNTS RECEIVABLE','BE - FINANCE - GENERAL LEDGER','BE - PROCUREMENT - PURCHASE ORDERS'],
  'Jamie Rivera': ['BE - HR - EMPLOYEE DATA','BE - HR - PAYROLL PROCESSING','BE - PROCUREMENT - VENDOR MANAGEMENT'],
  'Casey Morrison': ['BE - IT - HELP DESK SUPPORT','BE - IT - NETWORK ENGINEER','BE - IT - SYSTEM ADMINISTRATOR'],
  'Riley Thompson': ['BE - QUALITY - INSPECTION CONTROL','BE - SALES - CUSTOMER MANAGEMENT','BE - SALES - ORDER PROCESSING'],
  'Quinn Harrison': ['BE - WAREHOUSE - INVENTORY CONTROL','BE - WAREHOUSE - SHIPPING & RECEIVING'],
};

const actions = ['Keep Business Role','Modify Business Role','Modify Technical Role','Reject Business Role'];
const ritmStatuses = ['Open','Resolved','On Hold','Cancelled'];
let subIdx = 0;

const insertSubmission = db.prepare(`INSERT INTO submissions (log_entry_id, submission_id, tenant_id, timestamp, approver, submitted_by_email, impersonated, role_name, action, ritm, ritm_status, action_details, comments, rejection_reason, row_index, campaign_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

function makeSubmission(approver, role, action, daysOffset, campaignId) {
  subIdx++;
  const id = String(subIdx).padStart(6, '0');
  const ts = daysAgo(daysOffset);
  const ritm = ['RITM004810','RITM004788','RITM004795','RITM004812','RITM004820'][subIdx % 5];
  const ritmStatus = action === 'Keep Business Role' ? 'Resolved' : action === 'Reject Business Role' ? 'On Hold' : 'Open';
  insertSubmission.run(
    id + '-001', id, 'default', ts, approver, approver.toLowerCase().replace(' ','.') + '@attest.local', 0,
    role, action, action !== 'Keep Business Role' ? ritm : '', ritmStatus,
    '', '', '', subIdx, campaignId || ''
  );
}

// Generate submissions for mockup look: ~68% of 15 roles reviewed
const reviewedCount = 10; // 10 out of 15 = ~67%
let reviewed = 0;
for (const approver of approvers) {
  const roles = approverRoles[approver] || [];
  for (const role of roles) {
    if (reviewed < reviewedCount) {
      const action = actions[reviewed % actions.length];
      makeSubmission(approver, role, action, Math.floor(Math.random() * 10), 'camp_sox_q3');
      reviewed++;
    }
  }
}
console.log('[seed] Submissions:', subIdx);

// ── Activity log ──
const activities = [
  { type: 'SUBMISSION', action: 'submission_created', email: 'jamie.rivera@attest.local', detail: 'Jamie Rivera approved 4 roles — SAP FI Module', hours: 2 },
  { type: 'CAMPAIGN', action: 'campaign_created', email: 'admin.one@attest.local', detail: 'New campaign created: Q3 SOX ITGC Review', hours: 10 },
  { type: 'SOD', action: 'sod_conflict_detected', email: 'admin.one@attest.local', detail: 'SoD conflict flagged: GL Accountant + AP Clerk (Morgan Taylor)', hours: 16 },
  { type: 'EVIDENCE', action: 'evidence_generated', email: 'admin.one@attest.local', detail: 'Evidence package exported for PwC audit — 4.2 MB', hours: 24 },
  { type: 'AUTH', action: 'data_uploaded', email: 'admin.one@attest.local', detail: 'Data source updated: Roles Approvers.xlsx (1,247 roles)', hours: 48 },
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

backfillLegacySodConflicts(db);

console.log('[seed] ✅ Mockup data seeded successfully!');
process.exit(0);

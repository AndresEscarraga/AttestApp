// Generates synthetic sample data Excel files for Attest.
// Produces lightweight files with only the columns actually used by the app.
// Usage: node scripts/generate-sample-data.js

const XLSX = require('xlsx');
const path = require('path');
const fs = require('fs');

const REPORTS_DIR = path.join(__dirname, '..', 'Reports');

// ─── Synthetic approvers ───
const approvers = [
  { fullName: 'Morgan Taylor', email: 'approver.one@attest.local' },
  { fullName: 'Jamie Rivera', email: 'approver.two@attest.local' },
  { fullName: 'Casey Morrison', email: 'approver.three@attest.local' },
  { fullName: 'Riley Thompson', email: 'approver.four@attest.local' },
  { fullName: 'Quinn Harrison', email: 'approver.five@attest.local' },
];

// ─── Synthetic roles ───
const roles = [
  { roleName: 'BE - FINANCE - ACCOUNTS PAYABLE', approver: 'Morgan Taylor' },
  { roleName: 'BE - FINANCE - ACCOUNTS RECEIVABLE', approver: 'Morgan Taylor' },
  { roleName: 'BE - FINANCE - GENERAL LEDGER', approver: 'Morgan Taylor' },
  { roleName: 'BE - HR - EMPLOYEE DATA', approver: 'Jamie Rivera' },
  { roleName: 'BE - HR - PAYROLL PROCESSING', approver: 'Jamie Rivera' },
  { roleName: 'BE - IT - SYSTEM ADMINISTRATOR', approver: 'Casey Morrison' },
  { roleName: 'BE - IT - NETWORK ENGINEER', approver: 'Casey Morrison' },
  { roleName: 'BE - IT - HELP DESK SUPPORT', approver: 'Casey Morrison' },
  { roleName: 'BE - SALES - CUSTOMER MANAGEMENT', approver: 'Riley Thompson' },
  { roleName: 'BE - SALES - ORDER PROCESSING', approver: 'Riley Thompson' },
  { roleName: 'BE - WAREHOUSE - INVENTORY CONTROL', approver: 'Quinn Harrison' },
  { roleName: 'BE - WAREHOUSE - SHIPPING & RECEIVING', approver: 'Quinn Harrison' },
  { roleName: 'BE - PROCUREMENT - PURCHASE ORDERS', approver: 'Morgan Taylor' },
  { roleName: 'BE - PROCUREMENT - VENDOR MANAGEMENT', approver: 'Jamie Rivera' },
  { roleName: 'BE - QUALITY - INSPECTION CONTROL', approver: 'Riley Thompson' },
];

// ─── Synthetic technical roles / permissions ───
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

// ─── Map roles to technical roles for the transactions file ───
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

// ─── Generate Roles Approvers.xlsx ───
function generateRolesApprovers() {
  // Sheet "Complete"
  const completeHeader = ['Role Name', 'Role Description', 'Department', 'Approver Full Name'];
  const completeRows = [completeHeader];
  for (const role of roles) {
    completeRows.push([role.roleName, `Description for ${role.roleName}`, role.roleName.split(' - ')[1] || '', role.approver]);
  }

  // Sheet "Emails"
  const emailsHeader = ['Full Name', 'Email'];
  const emailsRows = [emailsHeader];
  for (const a of approvers) {
    emailsRows.push([a.fullName, a.email]);
  }

  const wb = XLSX.utils.book_new();
  const wsComplete = XLSX.utils.aoa_to_sheet(completeRows);
  const wsEmails = XLSX.utils.aoa_to_sheet(emailsRows);
  XLSX.utils.book_append_sheet(wb, wsComplete, 'Complete');
  XLSX.utils.book_append_sheet(wb, wsEmails, 'Emails');

  const filePath = path.join(REPORTS_DIR, 'Roles Approvers.xlsx');
  XLSX.writeFile(wb, filePath);
  console.log(`Generated: ${filePath} (${roles.length} roles, ${approvers.length} approvers)`);
}

// ─── Generate Transactions.xlsx ───
function generateTransactions() {
  const header = ['Role Name', 'Associated Role', 'Associated Role Description', 'Permission Name'];
  const rows = [header];

  for (const [businessRole, techList] of Object.entries(roleToTechnical)) {
    for (const techRole of techList) {
      const perms = technicalRoles.filter(tr => tr.role === techRole);
      for (const perm of perms) {
        rows.push([businessRole, perm.role, perm.desc, perm.permission]);
      }
    }
  }

  // Add some standalone rows for roles without detailed transactions
  const allAssignedRoles = new Set(Object.keys(roleToTechnical));
  for (const role of roles) {
    if (!allAssignedRoles.has(role.roleName)) {
      rows.push([role.roleName, 'GENERIC_ACCESS', 'Generic system access role', 'LOGIN: System Login']);
      rows.push([role.roleName, 'GENERIC_ACCESS', 'Generic system access role', 'DISPLAY: View Records']);
    }
  }

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(rows);
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');

  const filePath = path.join(REPORTS_DIR, 'Transactions.xlsx');
  XLSX.writeFile(wb, filePath);
  console.log(`Generated: ${filePath} (${rows.length - 1} transaction rows)`);
}

// ─── Main ───
if (!fs.existsSync(REPORTS_DIR)) {
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
}

generateRolesApprovers();
generateTransactions();
console.log('Done. Synthetic Excel files generated successfully.');

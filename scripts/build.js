// Build script — injects sidebar and topbar components into all HTML pages.
// Uses simple find-and-replace: replaces existing sidebar/topbar with component versions.
// Run: node scripts/build.js

const fs = require('fs');
const path = require('path');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const COMPONENTS_DIR = path.join(PUBLIC_DIR, 'components');

// Page configuration: filename → { activePage, breadcrumb, searchPlaceholder }
const PAGE_CONFIG = {
  'dashboard.html':    { activePage: 'dashboard',    breadcrumb: 'Attest › <span>Dashboard</span>',       searchPlaceholder: 'Search roles, approvers, campaigns...' },
  'campaigns.html':    { activePage: 'campaigns',    breadcrumb: 'Attest › <span>Campaigns</span>',       searchPlaceholder: 'Search roles, approvers, campaigns...' },
  'reviews.html':      { activePage: 'reviews',      breadcrumb: 'Attest › <span>My Reviews</span>',      searchPlaceholder: 'Search roles, approvers, campaigns...' },
  'onboarding.html':   { activePage: 'onboarding',   breadcrumb: 'Attest › <span>Onboarding</span>',      searchPlaceholder: 'Search...' },
  'offboarding.html':  { activePage: 'offboarding',  breadcrumb: 'Attest › <span>Offboarding</span>',     searchPlaceholder: 'Search...' },
  'audit-trail.html':  { activePage: 'audit-trail',  breadcrumb: 'Attest › <span>Audit Trail</span>',     searchPlaceholder: 'Search submissions by role, approver, or ID…' },
  'sod.html':          { activePage: 'sod',          breadcrumb: 'Attest › <span>SoD Conflicts</span>',   searchPlaceholder: 'Search...' },
  'evidence.html':     { activePage: 'evidence',     breadcrumb: 'Attest › <span>Evidence Locker</span>', searchPlaceholder: 'Search...' },
  'data-sources.html': { activePage: 'data-sources', breadcrumb: 'Attest › <span>Data Sources</span>',    searchPlaceholder: 'Search...' },
  'admin-users.html':  { activePage: 'admin-users',  breadcrumb: 'Attest › <span>Users & Roles</span>',   searchPlaceholder: 'Search users by email…' },
  'tenants.html':      { activePage: 'tenants',      breadcrumb: 'Attest › <span>Tenants</span>',         searchPlaceholder: 'Search tenants…' },
  'settings.html':     { activePage: 'settings',     breadcrumb: 'Attest › <span>Configuration</span>',   searchPlaceholder: 'Search settings…' },
  'api-keys.html':     { activePage: 'api-keys',     breadcrumb: 'Attest › <span>API Keys</span>',        searchPlaceholder: 'Search keys…' },
  'activity.html':     { activePage: 'activity',     breadcrumb: 'Attest › <span>Activity Log</span>',    searchPlaceholder: 'Search activity…' },
};

// Read component templates
const sidebarTemplate = fs.readFileSync(path.join(COMPONENTS_DIR, 'sidebar.html'), 'utf8');
const topbarTemplate = fs.readFileSync(path.join(COMPONENTS_DIR, 'topbar.html'), 'utf8');

function fillSidebar(config) {
  let html = sidebarTemplate;
  html = html.replace(/\{\{activePage:(\w[\w-]*)\}\}/g, (_, page) => config.activePage === page ? 'active' : '');
  html = html.replace(/\{\{tenantOptions\}\}/g, '');
  html = html.replace(/\{\{avatarInitial\}\}/g, 'U');
  html = html.replace(/\{\{userName\}\}/g, 'User');
  html = html.replace(/\{\{userRole\}\}/g, '');
  html = html.replace(/\{\{campaignBadge\}\}/g, '0');
  html = html.replace(/\{\{reviewBadge\}\}/g, '0');
  html = html.replace(/\{\{sodBadge\}\}/g, '0');
  return html;
}

function fillTopbar(config) {
  let html = topbarTemplate;
  html = html.replace(/\{\{breadcrumb\}\}/g, config.breadcrumb || 'Attest');
  html = html.replace(/\{\{searchPlaceholder\}\}/g, config.searchPlaceholder || 'Search...');
  html = html.replace(/\{\{lastUpdated\}\}/g, '');
  return html;
}

function processFile(filename) {
  const config = PAGE_CONFIG[filename];
  if (!config) return false;

  const filePath = path.join(PUBLIC_DIR, filename);
  if (!fs.existsSync(filePath)) return false;

  let html = fs.readFileSync(filePath, 'utf8');

  // 1. Inject shared.js into <head> if not already present
  if (!html.includes('shared.js')) {
    html = html.replace('</head>', '\n<script src="shared.js"></script>\n</head>');
  }

  // 2. Replace existing <aside class="sidebar">...</aside> with component version
  html = html.replace(/<aside class="sidebar">[\s\S]*?<\/aside>/g, fillSidebar(config));

  // 3. Replace existing <header class="topbar">...</header> with component version
  html = html.replace(/<header class="topbar">[\s\S]*?<\/header>/g, fillTopbar(config));

  // 4. Strip duplicate auth/fetch-override from inline scripts (shared.js handles this)
  html = html.replace(/var token\s*=\s*localStorage\.getItem\(['"]attest_token['"]\)\s*;\s*if\s*\(\s*!token\s*\)\s*\{\s*location\.href\s*=\s*['"]\/login\.html['"]\s*;?\s*\}/g, '// Auth handled by shared.js');
  html = html.replace(/var token\s*=\s*localStorage\.getItem\(['"]attest_token['"]\)\s*;\s*if\s*\(!token\)\s*\{location\.href\s*=\s*['"]\/login\.html['"]\}/g, '// Auth handled by shared.js');
  html = html.replace(/var origFetch\s*=\s*window\.fetch\s*;\s*window\.fetch\s*=\s*function\s*\(url,\s*opts\)\s*\{[\s\S]*?return origFetch\(url,\s*opts\)\s*;\s*\}\s*;/g, '// Fetch auth inject handled by shared.js');
  html = html.replace(/var origFetch\s*=\s*window\.fetch\s*;\s*window\.fetch\s*=\s*function\s*\(url,opts\)\s*\{opts\s*=\s*opts\s*\|\|\s*\{\}\s*;opts\.headers\s*=\s*opts\.headers\s*\|\|\s*\{\}\s*;if\s*\(token\s*&&\s*!opts\.headers\['Authorization'\]\s*\)opts\.headers\['Authorization'\]\s*='Bearer '\+token\s*;return origFetch\(url,opts\)\s*;\}\s*;/g, '// Fetch auth inject handled by shared.js');

  fs.writeFileSync(filePath, html, 'utf8');
  console.log('[build] ✓ ' + filename);
  return true;
}

// Process all configured pages
console.log('[build] Injecting sidebar & topbar components...');
let count = 0;
for (const filename of Object.keys(PAGE_CONFIG)) {
  if (processFile(filename)) count++;
}
console.log('[build] ✅ Processed ' + count + ' pages.');

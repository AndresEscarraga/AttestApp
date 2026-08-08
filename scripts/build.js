// Build script — injects Web Components for sidebar, topbar, mobile tabbar
// Replaces hardcoded HTML with custom elements: <attest-sidebar>, <attest-topbar>, <attest-mobile-tabbar>
// Run: node scripts/build.js

const fs = require('fs');
const path = require('path');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

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

function sidebarTag(config) {
  return '<attest-sidebar active="' + config.activePage + '"></attest-sidebar>';
}
function topbarTag(config) {
  return '<attest-topbar breadcrumb="' + config.breadcrumb.replace(/"/g, '&quot;') + '" search-placeholder="' + config.searchPlaceholder.replace(/"/g, '&quot;') + '"></attest-topbar>';
}
function tabbarTag(config) {
  return '<attest-mobile-tabbar active="' + config.activePage + '"></attest-mobile-tabbar>';
}

function processFile(filename) {
  const config = PAGE_CONFIG[filename];
  if (!config) return false;

  const filePath = path.join(PUBLIC_DIR, filename);
  if (!fs.existsSync(filePath)) return false;

  let html = fs.readFileSync(filePath, 'utf8');

  // 0. CLEANUP: Remove all previously injected build artifacts (including duplicates)
  html = html.replace(/<!-- Sidebar component[\s\S]*?Placeholders:[\s\S]*?-->/g, '');
  html = html.replace(/<!-- Topbar component[\s\S]*?Placeholders:[\s\S]*?-->/g, '');
  var mc = 0, mv = 0;
  html = html.replace(/<meta\s+charset="UTF-8"[^>]*>/gi, function(m){ mc++; return mc===1?m:''; });
  html = html.replace(/<meta\s+name="viewport"[^>]*>/gi, function(m){ mv++; return mv===1?m:''; });
  html = html.replace(/\n\s*\n\s*\n/g, '\n\n');

  // 1. Inject scripts into <head>
  html = html.replace(/<script\s+src=["']\/?shared\.js["']><\/script>/gi, '');
  html = html.replace(/<script\s+src=["']\/?components\.js["']><\/script>/gi, '');
  html = html.replace('</head>', '\n<script src="/components.js"></script>\n<script src="/shared.js"></script>\n</head>');

  // 2. Replace hardcoded sidebar with custom element
  html = html.replace(/<aside class="sidebar">[\s\S]*?<\/aside>/g, sidebarTag(config));

  // 3. Replace hardcoded topbar with custom element
  html = html.replace(/<header class="topbar">[\s\S]*?<\/header>/g, topbarTag(config));

  // 4. Add mobile tabbar before </body> (remove any existing one first)
  html = html.replace(/<attest-mobile-tabbar[^>]*><\/attest-mobile-tabbar>/g, '');
  html = html.replace(/<div class="mobile-tabbar">[\s\S]*?<\/div>\s*<\/div>/g, '');
  html = html.replace('</body>', tabbarTag(config) + '\n</body>');

  // 5. Strip duplicate auth/fetch-override from inline scripts
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

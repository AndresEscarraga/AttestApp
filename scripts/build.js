// Build script — injects sidebar and topbar components into all HTML pages.
// Run: node scripts/build.js
// This replaces duplicated sidebar/topbar HTML across 15 pages with consistent components.

const fs = require('fs');
const path = require('path');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const COMPONENTS_DIR = path.join(PUBLIC_DIR, 'components');

// Page configuration: filename → { activePage, breadcrumb, searchPlaceholder, lastUpdated }
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

// Read component files
const sidebarTemplate = fs.readFileSync(path.join(COMPONENTS_DIR, 'sidebar.html'), 'utf8');
const topbarTemplate = fs.readFileSync(path.join(COMPONENTS_DIR, 'topbar.html'), 'utf8');

function fillSidebarTemplate(config) {
  let html = sidebarTemplate;
  // Set active class
  html = html.replace(/\{\{activePage:(\w[\w-]*)\}\}/g, (match, page) => {
    return config.activePage === page ? 'active' : '';
  });
  // Set placeholder values
  html = html.replace(/\{\{tenantOptions\}\}/g, '');
  html = html.replace(/\{\{avatarInitial\}\}/g, 'U');
  html = html.replace(/\{\{userName\}\}/g, 'User');
  html = html.replace(/\{\{userRole\}\}/g, '');
  html = html.replace(/\{\{campaignBadge\}\}/g, '0');
  html = html.replace(/\{\{reviewBadge\}\}/g, '0');
  html = html.replace(/\{\{sodBadge\}\}/g, '0');
  return html;
}

function fillTopbarTemplate(config) {
  let html = topbarTemplate;
  html = html.replace(/\{\{breadcrumb\}\}/g, config.breadcrumb || 'Attest');
  html = html.replace(/\{\{searchPlaceholder\}\}/g, config.searchPlaceholder || 'Search...');
  html = html.replace(/\{\{lastUpdated\}\}/g, '');
  return html;
}

function extractPageContent(htmlContent) {
  // Extract <title> to preserve it
  const titleMatch = htmlContent.match(/<title>(.*?)<\/title>/);
  const title = titleMatch ? titleMatch[1] : 'Attest';

  // Extract remaining <head> content (after title) until </head>
  const headMatch = htmlContent.match(/<head>([\s\S]*?)<\/head>/);
  let headContent = '';
  if (headMatch) {
    headContent = headMatch[1]
      .replace(/<title>.*?<\/title>/, '') // Remove title (we re-add it)
      .trim();
  }

  // Extract <body> attributes
  const bodyAttrsMatch = htmlContent.match(/<body([^>]*)>/);
  const bodyAttrs = bodyAttrsMatch ? bodyAttrsMatch[1].trim() : '';

  // Extract content between <body> and </body>, excluding sidebar/topbar
  const bodyMatch = htmlContent.match(/<body[^>]*>([\s\S]*?)<\/body>/);
  if (!bodyMatch) return null;

  let bodyContent = bodyMatch[1];

  // Remove existing sidebar
  bodyContent = bodyContent.replace(/<aside class="sidebar">[\s\S]*?<\/aside>/g, '');
  // Remove existing topbar
  bodyContent = bodyContent.replace(/<header class="topbar">[\s\S]*?<\/header>/g, '');

  return { title, headContent, bodyAttrs, bodyContent };
}

function processFile(filename) {
  const config = PAGE_CONFIG[filename];
  if (!config) {
    console.log(`[build] Skipping ${filename} — no config defined.`);
    return false;
  }

  const filePath = path.join(PUBLIC_DIR, filename);
  if (!fs.existsSync(filePath)) {
    console.log(`[build] File not found: ${filename}`);
    return false;
  }

  let html = fs.readFileSync(filePath, 'utf8');

  // Always inject shared.js if not present
  if (!html.includes('shared.js')) {
    html = html.replace('</head>', '\n<script src="shared.js"></script>\n</head>');
  }

  const extracted = extractPageContent(html);
  if (!extracted) {
    console.log(`[build] Could not parse ${filename}`);
    return false;
  }

  const sidebarHtml = fillSidebarTemplate(config);
  const topbarHtml = fillTopbarTemplate(config);

  // Rebuild the page
  let newHtml = `<!DOCTYPE html>
<html lang="en" data-theme="light">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${extracted.title}</title>
${extracted.headContent}
</head>
<body${extracted.bodyAttrs ? ' ' + extracted.bodyAttrs : ''}>
${sidebarHtml}
<div class="main">
${topbarHtml}
${extracted.bodyContent.trim()}
</div>
</body>
</html>
`;

  // Remove duplicate auth redirect + fetch-override patterns from inline scripts
  // (shared.js handles all of this now)
  newHtml = newHtml.replace(/var token\s*=\s*localStorage\.getItem\(['"]attest_token['"]\)\s*;\s*if\s*\(\s*!token\s*\)\s*\{\s*location\.href\s*=\s*['"]\/login\.html['"]\s*;?\s*\}/g, '// Auth handled by shared.js');
  newHtml = newHtml.replace(/var origFetch\s*=\s*window\.fetch\s*;\s*window\.fetch\s*=\s*function\(url,\s*opts\)\s*\{[\s\S]*?return origFetch\(url,\s*opts\)\s*;\s*\}\s*;/g, '// Fetch auth inject handled by shared.js');
  // Also catch the minified form
  newHtml = newHtml.replace(/var token=localStorage\.getItem\(['"]attest_token['"]\)\s*;\s*if\(!token\)\{location\.href=['"]\/login\.html['"]\}\s*/g, '// Auth handled by shared.js');
  newHtml = newHtml.replace(/var origFetch=window\.fetch\s*;\s*window\.fetch=function\(url,opts\)\{opts=opts\|\|\{\};opts\.headers=opts\.headers\|\|\{\};if\(token&&!opts\.headers\['Authorization'\]\)opts\.headers\['Authorization'\]='Bearer '\+token;return origFetch\(url,opts\);\}\s*;/g, '// Fetch auth inject handled by shared.js');

  fs.writeFileSync(filePath, newHtml, 'utf8');
  console.log(`[build] ✓ ${filename}`);
  return true;
}

// Process all configured pages
console.log('[build] Injecting sidebar & topbar components...');
let count = 0;
for (const filename of Object.keys(PAGE_CONFIG)) {
  if (processFile(filename)) count++;
}
console.log(`[build] ✅ Processed ${count} pages.`);

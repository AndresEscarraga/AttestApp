// Attest — Web Components (light DOM) for global UI elements
// Single-source-of-truth. Uses light DOM so document.getElementById still works.
(function () {
  'use strict';

  // SVG icon sprite — defined once, reused everywhere
  var I = {
    dashboard: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" class="item-icon"><rect x="2" y="2" width="7" height="7" rx="1.5"/><rect x="11" y="2" width="7" height="7" rx="1.5"/><rect x="2" y="11" width="7" height="7" rx="1.5"/><rect x="11" y="11" width="7" height="7" rx="1.5"/></svg>',
    campaigns: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" class="item-icon"><path d="M3 6l4-2 4 2 4-2 3 1.5v10l-3-1.5-4 2-4-2-4 2V7.5L3 6z"/></svg>',
    reviews: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" class="item-icon"><path d="M4 6h12M4 10h12M4 14h8"/><circle cx="15" cy="14" r="3"/><path d="M15 12.5v1.5l1 .5"/></svg>',
    onboarding: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" class="item-icon"><circle cx="10" cy="7" r="3"/><path d="M3 17v-1a4 4 0 014-4h6a4 4 0 014 4v1"/><line x1="14" y1="2" x2="14" y2="6"/><line x1="12" y1="4" x2="16" y2="4"/></svg>',
    offboarding: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" class="item-icon"><circle cx="10" cy="7" r="3"/><path d="M3 17v-1a4 4 0 014-4h6a4 4 0 014 4v1"/><line x1="16" y1="3" x2="12" y2="7"/><line x1="12" y1="3" x2="16" y2="7"/></svg>',
    audit: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" class="item-icon"><rect x="3" y="3" width="14" height="14" rx="2"/><path d="M7 8h6M7 12h4"/></svg>',
    sod: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" class="item-icon"><path d="M10 2L2 18h16L10 2z"/><line x1="10" y1="9" x2="10" y2="13"/><circle cx="10" cy="15.5" r=".75" fill="currentColor"/></svg>',
    evidence: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" class="item-icon"><path d="M3 5h14v11a2 2 0 01-2 2H5a2 2 0 01-2-2V5z"/><path d="M3 5l2-3h10l2 3"/></svg>',
    datasource: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" class="item-icon"><ellipse cx="10" cy="4" rx="7" ry="2.5"/><path d="M3 4v5c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5V4"/><path d="M3 9v4c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5V9"/></svg>',
    users: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" class="item-icon"><circle cx="8" cy="7" r="3"/><circle cx="14" cy="5" r="2"/><path d="M2 17v-1a4 4 0 014-4h4a4 4 0 014 4v1"/><path d="M14 8.5V17"/></svg>',
    tenants: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" class="item-icon"><path d="M3 18V8l7-5 7 5v10H3z"/><line x1="8" y1="18" x2="8" y2="12"/><line x1="12" y1="18" x2="12" y2="12"/></svg>',
    settings: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" class="item-icon"><circle cx="10" cy="10" r="3"/><path d="M10 2v2m0 12v2M2 10h2m12 0h2M4.9 4.9l1.4 1.4m7.4 7.4l1.4 1.4M4.9 15.1l1.4-1.4m7.4-7.4l1.4-1.4"/></svg>',
    apikeys: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" class="item-icon"><circle cx="7" cy="10" r="5"/><path d="M11 10l3-3 2 2-1.5 1.5"/><circle cx="15" cy="15" r="2"/></svg>',
    more: '<svg viewBox="0 0 20 20" fill="currentColor" class="item-icon"><circle cx="6" cy="10" r="1.5"/><circle cx="10" cy="10" r="1.5"/><circle cx="14" cy="10" r="1.5"/></svg>',
    logo: '<svg viewBox="0 0 20 20" fill="none" stroke="white" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><path d="M4 3l6-2 6 2v5c0 2.5-2 5.5-6 8-4-2.5-6-5.5-6-8V3z"/><polyline points="7,9 9.5,12 14,7"/></svg>',
  };

  // ══════ <attest-logo> ══════
  if (!customElements.get('attest-logo')) {
    customElements.define('attest-logo', class extends HTMLElement {
      connectedCallback() {
        this.innerHTML = '<div class="sidebar-logo"><div class="logo-icon">'+I.logo+'</div><span class="logo-text">Attest</span></div>';
      }
    });
  }

  // ══════ <attest-topbar> ══════
  if (!customElements.get('attest-topbar')) {
    customElements.define('attest-topbar', class extends HTMLElement {
      connectedCallback() {
        var bc = this.getAttribute('breadcrumb') || 'Attest';
        var ph = this.getAttribute('search-placeholder') || 'Search...';
        this.innerHTML =
          '<header class="topbar">' +
            '<div class="topbar-breadcrumb">'+bc+'</div>' +
            '<div class="topbar-search"><span class="search-icon">⌕</span><input type="search" placeholder="'+ph+'"></div>' +
            '<div class="topbar-actions">' +
              '<span class="text-sm text-muted" id="lastUpdated"></span>' +
              '<select class="lang-select" id="langSelect"><option value="EN">EN</option><option value="ES">ES</option></select>' +
              '<button class="topbar-btn dark-toggle" id="darkToggleTop" title="Toggle dark mode" aria-label="Toggle dark mode">🌙</button>' +
              '<div class="notif-wrapper" id="notifWrapper">' +
                '<button class="topbar-btn" id="notifBell" title="Notifications" aria-label="Notifications">🔔<span class="notif-badge hidden" id="notifBadge"></span></button>' +
                '<div class="notif-dropdown hidden" id="notifDropdown"><div class="notif-header"><span class="notif-title">Notifications</span><button class="notif-mark-all" id="notifMarkAll">Mark all read</button></div><div class="notif-list" id="notifList"><div class="notif-empty">No notifications yet</div></div></div>' +
              '</div>' +
              '<button class="topbar-btn" title="Help" aria-label="Help">?</button>' +
            '</div>' +
          '</header>';
      }
    });
  }

  // ══════ <attest-sidebar> ══════
  if (!customElements.get('attest-sidebar')) {
    customElements.define('attest-sidebar', class extends HTMLElement {
      connectedCallback() {
        var a = this.getAttribute('active') || '';
        var act = function(p){return a===p?' active':'';};
        this.innerHTML =
          '<aside class="sidebar">' +
            '<attest-logo></attest-logo>' +
            '<div class="sidebar-tenant"><select id="tenantSelector" disabled><option value="">Loading organizations…</option></select></div>' +
            '<nav class="sidebar-nav">' +
              '<div class="sidebar-section" data-capability="dashboard:read"><div class="sidebar-section-label">Overview</div>' +
                '<a class="sidebar-item'+act('dashboard')+'" href="/dashboard.html" data-capability="dashboard:read">'+I.dashboard+'Dashboard</a>' +
                '<a class="sidebar-item'+act('campaigns')+'" href="/campaigns.html" data-capability="campaign:read">'+I.campaigns+'Campaigns<span class="item-badge" id="campaignBadge" style="display:none">0</span></a>' +
              '</div>' +
              '<div class="sidebar-section" data-capability="review:read"><div class="sidebar-section-label">Review</div>' +
                '<a class="sidebar-item'+act('reviews')+'" href="/reviews.html" data-capability="review:read">'+I.reviews+'My Reviews<span class="item-badge" id="reviewBadge" style="display:none">0</span></a>' +
                '<a class="sidebar-item'+act('onboarding')+'" href="/onboarding.html" data-capability="members:manage">'+I.onboarding+'Onboarding<span class="item-tag">NEW</span></a>' +
                '<a class="sidebar-item'+act('offboarding')+'" href="/offboarding.html" data-capability="members:manage">'+I.offboarding+'Offboarding</a>' +
              '</div>' +
              '<div class="sidebar-section"><div class="sidebar-section-label">Audit & Compliance</div>' +
                '<a class="sidebar-item'+act('audit-trail')+'" href="/audit-trail.html" data-capability="audit:read">'+I.audit+'Audit Trail</a>' +
                '<a class="sidebar-item'+act('sod')+'" href="/sod.html" data-capability="sod:read">'+I.sod+'SoD Conflicts<span class="item-badge" id="sodBadge" style="display:none">0</span></a>' +
                '<a class="sidebar-item'+act('evidence')+'" href="/evidence.html" data-capability="evidence:read">'+I.evidence+'Evidence Locker</a>' +
              '</div>' +
              '<div class="sidebar-section"><div class="sidebar-section-label">Administration</div>' +
                '<a class="sidebar-item'+act('data-sources')+'" href="/data-sources.html" data-capability="data-source:manage">'+I.datasource+'Data Sources</a>' +
                '<a class="sidebar-item'+act('admin-users')+'" href="/admin-users.html" data-capability="members:manage">'+I.users+'Users & Roles</a>' +
                '<a class="sidebar-item'+act('tenants')+'" href="/tenants.html" data-capability="tenant:read">'+I.tenants+'Tenants</a>' +
              '</div>' +
              '<div class="sidebar-section"><div class="sidebar-section-label">Settings</div>' +
                '<a class="sidebar-item'+act('settings')+'" href="/settings.html" data-capability="settings:read">'+I.settings+'Configuration</a>' +
                '<a class="sidebar-item'+act('api-keys')+'" href="/api-keys.html" data-capability="api-key:manage">'+I.apikeys+'API Keys</a>' +
              '</div>' +
            '</nav>' +
            '<div class="sidebar-footer"><div class="sidebar-user" id="sidebarUserArea" title="Click for options">' +
              '<div class="avatar" id="sidebarAvatar">U</div><div class="user-info"><div class="user-name" id="sidebarName">User</div><div class="user-role" id="sidebarRole"></div></div>' +
              '<svg class="user-chevron" width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
            '</div></div>' +
            '<div class="user-menu hidden" id="userMenu">' +
              '<div class="user-menu-header"><div class="avatar avatar-lg" id="menuAvatar">U</div><div class="user-menu-info"><div class="user-menu-name" id="menuName">User</div><div class="user-menu-email" id="menuEmail"></div><div class="user-menu-role" id="menuRole"></div></div></div>' +
              '<div class="user-menu-divider"></div>' +
              '<button class="user-menu-item" id="menuThemeToggle"><span class="umi-icon">🎨</span><span class="umi-label">Appearance</span><span class="umi-value" id="menuThemeLabel">System</span></button>' +
              '<button class="user-menu-item" onclick="location.href=\'/settings.html\'"><span class="umi-icon">⚙</span><span class="umi-label">Settings</span></button>' +
              '<div class="user-menu-divider"></div>' +
              '<button class="user-menu-item user-menu-signout" id="menuSignOut"><span class="umi-icon">🚪</span><span class="umi-label">Sign out</span></button>' +
            '</div>' +
          '</aside>';
      }
    });
  }

  // ══════ <attest-mobile-tabbar> ══════
  if (!customElements.get('attest-mobile-tabbar')) {
    customElements.define('attest-mobile-tabbar', class extends HTMLElement {
      connectedCallback() {
        var a = this.getAttribute('active') || '';
        var t = function(id, icon, label, href){return '<button class="mobile-tab'+(a===id?' active':'')+'" onclick="location.href=\''+href+'\'"><div class="mobile-tab-wrapper">'+icon+'</div><span>'+label+'</span></button>';};
        this.innerHTML =
          '<div class="mobile-tabbar"><div class="mobile-tabbar-inner">' +
            t('dashboard', I.dashboard.replace('class="item-icon"','style="width:22px;height:22px"'), 'Dashboard', '/dashboard.html') +
            t('reviews', I.reviews.replace('class="item-icon"','style="width:22px;height:22px"'), 'Reviews', '/reviews.html') +
            t('campaigns', I.campaigns.replace('class="item-icon"','style="width:22px;height:22px"'), 'Campaigns', '/campaigns.html') +
            t('audit', I.audit.replace('class="item-icon"','style="width:22px;height:22px"'), 'Audit', '/audit-trail.html') +
            t('more', I.more.replace('class="item-icon"','style="width:22px;height:22px"'), 'More', '/settings.html') +
          '</div></div>';
      }
    });
  }
})();

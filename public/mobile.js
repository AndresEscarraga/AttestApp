// Attest — Mobile Responsive Engine
// Premium iOS-style: off-canvas sidebar, bottom tab bar, swipe gestures, safe areas
(function(){
  'use strict';

  // Only activate on touch devices or narrow screens
  var isMobile = window.matchMedia('(max-width:1024px)').matches;
  var isPhone  = window.matchMedia('(max-width:768px)').matches;

  // ── Hamburger + Sidebar Overlay ──
  function initSidebar() {
    var sidebar = document.querySelector('.sidebar');
    if (!sidebar) return;

    // Create overlay
    var overlay = document.createElement('div');
    overlay.className = 'sidebar-overlay';
    document.body.appendChild(overlay);

    // Create hamburger button
    var hamburger = document.createElement('button');
    hamburger.className = 'hamburger-btn';
    hamburger.setAttribute('aria-label', 'Menu');
    var line = document.createElement('span');
    line.className = 'hamburger-line';
    hamburger.appendChild(line);

    // Insert hamburger as first child of topbar
    var topbar = document.querySelector('.topbar');
    if (topbar) topbar.insertBefore(hamburger, topbar.firstChild);

    function openSidebar() {
      sidebar.classList.add('open');
      overlay.classList.add('visible');
      document.body.classList.add('sidebar-open');
      document.body.style.overflow = 'hidden';
    }
    function closeSidebar() {
      sidebar.classList.remove('open');
      overlay.classList.remove('visible');
      document.body.classList.remove('sidebar-open');
      document.body.style.overflow = '';
    }

    hamburger.addEventListener('click', function() {
      sidebar.classList.contains('open') ? closeSidebar() : openSidebar();
    });
    overlay.addEventListener('click', closeSidebar);

    // Swipe to open (right edge of screen)
    var touchStartX = 0;
    document.addEventListener('touchstart', function(e) {
      if (e.touches.length === 1) touchStartX = e.touches[0].clientX;
    }, {passive:true});
    document.addEventListener('touchend', function(e) {
      var dx = (e.changedTouches[0]?.clientX || 0) - touchStartX;
      if (dx > 60 && touchStartX < 20 && !sidebar.classList.contains('open')) {
        openSidebar();
      }
    }, {passive:true});

    // Close sidebar on nav link click (mobile)
    sidebar.addEventListener('click', function(e) {
      var link = e.target.closest('.sidebar-item');
      if (link && link.href && isPhone) {
        setTimeout(closeSidebar, 150);
      }
    });

    // Escape key
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape' && sidebar.classList.contains('open')) closeSidebar();
    });

    // Auto-close on resize to desktop
    window.matchMedia('(min-width:1025px)').addEventListener('change', function(e) {
      if (e.matches) closeSidebar();
    });
  }

  // ── Bottom Tab Bar (iOS style) ──
  function initTabBar() {
    if (!isPhone) return;
    if (document.querySelector('.mobile-tabbar')) return; // already exists

    var tabs = [
      { icon:'⊞', label:'Dashboard', href:'/dashboard.html' },
      { icon:'☰', label:'Reviews',   href:'/reviews.html' },
      { icon:'⊟', label:'Campaigns', href:'/campaigns.html' },
      { icon:'☷', label:'Audit',     href:'/audit-trail.html' },
      { icon:'⊡', label:'More',      href:'/tenants.html' }
    ];

    var currentPath = location.pathname.replace(/^\//,'');
    if (!currentPath) currentPath = 'dashboard.html';

    var tabbar = document.createElement('nav');
    tabbar.className = 'mobile-tabbar';
    var inner = document.createElement('div');
    inner.className = 'mobile-tabbar-inner';

    tabs.forEach(function(t) {
      var tab = document.createElement('button');
      tab.className = 'mobile-tab';
      if (currentPath === t.href.replace(/^\//,'')) tab.classList.add('active');
      tab.setAttribute('aria-label', t.label);
      tab.innerHTML = '<div class="mobile-tab-wrapper"><span style="font-size:20px">' + t.icon + '</span></div><span>' + t.label + '</span>';
      tab.addEventListener('click', function() {
        location.href = t.href;
      });
      inner.appendChild(tab);
    });

    tabbar.appendChild(inner);
    document.body.appendChild(tabbar);
  }

  // ── Adjust main content for tab bar ──
  function adjustForTabBar() {
    if (isPhone) {
      document.body.classList.add('has-tabbar');
    }
  }

  // ── Run ──
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() {
      initSidebar();
      initTabBar();
      adjustForTabBar();
    });
  } else {
    initSidebar();
    initTabBar();
    adjustForTabBar();
  }
})();

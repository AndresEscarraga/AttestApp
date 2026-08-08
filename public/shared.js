// Attest — Shared JS: auth, dark mode, sign out, sidebar user info.
// Include this script on every page. No other page should duplicate auth/darkmode/signout logic.
(function(){
  'use strict';
  var Attest=window.Attest=window.Attest||{};
  var token=localStorage.getItem('attest_token');
  var isLocalDev=location.hostname==='localhost'||location.hostname==='127.0.0.1'||location.hostname.includes('.local');
  var origFetch=window.fetch.bind(window);
  var apiState={user:null,userPromise:null,tenantId:null,generation:0,controllers:new Set()};

  // ── Auth: redirect to login only in production when no token ──
  if(!token&&!isLocalDev&&location.pathname!=='/login.html'){
    location.href='/login.html';return;
  }

  function ApiError(message,status,code,requestId){
    this.name='ApiError';this.message=message||'Request failed.';this.status=status||0;this.code=code||'REQUEST_FAILED';this.requestId=requestId||'';
  }
  ApiError.prototype=Object.create(Error.prototype);

  function staleTenantError(){
    var err=new Error('The response belongs to an inactive tenant context.');
    err.name='StaleTenantResponseError';
    err.code='STALE_TENANT_RESPONSE';
    return err;
  }

  function abortTenantRequests(){
    apiState.generation+=1;
    apiState.controllers.forEach(function(controller){controller.abort();});
    apiState.controllers.clear();
  }

  function apiFetch(input,opts){
    opts=Object.assign({},opts||{});
    var url=typeof input==='string'?new URL(input,location.href):new URL(input.url,location.href);
    if(url.origin!==location.origin)return origFetch(input,opts);
    var generation=apiState.generation;
    var controller=new AbortController();
    var callerSignal=opts.signal;
    if(callerSignal){
      if(callerSignal.aborted)controller.abort();
      else callerSignal.addEventListener('abort',function(){controller.abort();},{once:true});
    }
    opts.signal=controller.signal;
    var baseHeaders=opts.headers||(typeof Request!=='undefined'&&input instanceof Request?input.headers:undefined);
    var headers=new Headers(baseHeaders||{});
    token=localStorage.getItem('attest_token');
    if(token&&!headers.has('Authorization'))headers.set('Authorization','Bearer '+token);
    headers.set('X-Attest-Client-Generation',String(generation));
    opts.headers=headers;
    apiState.controllers.add(controller);
    var timeoutMs=Number(opts.timeoutMs)||15000;
    delete opts.timeoutMs;
    var timeout=setTimeout(function(){controller.abort();},timeoutMs);
    return origFetch(input,opts).then(async function(response){
      if(generation!==apiState.generation)throw staleTenantError();
      if(!response.ok){
        var payload={};
        try{payload=await response.clone().json();}catch(parseError){payload={};}
        throw new ApiError(payload.error||('HTTP '+response.status),response.status,payload.code,payload.requestId||response.headers.get('X-Request-ID'));
      }
      return response;
    }).catch(function(err){
      if(generation!==apiState.generation)throw staleTenantError();
      if(err&&err.name==='AbortError'){
        var aborted=new Error('Request cancelled or timed out.');aborted.name='AbortError';aborted.code='REQUEST_ABORTED';throw aborted;
      }
      throw err;
    }).finally(function(){
      clearTimeout(timeout);apiState.controllers.delete(controller);
    });
  }

  async function apiJson(input,opts){
    var response=await apiFetch(input,opts);
    if(response.status===204)return null;
    return response.json();
  }

  function getCurrentUser(force){
    if(apiState.user&&!force)return Promise.resolve(apiState.user);
    if(apiState.userPromise&&!force)return apiState.userPromise;
    apiState.userPromise=apiJson('/api/me').then(function(me){
      apiState.user=Object.freeze(me);
      apiState.tenantId=me.tenantId;
      localStorage.setItem('attest_active_tenant',me.tenantId);
      window.__attestUser=apiState.user;
      return apiState.user;
    }).finally(function(){apiState.userPromise=null;});
    return apiState.userPromise;
  }

  Attest.api={fetch:apiFetch,json:apiJson,abortAll:abortTenantRequests,get generation(){return apiState.generation;}};
  Attest.getCurrentUser=getCurrentUser;
  Attest.hasCapability=function(capability){return !!apiState.user&&Array.isArray(apiState.user.capabilities)&&apiState.user.capabilities.includes(capability);};

  // ── Dark mode from saved preference ──
  var saved=localStorage.getItem('attest_theme');
  if(saved==='dark')document.documentElement.setAttribute('data-theme','dark');

  // ── Dark mode toggle: Ctrl+Shift+D or click any .dark-toggle button ──
  function toggleDark(){
    var isDark=document.documentElement.getAttribute('data-theme')==='dark';
    document.documentElement.setAttribute('data-theme',isDark?'light':'dark');
    localStorage.setItem('attest_theme',isDark?'light':'dark');
    var btns=document.querySelectorAll('.dark-toggle,.topbar-btn[id*="darkToggle"]');
    for(var i=0;i<btns.length;i++)btns[i].textContent=isDark?'🌙':'☀️';
    // Update theme label in user menu
    var tl=document.getElementById('menuThemeLabel');
    if(tl)tl.textContent=isDark?'Light':'Dark';
  }
  document.addEventListener('keydown',function(e){if(e.ctrlKey&&e.shiftKey&&e.key==='D'){e.preventDefault();toggleDark();}});

  // ── User menu: toggle dropdown on click ──
  var userMenuOpen = false;
  document.addEventListener('click',function(e){
    var userArea=e.target.closest('#sidebarUserArea,.sidebar-user');
    var menuItem=e.target.closest('#userMenu');
    var menu = document.getElementById('userMenu');

    if(userArea && !menuItem){
      // Toggle menu
      userMenuOpen = !userMenuOpen;
      if(menu) menu.classList.toggle('hidden', !userMenuOpen);
      if(userArea) userArea.classList.toggle('open', userMenuOpen);
    } else if(!menuItem){
      // Close menu if clicking outside
      userMenuOpen = false;
      if(menu) menu.classList.add('hidden');
      var ua = document.getElementById('sidebarUserArea');
      if(ua) ua.classList.remove('open');
    }
  });

  // Sign out button
  document.addEventListener('click',function(e){
    if(e.target.closest('#menuSignOut')){
      localStorage.removeItem('attest_token');
      localStorage.removeItem('attest_user');
      location.href='/login.html';
    }
  });

  // Theme toggle from user menu
  document.addEventListener('click',function(e){
    if(e.target.closest('#menuThemeToggle')){
      toggleDark();
    }
  });

  // ── Load user info into sidebar (runs once on DOM ready) ──
  function loadSidebarUser() {
    getCurrentUser().then(function(me){
      if(!me||!me.email)return;
      // Avatar initials
      var initials=(me.approverName||me.email||'U').split(' ').map(function(n){return n[0];}).join('').substring(0,2).toUpperCase();
      var av=document.getElementById('sidebarAvatar');
      var nm=document.getElementById('sidebarName');
      var rl=document.getElementById('sidebarRole');
      if(av)av.textContent=initials;
      if(nm)nm.textContent=me.approverName||me.email||'User';
      if(rl)rl.textContent=me.isAdmin?'Administrator':'Approver';

      // Populate user menu dropdown
      var mav=document.getElementById('menuAvatar');
      var mname=document.getElementById('menuName');
      var memail=document.getElementById('menuEmail');
      var mrole=document.getElementById('menuRole');
      if(mav)mav.textContent=initials;
      if(mname)mname.textContent=me.approverName||me.email||'User';
      if(memail)memail.textContent=me.email;
      if(mrole)mrole.textContent=me.isAdmin?'Administrator':'Approver';

      // Theme label in menu
      var themeLabel=document.getElementById('menuThemeLabel');
      if(themeLabel){
        var curTheme=document.documentElement.getAttribute('data-theme');
        themeLabel.textContent=curTheme==='dark'?'Dark':'Light';
      }

      populateTenantSelector(me);

      // Role-based sidebar visibility
      applyCapabilityVisibility(me);
      // Update sidebar role label
      if(rl) {
        var roleLabels = {admin:'Administrator', approver:'Approver', auditor:'Auditor'};
        rl.textContent = roleLabels[me.role] || (me.isAdmin ? 'Administrator' : 'Approver');
      }

      // Fire event so page scripts know user is loaded
      document.dispatchEvent(new CustomEvent('attest:userLoaded',{detail:me}));
    }).catch(function(err){
      console.error('Could not load current tenant context:',err);
      showLoadError(document.querySelector('.main-content')||document.body,'Could not load the active organization.',loadSidebarUser);
    });
  }

  function populateTenantSelector(me){
    var sel=document.getElementById('tenantSelector');
    if(!sel)return;
    sel.innerHTML='';
    (me.tenants||[]).forEach(function(t){
      var o=document.createElement('option');
      o.value=t.id;
      o.textContent=t.name;
      if(t.id===me.tenantId)o.selected=true;
      sel.appendChild(o);
    });
    if(!(me.tenants||[]).length){
      var fallback=document.createElement('option');
      fallback.value=me.tenantId||'';
      fallback.textContent=(me.tenant&&me.tenant.name)||'Current organization';
      sel.appendChild(fallback);
    }
    sel.value=me.tenantId||sel.value;
    sel.disabled=(me.tenants||[]).length<2;
    if(sel.dataset.attestTenantWired==='1')return;
    sel.dataset.attestTenantWired='1';
    sel.addEventListener('change',function(){
      switchTenant(sel.value,me.tenantId,sel);
    });
  }

  async function switchTenant(tenantId,previousTenantId,selector){
    if(!tenantId||tenantId===previousTenantId)return;
    if(selector)selector.disabled=true;
    abortTenantRequests();
    apiState.user=null;
    apiState.userPromise=null;
    if(notifState.polling){clearInterval(notifState.polling);notifState.polling=null;}
    document.dispatchEvent(new CustomEvent('attest:tenantChanging',{detail:{from:previousTenantId,to:tenantId}}));
    try{
      var response=await apiFetch('/api/auth/switch-tenant',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({tenant_id:tenantId})
      });
      var data=await response.json().catch(function(){return{};});
      if(!response.ok||!data.token)throw new Error(data.error||'Failed to switch organization.');
      localStorage.setItem('attest_token',data.token);
      localStorage.setItem('attest_active_tenant',tenantId);
      token=data.token;
      apiState.tenantId=tenantId;
      document.dispatchEvent(new CustomEvent('attest:tenantChanged',{detail:{from:previousTenantId,to:tenantId}}));
      location.reload();
    }catch(err){
      if(selector){selector.value=previousTenantId;selector.disabled=false;}
      showToast(err.message||'Failed to switch organization.','error');
    }
  }

  document.addEventListener('DOMContentLoaded',function(){
    // Wire dark toggle buttons
    var btns=document.querySelectorAll('.dark-toggle,.topbar-btn[id*="darkToggle"]');
    var curIsDark=document.documentElement.getAttribute('data-theme')==='dark';
    for(var i=0;i<btns.length;i++){btns[i].textContent=curIsDark?'☀️':'🌙';btns[i].addEventListener('click',toggleDark);}

    // Load sidebar user info
    loadSidebarUser();

    // Init notifications
    initNotifications();

    // Init search
    initSearch();

    // Init language selector
    initLangSelector();

    // Init help button
    initHelp();

    // Init table sorting on sortable headers
    initTableSort();

    // Init View Transitions for smooth page navigation
    initViewTransitions();

    // Register service worker for offline caching
    if('serviceWorker' in navigator){
      navigator.serviceWorker.register('/sw.js').catch(function(err){console.warn('Service worker registration failed:',err);});
    }

    // Inject PWA manifest link
    var manifestLink = document.createElement('link');
    manifestLink.rel = 'manifest';
    manifestLink.href = '/manifest.json';
    document.head.appendChild(manifestLink);
  });

  // ── Notifications System ──
  var notifState = { unread:0, open:false, polling:null };

  function initNotifications(){
    var bell = document.getElementById('notifBell');
    var dropdown = document.getElementById('notifDropdown');
    if(!bell || !dropdown) return;

    // Toggle dropdown
    bell.addEventListener('click', function(e){
      e.stopPropagation();
      notifState.open = !notifState.open;
      dropdown.classList.toggle('hidden', !notifState.open);
      if(notifState.open) loadNotifications();
    });

    // Close on outside click
    document.addEventListener('click', function(e){
      if(notifState.open && !e.target.closest('#notifWrapper')){
        notifState.open = false;
        dropdown.classList.add('hidden');
      }
    });

    // Mark all read
    var markAll = document.getElementById('notifMarkAll');
    if(markAll) markAll.addEventListener('click', function(e){
      e.stopPropagation();
      apiFetch('/api/notifications/read-all', { method:'PATCH' }).then(function(){
        notifState.unread = 0;
        updateBadge();
        loadNotifications();
      }).catch(function(err){showToast(err.message||'Could not update notifications.','error');});
    });

    // Initial load + poll every 30s
    fetchUnreadCount();
    notifState.polling = setInterval(fetchUnreadCount, 30000);
  }

  function fetchUnreadCount(){
    apiJson('/api/notifications/unread-count').then(function(d){
      notifState.unread = d.count || 0;
      updateBadge();
    }).catch(function(err){console.error('Unread notification count failed:',err);});
  }

  function updateBadge(){
    var badge = document.getElementById('notifBadge');
    if(!badge) return;
    if(notifState.unread > 0){
      badge.textContent = notifState.unread > 99 ? '99+' : notifState.unread;
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  }

  function loadNotifications(){
    apiJson('/api/notifications?limit=20').then(function(d){
      var list = document.getElementById('notifList');
      if(!list) return;
      var notifs = d.notifications || [];
      if(!notifs.length){
        list.innerHTML = '<div class="notif-empty">No notifications yet</div>';
        return;
      }
      var html = '';
      notifs.forEach(function(n){
        var timeAgo = timeSince(new Date(n.created_at));
        html += '<div class="notif-item' + (!n.read ? ' unread' : '') + '" data-id="' + n.id + '" data-link="' + (n.link || '') + '">' +
          '<div class="notif-icon">' + (n.icon || '🔔') + '</div>' +
          '<div class="notif-body">' +
            '<div class="notif-item-title">' + escHTML(n.title) + '</div>' +
            (n.body ? '<div class="notif-item-text">' + escHTML(n.body) + '</div>' : '') +
            '<div class="notif-item-time">' + timeAgo + '</div>' +
          '</div>' +
        '</div>';
      });
      list.innerHTML = html;

      // Click to mark read and navigate
      list.querySelectorAll('.notif-item').forEach(function(item){
        item.addEventListener('click', function(){
          var id = item.dataset.id;
          var link = item.dataset.link;
          // Mark as read
          apiFetch('/api/notifications/' + id + '/read', { method:'PATCH' }).catch(function(err){showToast(err.message||'Could not update notification.','error');});
          item.classList.remove('unread');
          if(notifState.unread > 0) notifState.unread--;
          updateBadge();
          // Navigate
          if(link) location.href = link;
        });
      });
    }).catch(function(err){
      var list=document.getElementById('notifList');
      if(list)showLoadError(list,'Could not load notifications.',loadNotifications);
    });
  }

  function timeSince(date){
    var seconds = Math.floor((new Date() - date) / 1000);
    if(seconds < 60) return 'Just now';
    var minutes = Math.floor(seconds / 60);
    if(minutes < 60) return minutes + 'm ago';
    var hours = Math.floor(minutes / 60);
    if(hours < 24) return hours + 'h ago';
    var days = Math.floor(hours / 24);
    if(days < 7) return days + 'd ago';
    return date.toLocaleDateString('en-US', {month:'short', day:'numeric'});
  }

  function escHTML(s){
    return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  // ── Role-based UI visibility ──
  function applyCapabilityVisibility(me) {
    var role=me.role||'auditor';
    var capabilities=me.capabilities||[];
    var roleRequirements={admin:'members:manage',approver:'review:submit',auditor:'dashboard:read'};
    document.body.classList.add('role-'+role);
    document.querySelectorAll('[data-capability],[data-min-role]').forEach(function(element){
      var required=element.getAttribute('data-capability')||roleRequirements[element.getAttribute('data-min-role')]||'dashboard:read';
      element.style.display=capabilities.includes(required)?'':'none';
    });
    document.querySelectorAll('.sidebar-section').forEach(function(section){
      var visible=Array.from(section.querySelectorAll('.sidebar-item')).some(function(item){return item.style.display!=='none';});
      if(!visible)section.style.display='none';
    });
  }

  // ── View Transitions API — smooth crossfade between pages ──
  function initViewTransitions() {
    // Only if browser supports it (Chrome/Edge 111+, Safari 18+)
    if (!document.startViewTransition) return;

    // Intercept sidebar navigation
    document.addEventListener('click', function(e) {
      var link = e.target.closest('a.sidebar-item[href]');
      if (!link) return;
      // Skip if modifier key pressed (user wants new tab)
      if (e.ctrlKey || e.metaKey || e.shiftKey) return;
      // Skip if target is external or different origin
      if (link.target === '_blank' || link.origin !== location.origin) return;
      // Skip same-page anchors
      if (link.href === location.href) return;

      e.preventDefault();
      var url = link.href;
      document.startViewTransition(function() {
        location.href = url;
      });
    });

    // Intercept mobile tabbar navigation (buttons with onclick)
    document.addEventListener('click', function(e) {
      var btn = e.target.closest('.mobile-tab');
      if (!btn) return;
      var onclick = btn.getAttribute('onclick');
      if (!onclick) return;
      // Extract URL from onclick="location.href='...'"
      var match = onclick.match(/location\.href\s*=\s*['"]([^'"]+)['"]/);
      if (!match) return;

      e.preventDefault();
      e.stopPropagation();
      var url = match[1];
      // Resolve relative URL
      var a = document.createElement('a');
      a.href = url;
      document.startViewTransition(function() {
        location.href = a.href;
      });
    }, true); // capture phase to beat the onclick handler
  }

  // ── Global Search Handler ──
  var searchDebounce = null;
  function initSearch() {
    var searchInput = document.querySelector('.topbar-search input');
    if (!searchInput) return;
    searchInput.addEventListener('input', function() {
      clearTimeout(searchDebounce);
      var query = searchInput.value.trim();
      searchDebounce = setTimeout(function() {
        document.dispatchEvent(new CustomEvent('attest:search', { detail: { query: query } }));
      }, 200);
    });
    // Clear search on Escape
    searchInput.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') { searchInput.value = ''; searchInput.dispatchEvent(new Event('input')); }
    });
  }

  // ── Toast Notification System ──
  var toastTimer = null;
  function showToast(message, type) {
    var existing = document.getElementById('attestToast');
    if (existing) existing.remove();
    clearTimeout(toastTimer);
    type = type || 'info';
    var colors = { success: 'var(--success)', error: 'var(--danger)', warning: 'var(--warning)', info: 'var(--accent)' };
    var icons = { success: '✓', error: '✕', warning: '⚠', info: 'ℹ' };
    var toast = document.createElement('div');
    toast.id = 'attestToast';
    toast.className = 'toast toast-' + type;
    toast.innerHTML = '<span class="toast-icon">' + (icons[type] || 'ℹ') + '</span><span class="toast-msg">' + Attest.escHtml(message) + '</span>' +
      '<button class="toast-close" onclick="this.parentNode.remove()">&times;</button>';
    document.body.appendChild(toast);
    toastTimer = setTimeout(function() { if (toast.parentNode) toast.remove(); }, 5000);
  }

  function showLoadError(container,message,retry){
    if(!container)return;
    var existing=container.querySelector('.attest-load-error');
    if(existing)existing.remove();
    var box=document.createElement('div');
    box.className='attest-load-error';
    box.setAttribute('role','alert');
    var text=document.createElement('span');text.textContent=message||'Could not load data.';box.appendChild(text);
    if(typeof retry==='function'){
      var button=document.createElement('button');button.type='button';button.className='btn btn-sm btn-secondary';button.textContent='Retry';
      button.addEventListener('click',function(){box.remove();retry();});box.appendChild(button);
    }
    container.appendChild(box);
    return box;
  }

  function clearLoadError(container){
    if(!container)return;
    var existing=container.querySelector('.attest-load-error');
    if(existing)existing.remove();
  }

  // ── Retry wrapper for fetch ──
  function fetchWithRetry(url, opts, maxRetries) {
    maxRetries = maxRetries || 2;
    opts = opts || {};
    return new Promise(function(resolve, reject) {
      var attempt = 0;
      function tryFetch() {
        attempt++;
        apiFetch(url, opts).then(function(res) {
          resolve(res);
        }).catch(function(err) {
          var retryable=!err.status||err.status>=500||err.code==='REQUEST_ABORTED';
          if (retryable&&attempt <= maxRetries) {
            setTimeout(tryFetch, 1000 * attempt);
          } else {
            reject(err);
          }
        });
      }
      tryFetch();
    });
  }

  // ── Language Selector ──
  function initLangSelector() {
    var sel = document.getElementById('langSelect');
    if (!sel) return;
    sel.addEventListener('change', function() {
      var val = sel.value;
      if (val === 'ES') {
        showToast('Idioma español próximamente — Spanish coming soon', 'info');
        sel.value = 'EN';
      }
    });
  }

  // ── Help Modal ──
  function initHelp() {
    var helpBtn = document.querySelector('.topbar-btn[title="Help"]');
    if (!helpBtn) return;
    helpBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      showHelpModal();
    });
  }

  function showHelpModal() {
    var existing = document.getElementById('helpModal');
    if (existing) { existing.remove(); return; }
    var backdrop = document.createElement('div');
    backdrop.id = 'helpModal';
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = '<div class="modal" style="max-width:520px">' +
      '<div class="modal-header"><h3>Help &amp; Keyboard Shortcuts</h3><button class="modal-close">&times;</button></div>' +
      '<div class="modal-body" style="font-size:13px;line-height:1.6">' +
        '<p style="margin-bottom:12px"><strong>Attest</strong> is an access certification &amp; role governance tool for compliance teams.</p>' +
        '<div style="background:var(--bg-root);border-radius:8px;padding:12px 16px;margin-bottom:12px">' +
          '<div style="font-weight:700;margin-bottom:8px;font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--text-tertiary)">Keyboard Shortcuts</div>' +
          '<div style="display:grid;grid-template-columns:auto 1fr;gap:4px 12px;font-size:12px">' +
            '<span style="font-family:monospace;background:var(--border);padding:1px 6px;border-radius:3px;font-weight:600">Ctrl+Shift+D</span><span>Toggle dark mode</span>' +
            '<span style="font-family:monospace;background:var(--border);padding:1px 6px;border-radius:3px;font-weight:600">Esc</span><span>Clear search</span>' +
          '</div>' +
        '</div>' +
        '<p style="font-size:11px;color:var(--text-tertiary)">For support, contact your system administrator.</p>' +
      '</div>' +
      '<div class="modal-footer"><button class="btn btn-primary" id="helpClose">Got it</button></div>' +
    '</div>';
    document.body.appendChild(backdrop);
    backdrop.querySelector('.modal-close').addEventListener('click', function(){backdrop.remove();});
    backdrop.querySelector('#helpClose').addEventListener('click', function(){backdrop.remove();});
    backdrop.addEventListener('click', function(e){ if(e.target===backdrop) backdrop.remove(); });
  }

  // ── Table Column Sorting ──
  function initTableSort() {
    document.addEventListener('click', function(e) {
      var th = e.target.closest('th.sortable');
      if (!th) return;
      var table = th.closest('table');
      var tbody = table ? table.querySelector('tbody') : null;
      if (!tbody) return;
      var colIndex = Array.from(th.parentNode.children).indexOf(th);
      var isAsc = th.getAttribute('data-sort') !== 'asc';
      // Update sort indicators
      th.closest('thead').querySelectorAll('th').forEach(function(h) { h.removeAttribute('data-sort'); });
      th.setAttribute('data-sort', isAsc ? 'asc' : 'desc');
      // Sort rows
      var rows = Array.from(tbody.querySelectorAll('tr'));
      rows.sort(function(a, b) {
        var aVal = (a.cells[colIndex] ? a.cells[colIndex].textContent : '').trim().toLowerCase();
        var bVal = (b.cells[colIndex] ? b.cells[colIndex].textContent : '').trim().toLowerCase();
        // Numeric comparison if both are numbers
        var aNum = parseFloat(aVal), bNum = parseFloat(bVal);
        if (!isNaN(aNum) && !isNaN(bNum) && aVal === String(aNum) && bVal === String(bNum)) {
          return isAsc ? aNum - bNum : bNum - aNum;
        }
        return isAsc ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
      });
      rows.forEach(function(row) { tbody.appendChild(row); });
    });
  }

  // Expose helpers globally
  Attest.fmtDate=function(iso){try{return new Date(iso).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit'});}catch(e){return iso;}};
  Attest.escHtml=function(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');};
  Attest.el=function(id){return document.getElementById(id);};
  Attest.showToast=showToast;
  Attest.showLoadError=showLoadError;
  Attest.clearLoadError=clearLoadError;
  Attest.fetchWithRetry=fetchWithRetry;

  // ── Confirm Dialog (replaces native confirm) ──
  var confirmModal=null,confirmResolve=null;
  function getConfirmModal(){
    if(confirmModal)return confirmModal;
    var bd=document.createElement('div');bd.className='modal-backdrop hidden';bd.id='attestConfirmBackdrop';
    bd.innerHTML='<div class="modal" style="width:400px"><div class="modal-header"><h3 id="confirmTitle">Confirm</h3><button class="modal-close" id="confirmClose">✕</button></div><div class="modal-body"><p id="confirmMessage" style="font-size:13px;line-height:1.5;color:var(--text-secondary)"></p></div><div class="modal-footer"><button class="btn btn-secondary" id="confirmCancel">Cancel</button><button class="btn btn-primary" id="confirmOk">Confirm</button></div></div>';
    document.body.appendChild(bd);
    confirmModal=bd;
    bd.querySelector('#confirmClose').addEventListener('click',function(){resolveConfirm(false);});
    bd.querySelector('#confirmCancel').addEventListener('click',function(){resolveConfirm(false);});
    bd.querySelector('#confirmOk').addEventListener('click',function(){resolveConfirm(true);});
    bd.addEventListener('click',function(e){if(e.target===bd)resolveConfirm(false);});
    document.addEventListener('keydown',function(e){if(e.key==='Escape'&&!bd.classList.contains('hidden'))resolveConfirm(false);});
    return confirmModal;
  }
  function resolveConfirm(result){
    var m=getConfirmModal();
    m.classList.add('closing');
    setTimeout(function(){m.classList.add('hidden');m.classList.remove('closing');},180);
    if(confirmResolve){confirmResolve(result);confirmResolve=null;}
  }
  window.Attest.confirm=function(message,title){
    return new Promise(function(resolve){
      var m=getConfirmModal();
      m.querySelector('#confirmTitle').textContent=title||'Confirm';
      m.querySelector('#confirmMessage').textContent=message;
      m.querySelector('#confirmOk').textContent=title==='Delete'?'Delete':'Confirm';
      m.querySelector('#confirmOk').className='btn '+(title==='Delete'?'btn-danger':'btn-primary');
      m.classList.remove('hidden');
      confirmResolve=resolve;
    });
  };
  window.Attest.alert=function(message,title){
    return new Promise(function(resolve){
      var m=getConfirmModal();
      m.querySelector('#confirmTitle').textContent=title||'Notice';
      m.querySelector('#confirmMessage').textContent=message;
      m.querySelector('#confirmCancel').classList.add('hidden');
      m.querySelector('#confirmOk').textContent='OK';
      m.querySelector('#confirmOk').className='btn btn-primary';
      m.classList.remove('hidden');
      confirmResolve=function(){m.querySelector('#confirmCancel').classList.remove('hidden');resolve();};
    });
  };

  // ── Button Loading State ──
  window.Attest.btnLoading=function(btn,loading,text){
    if(loading){
      btn._prevHTML=btn.innerHTML;btn._prevDisabled=btn.disabled;
      btn.disabled=true;
      btn.innerHTML='<span class="btn-spinner"></span> '+(text||'Loading…');
    }else{
      btn.disabled=btn._prevDisabled||false;
      btn.innerHTML=btn._prevHTML||btn.textContent;
    }
  };
})();

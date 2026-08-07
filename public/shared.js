// Attest — Shared JS: auth, dark mode, sign out, sidebar user info.
// Include this script on every page. No other page should duplicate auth/darkmode/signout logic.
(function(){
  'use strict';
  var token=localStorage.getItem('attest_token');
  var isLocalDev=location.hostname==='localhost'||location.hostname==='127.0.0.1'||location.hostname.includes('.local');

  // ── Auth: redirect to login only in production when no token ──
  if(!token&&!isLocalDev&&location.pathname!=='/login.html'){
    location.href='/login.html';return;
  }

  // ── Auth header inject (runs before page JS, so all fetch() calls get the token) ──
  var origFetch=window.fetch;
  window.fetch=function(url,opts){
    opts=opts||{};opts.headers=opts.headers||{};
    if(token&&!opts.headers['Authorization'])opts.headers['Authorization']='Bearer '+token;
    return origFetch(url,opts);
  };

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
  }
  document.addEventListener('keydown',function(e){if(e.ctrlKey&&e.shiftKey&&e.key==='D'){e.preventDefault();toggleDark();}});

  // ── Sign out: click sidebar user area ──
  document.addEventListener('click',function(e){
    var userArea=e.target.closest('#sidebarUserArea,.sidebar-user');
    if(userArea&&confirm('Sign out?')){
      localStorage.removeItem('attest_token');localStorage.removeItem('attest_user');
      location.href='/login.html';
    }
  });

  // ── Load user info into sidebar (runs once on DOM ready) ──
  function loadSidebarUser() {
    fetch('/api/me').then(function(r){return r.json().catch(function(){return{};});}).then(function(me){
      if(!me||!me.email)return;
      // Avatar initials
      var initials=(me.approverName||me.email||'U').split(' ').map(function(n){return n[0];}).join('').substring(0,2).toUpperCase();
      var av=document.getElementById('sidebarAvatar');
      var nm=document.getElementById('sidebarName');
      var rl=document.getElementById('sidebarRole');
      if(av)av.textContent=initials;
      if(nm)nm.textContent=me.approverName||me.email||'User';
      if(rl)rl.textContent=me.isAdmin?'Administrator':'Approver';

      // Tenant selector
      if(me.tenants&&me.tenants.length>1){
        var sel=document.getElementById('tenantSelector');
        if(sel){sel.innerHTML='';me.tenants.forEach(function(t){var o=document.createElement('option');o.value=t.id;o.textContent=t.name;if(t.id===me.tenantId)o.selected=true;sel.appendChild(o);});}
      }

      // Store user info globally for page scripts to use
      window.__attestUser=me;
      // Fire event so page scripts know user is loaded
      document.dispatchEvent(new CustomEvent('attest:userLoaded',{detail:me}));
    }).catch(function(){});
  }

  document.addEventListener('DOMContentLoaded',function(){
    // Wire dark toggle buttons
    var btns=document.querySelectorAll('.dark-toggle,.topbar-btn[id*="darkToggle"]');
    var curIsDark=document.documentElement.getAttribute('data-theme')==='dark';
    for(var i=0;i<btns.length;i++){btns[i].textContent=curIsDark?'☀️':'🌙';btns[i].addEventListener('click',toggleDark);}

    // Load sidebar user info
    loadSidebarUser();
  });

  // Expose helpers globally
  window.Attest={};
  window.Attest.fmtDate=function(iso){try{return new Date(iso).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit'});}catch(e){return iso;}};
  window.Attest.escHtml=function(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');};
  window.Attest.el=function(id){return document.getElementById(id);};
})();

// Shared dark mode & sign out — included by all pages
(function(){
  var token=localStorage.getItem('attest_token');
  if(!token){location.href='/login.html';}

  // Auth header inject
  var origFetch=window.fetch;
  window.fetch=function(url,opts){opts=opts||{};opts.headers=opts.headers||{};if(token&&!opts.headers['Authorization'])opts.headers['Authorization']='Bearer '+token;return origFetch(url,opts);};

  // Dark mode from saved preference
  var saved=localStorage.getItem('attest_theme');
  if(saved==='dark')document.documentElement.setAttribute('data-theme','dark');

  // Dark mode toggle: Ctrl+Shift+D or click any .dark-toggle button
  function toggleDark(){
    var isDark=document.documentElement.getAttribute('data-theme')==='dark';
    document.documentElement.setAttribute('data-theme',isDark?'light':'dark');
    localStorage.setItem('attest_theme',isDark?'light':'dark');
    // Update all dark toggle buttons
    var btns=document.querySelectorAll('.dark-toggle,.topbar-btn[id*="darkToggle"]');
    for(var i=0;i<btns.length;i++)btns[i].textContent=isDark?'🌙':'☀️';
  }
  document.addEventListener('keydown',function(e){if(e.ctrlKey&&e.shiftKey&&e.key==='D'){e.preventDefault();toggleDark();}});

  // Wire any dark toggle buttons found in page
  document.addEventListener('DOMContentLoaded',function(){
    var btns=document.querySelectorAll('.dark-toggle,.topbar-btn[id*="darkToggle"]');
    var curIsDark=document.documentElement.getAttribute('data-theme')==='dark';
    for(var i=0;i<btns.length;i++){btns[i].textContent=curIsDark?'☀️':'🌙';btns[i].addEventListener('click',toggleDark);}
  });

  // Sign out: click sidebar user area
  document.addEventListener('click',function(e){
    var userArea=e.target.closest('#sidebarUserArea,.sidebar-user');
    if(userArea&&confirm('Sign out?')){
      localStorage.removeItem('attest_token');localStorage.removeItem('attest_user');
      location.href='/login.html';
    }
  });
})();

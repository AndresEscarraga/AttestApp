// Attest — Admin Log frontend (aligned with mockup-futuro.html)
(function () {
  'use strict';

  var token = localStorage.getItem('attest_token');
  var origFetch = window.fetch;
  window.fetch = function(url, opts) {
    opts = opts || {}; opts.headers = opts.headers || {};
    if (token && !opts.headers['Authorization']) opts.headers['Authorization'] = 'Bearer ' + token;
    return origFetch(url, opts);
  };

  var ACTION_ORDER = ['Keep Business Role','Modify Business Role','Modify Technical Role','Reject Business Role'];
  var RITM_STATUSES = ['Open','Resolved','On Hold','Cancelled'];
  var allEntries = [], sortBy = 'timestamp', sortDir = -1;
  var selApprovers = new Set(), selActions = new Set();
  var el = function(id) { return document.getElementById(id); };

  // Init
  async function boot() {
    var res = await fetch('/api/me');
    var me = await res.json().catch(function() { return {}; });
    if (!res.ok || !me.isAdmin) { location.href = '/'; return; }
    // Load sidebar user info
    var initials = (me.approverName || me.email || 'U').split(' ').map(function(n){return n[0];}).join('').substring(0,2).toUpperCase();
    var av = el('sidebarAvatar'), nm = el('sidebarName'), rl = el('sidebarRole');
    if (av) av.textContent = initials;
    if (nm) nm.textContent = me.approverName || me.email || 'User';
    if (rl) rl.textContent = me.isAdmin ? 'Administrator' : 'Approver';
    if (me.tenants && me.tenants.length > 1) {
      var sel = el('tenantSelector');
      if (sel) { sel.innerHTML = ''; me.tenants.forEach(function(t) { var o = document.createElement('option'); o.value = t.id; o.textContent = t.name; if (t.id === me.tenantId) o.selected = true; sel.appendChild(o); }); }
    }
    await loadData();
    setupFilters();
  }

  async function loadData() {
    var res = await fetch('/api/log'); if (!res.ok) { location.href = '/'; return; }
    allEntries = await res.json(); populateFilterMenus(); render();
  }

  // Filters
  function setupFilters() {
    ['filterRole','filterFrom','filterTo'].forEach(function(id) { el(id).addEventListener('input', render); el(id).addEventListener('change', render); });
    el('exportXlsxBtn').addEventListener('click', exportXlsx);
    el('exportCsvBtn').addEventListener('click', exportCsv);
    el('exportPdfBtn').addEventListener('click', function() { exportPdf().catch(function() { alert('PDF export failed'); }); });
    var evBtn = el('evidenceExportBtn');
    if (evBtn) evBtn.addEventListener('click', function() { location.href = '/evidence.html'; });
    document.querySelectorAll('#logTable thead th[data-sort]').forEach(function(th) {
      th.addEventListener('click', function() {
        var key = th.dataset.sort;
        if (sortBy === key) sortDir = -sortDir; else { sortBy = key; sortDir = 1; }
        document.querySelectorAll('#logTable thead th').forEach(function(t) { t.classList.remove('sorted-asc','sorted-desc'); });
        th.classList.add(sortDir === 1 ? 'sorted-asc' : 'sorted-desc');
        render();
      });
    });
    el('filterApproverBtn').addEventListener('click', function() { toggleMenu('filterApproverBtn','filterApproverMenu'); });
    el('filterActionBtn').addEventListener('click', function() { toggleMenu('filterActionBtn','filterActionMenu'); });
    document.addEventListener('click', function(e) {
      if (!e.target.closest('.multi-filter')) {
        document.querySelectorAll('.multi-filter-menu').forEach(function(m) { m.classList.add('hidden'); });
      }
    });
  }

  function populateFilterMenus() {
    var names = Array.from(new Set(allEntries.map(function(e) { return e.approver; }))).sort();
    buildMultiFilter({ menu: el('filterApproverMenu'), btn: el('filterApproverBtn'), values: names, selected: selApprovers, allLabel: 'All', plural: 'approvers' });
    var actionNames = Array.from(new Set(allEntries.map(function(e) { return e.action || ''; }).filter(Boolean))).sort();
    var actions = ACTION_ORDER.concat(actionNames.filter(function(a) { return !ACTION_ORDER.includes(a); })).concat(['__empty__']);
    buildMultiFilter({ menu: el('filterActionMenu'), btn: el('filterActionBtn'), values: actions, selected: selActions, allLabel: 'All', plural: 'actions' });
  }

  function buildMultiFilter(cfg) {
    cfg.menu.innerHTML = '';
    var controls = document.createElement('div');
    controls.style.cssText = 'display:flex;justify-content:flex-end;padding:4px;border-bottom:1px solid var(--border-light)';
    var clear = document.createElement('button');
    clear.textContent = 'Clear'; clear.style.cssText = 'background:transparent;border:none;color:var(--accent);cursor:pointer;font-size:11px;font-weight:600';
    clear.addEventListener('click', function() { cfg.selected.clear(); updateBtn(cfg); populateFilterMenus(); render(); });
    controls.appendChild(clear); cfg.menu.appendChild(controls);
    cfg.values.forEach(function(v) {
      var lbl = document.createElement('label');
      lbl.style.cssText = 'display:flex;align-items:center;gap:8px;padding:4px 8px;cursor:pointer;font-size:12px';
      var cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = cfg.selected.has(v);
      cb.addEventListener('change', function() { if (cb.checked) cfg.selected.add(v); else cfg.selected.delete(v); updateBtn(cfg); render(); });
      lbl.appendChild(cb);
      lbl.appendChild(document.createTextNode(v === '__empty__' ? '(no action)' : v));
      cfg.menu.appendChild(lbl);
    });
    updateBtn(cfg);
  }

  function updateBtn(cfg) {
    var c = cfg.selected.size;
    cfg.btn.textContent = c ? c + ' ' + cfg.plural : cfg.allLabel;
    cfg.btn.classList.toggle('has-selection', c > 0);
  }

  function toggleMenu(bid, mid) {
    var m = el(mid);
    var willOpen = m.classList.contains('hidden');
    document.querySelectorAll('.multi-filter-menu').forEach(function(x) { x.classList.add('hidden'); });
    m.classList.toggle('hidden', !willOpen);
  }

  function filteredSorted() {
    return allEntries.filter(function(e) {
      if (selApprovers.size && !selApprovers.has(e.approver)) return false;
      if (selActions.size) {
        var a = e.action || '';
        if (!selActions.has(a) && !(selActions.has('__empty__') && !a)) return false;
      }
      var role = el('filterRole').value.trim().toLowerCase();
      if (role && !(e.roleName || '').toLowerCase().includes(role)) return false;
      var from = el('filterFrom').value, to = el('filterTo').value;
      if (from && e.timestamp.slice(0,10) < from) return false;
      if (to && e.timestamp.slice(0,10) > to) return false;
      return true;
    }).sort(function(a, b) {
      var av = (a[sortBy] || '').toString(), bv = (b[sortBy] || '').toString();
      return av < bv ? -1 * sortDir : av > bv ? 1 * sortDir : 0;
    });
  }

  // Render
  function render() {
    var data = filteredSorted();
    var tbody = el('logTableBody'); tbody.innerHTML = '';
    data.forEach(function(e) {
      var tr = document.createElement('tr');
      tr.appendChild(td(fmtDate(e.timestamp)));
      tr.appendChild(td(e.approver));
      tr.appendChild(td(e.roleName));
      // Action as badge
      var tda = document.createElement('td');
      if (e.action) {
        var badge = document.createElement('span');
        badge.className = 'badge ' + actionBadgeClass(e.action);
        badge.textContent = e.action;
        tda.appendChild(badge);
      } else {
        tda.textContent = '—';
      }
      tr.appendChild(tda);
      tr.appendChild(ritmCell(e));
      tr.appendChild(ritmStatusCell(e));
      tr.appendChild(td(e.submissionId));
      tbody.appendChild(tr);
    });
    el('emptyMsg').hidden = data.length > 0;
    renderStats(data);
  }

  function actionBadgeClass(action) {
    var a = String(action || '').toLowerCase();
    if (a.includes('keep')) return 'badge-success';
    if (a.includes('modify') && a.includes('technical')) return 'badge-info';
    if (a.includes('modify')) return 'badge-purple';
    if (a.includes('reject')) return 'badge-danger';
    return 'badge-neutral';
  }

  function td(text) { var c = document.createElement('td'); c.textContent = text == null ? '' : String(text); return c; }
  function fmtDate(iso) { try { return new Date(iso).toLocaleString(); } catch(e) { return iso; } }
  function badgeClass(a) { return String(a || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }

  function ritmCell(entry) {
    var c = document.createElement('td');
    var wrap = document.createElement('div'); wrap.style.cssText = 'display:flex;gap:4px;align-items:center';
    var inp = document.createElement('input'); inp.type = 'text'; inp.value = entry.ritm || ''; inp.placeholder = 'RITM';
    inp.style.cssText = 'padding:4px 6px;border:1px solid var(--border);border-radius:3px;font-size:11px;width:90px';
    var btn = document.createElement('button'); btn.className = 'btn btn-xs btn-secondary'; btn.textContent = 'Save';
    var st = document.createElement('span'); st.className = 'save-status'; st.style.cssText = 'font-size:10px;margin-left:4px';
    btn.addEventListener('click', async function() {
      if (!entry.logEntryId) { st.textContent = 'Missing ID'; return; }
      btn.disabled = true; st.textContent = '';
      try {
        var res = await fetch('/api/log/' + encodeURIComponent(entry.logEntryId) + '/ritm', {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ritm: inp.value.trim() })
        });
        if (!res.ok) throw new Error('Failed');
        entry.ritm = inp.value.trim();
        if (entry.ritm && !entry.ritmStatus) entry.ritmStatus = 'Open';
        st.textContent = 'Saved'; render();
      } catch(ex) { st.textContent = 'Failed'; } finally { btn.disabled = false; }
    });
    wrap.appendChild(inp); wrap.appendChild(btn); c.appendChild(wrap); c.appendChild(st); return c;
  }

  function ritmStatusCell(entry) {
    var c = document.createElement('td');
    var wrap = document.createElement('div'); wrap.style.cssText = 'display:flex;gap:4px;align-items:center';
    var sel = document.createElement('select'); sel.style.cssText = 'padding:4px 6px;border:1px solid var(--border);border-radius:3px;font-size:11px';
    RITM_STATUSES.forEach(function(s) { sel.appendChild(new Option(s, s)); });
    sel.value = entry.ritmStatus || 'Open'; sel.disabled = !entry.ritm;
    var st = document.createElement('span'); st.className = 'save-status'; st.style.cssText = 'font-size:10px;margin-left:4px';
    sel.addEventListener('change', async function() {
      if (!entry.logEntryId) { st.textContent = 'Missing ID'; return; }
      sel.disabled = true; st.textContent = '';
      try {
        var res = await fetch('/api/log/' + encodeURIComponent(entry.logEntryId) + '/ritm-status', {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ritmStatus: sel.value })
        });
        if (!res.ok) throw new Error('Failed');
        entry.ritmStatus = sel.value || 'Open'; st.textContent = 'Saved'; render();
      } catch(ex) { st.textContent = 'Failed'; } finally { sel.disabled = false; }
    });
    wrap.appendChild(sel); c.appendChild(wrap); c.appendChild(st); return c;
  }

  function renderStats(data) {
    var subs = new Set(data.map(function(e) { return e.submissionId; })).size;
    var byAction = data.reduce(function(acc, e) { var k = e.action || '(none)'; acc[k] = (acc[k] || 0) + 1; return acc; }, {});
    var approvers = new Set(data.map(function(e) { return e.approver; })).size;
    var ritmCount = data.filter(function(e) { return e.ritm; }).length;
    var byStatus = data.reduce(function(acc, e) { if (!e.ritm) return acc; var s = e.ritmStatus || 'Open'; acc[s] = (acc[s] || 0) + 1; return acc; }, {});

    // KPI cards
    el('statSubmissions').textContent = subs.toLocaleString();
    el('statRoles').textContent = data.length.toLocaleString();
    el('statApprovers').textContent = approvers.toLocaleString();
    var ritmPct = data.length ? Math.round(ritmCount / data.length * 100) : 0;
    el('statRitm').textContent = ritmCount.toLocaleString();
    el('statRitmDetail').textContent = ritmCount ? ritmPct + '% of all reviews have RITM' : '';

    // Action breakdown
    el('abKeep').textContent = byAction['Keep Business Role'] || 0;
    el('abModTech').textContent = byAction['Modify Technical Role'] || 0;
    el('abModBiz').textContent = byAction['Modify Business Role'] || 0;
    el('abReject').textContent = byAction['Reject Business Role'] || 0;

    // Record count
    el('recordCount').textContent = data.length.toLocaleString() + ' records';
  }

  // XLSX Export (CSV format, .xlsx extension)
  function exportXlsx() {
    var data = filteredSorted();
    var cols = ['timestamp','approver','roleName','action','ritm','ritmStatus','submissionId'];
    var esc = function(v) { return '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"'; };
    var lines = [cols.join(',')];
    data.forEach(function(e) { lines.push(cols.map(function(c) { return esc(e[c] || ''); }).join(',')); });
    var blob = new Blob([lines.join('\n')], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a'); a.href = url; a.download = 'audit-trail-' + new Date().toISOString().slice(0,10) + '.csv'; a.click(); URL.revokeObjectURL(url);
  }

  // CSV Export
  function exportCsv() {
    var data = filteredSorted();
    var cols = ['timestamp','approver','roleName','action','ritm','ritmStatus','submissionId'];
    var esc = function(v) { return '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"'; };
    var lines = [cols.join(',')];
    data.forEach(function(e) { lines.push(cols.map(function(c) { return esc(e[c] || ''); }).join(',')); });
    var blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a'); a.href = url; a.download = 'audit-trail-' + new Date().toISOString().slice(0,10) + '.csv'; a.click(); URL.revokeObjectURL(url);
  }

  // PDF Export
  async function exportPdf() {
    if (typeof window.applyPlugin === 'function' && !window.jspdf.jsPDF.API.autoTable) window.applyPlugin(window.jspdf.jsPDF);
    var data = filteredSorted();
    var doc = new window.jspdf.jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });
    var navy = [8,145,178], pageW = doc.internal.pageSize.getWidth(), gen = new Date().toLocaleString();
    doc.setFillColor.apply(doc, navy); doc.rect(0, 0, pageW, 54, 'F');
    doc.setTextColor(255, 255, 255); doc.setFontSize(16); doc.setFont('helvetica', 'bold'); doc.text('Attest - Audit Trail', 40, 32);
    doc.setFontSize(9); doc.setFont('helvetica', 'normal'); doc.text('Generated: ' + gen, pageW - 200, 32);
    doc.autoTable({
      startY: 80,
      head: [['Timestamp','Approver','Submitted By','Mode','Role Name','Action','Details','RITM','Status','Submission ID']],
      body: data.map(function(e) { return [fmtDate(e.timestamp), e.approver||'', e.submittedByEmail||'-', e.impersonated?'Impersonated':'Direct', e.roleName||'', e.action||'-', e.actionDetails||e.comments||'', e.ritm||'', e.ritmStatus||'', e.submissionId||'']; }),
      styles: { fontSize: 6.5, cellPadding: 3 },
      headStyles: { fillColor: navy, textColor: 255 },
      margin: { left: 28, right: 28 }
    });
    doc.save('audit-log-' + new Date().toISOString().slice(0,10) + '.pdf');
  }

  boot();
})();

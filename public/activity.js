// Application activity log viewer (admin only).
(function () {
  let events = [];

  const body = document.getElementById('activityBody');
  const empty = document.getElementById('activityEmpty');
  const filterType = document.getElementById('filterType');
  const filterUser = document.getElementById('filterUser');
  const filterFrom = document.getElementById('filterFrom');
  const filterTo = document.getElementById('filterTo');
  const refreshBtn = document.getElementById('refreshBtn');
  const exportCsvBtn = document.getElementById('exportCsvBtn');

  const TYPE_LABELS = {
    AUTH: 'Auth / access',
    SUBMISSION: 'Submission',
    RITM: 'RITM',
  };

  async function verifyAdmin() {
    const res = await fetch('/api/me');
    const me = await res.json().catch(() => ({}));
    if (!res.ok || !me.isAdmin) {
      window.location.href = '/';
      return false;
    }
    return true;
  }

  async function loadActivity() {
    try {
      const res = await fetch('/api/activity');
      if (!res.ok) throw new Error('Could not load activity log.');
      events = await res.json();
      render();
    } catch (e) {
      events = [];
      render();
    }
  }

  function formatTimestamp(ts) {
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return String(ts || '');
    return d.toLocaleString();
  }

  function filtered() {
    const type = filterType.value;
    const user = filterUser.value.trim().toLowerCase();
    const from = filterFrom.value ? new Date(filterFrom.value + 'T00:00:00') : null;
    const to = filterTo.value ? new Date(filterTo.value + 'T23:59:59') : null;
    return events.filter(e => {
      if (type && e.type !== type) return false;
      if (user && !String(e.email || '').toLowerCase().includes(user)) return false;
      if (from || to) {
        const t = new Date(e.timestamp);
        if (from && t < from) return false;
        if (to && t > to) return false;
      }
      return true;
    });
  }

  function td(text) {
    const c = document.createElement('td');
    c.textContent = text == null ? '' : String(text);
    return c;
  }

  function render() {
    const rows = filtered();
    body.innerHTML = '';
    empty.hidden = rows.length > 0;
    const frag = document.createDocumentFragment();
    rows.forEach(e => {
      const tr = document.createElement('tr');
      tr.appendChild(td(formatTimestamp(e.timestamp)));
      tr.appendChild(td(TYPE_LABELS[e.type] || e.type));
      tr.appendChild(td(e.action));
      tr.appendChild(td(e.email || '—'));
      tr.appendChild(td(e.detail));
      frag.appendChild(tr);
    });
    body.appendChild(frag);
  }

  function exportCsv() {
    const rows = filtered();
    const headers = ['Timestamp', 'Type', 'Action', 'User', 'Detail'];
    const escape = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
    const lines = [headers.map(escape).join(',')];
    rows.forEach(e => {
      lines.push([
        e.timestamp,
        TYPE_LABELS[e.type] || e.type,
        e.action,
        e.email,
        e.detail,
      ].map(escape).join(','));
    });
    const blob = new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'activity-log-' + new Date().toISOString().slice(0, 10) + '.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  [filterType, filterUser, filterFrom, filterTo].forEach(el => {
    el.addEventListener('input', render);
    el.addEventListener('change', render);
  });
  refreshBtn.addEventListener('click', loadActivity);
  exportCsvBtn.addEventListener('click', exportCsv);

  // Load sidebar user info
  async function loadSidebarUser() {
    try {
      var res = await fetch('/api/me');
      var me = await res.json().catch(function() { return {}; });
      if (!res.ok) return;
      var initials = (me.approverName || me.email || 'U').split(' ').map(function(n){return n[0];}).join('').substring(0,2).toUpperCase();
      var av = document.getElementById('sidebarAvatar'), nm = document.getElementById('sidebarName'), rl = document.getElementById('sidebarRole');
      if (av) av.textContent = initials;
      if (nm) nm.textContent = me.approverName || me.email || 'User';
      if (rl) rl.textContent = me.isAdmin ? 'Administrator' : 'Approver';
      if (me.tenants && me.tenants.length > 1) {
        var sel = document.getElementById('tenantSelector');
        if (sel) {
          sel.innerHTML = '';
          me.tenants.forEach(function(t) {
            var o = document.createElement('option');
            o.value = t.id; o.textContent = t.name;
            if (t.id === me.tenantId) o.selected = true;
            sel.appendChild(o);
          });
        }
      }
    } catch(e) {}
  }
  loadSidebarUser();

  async function boot() {
    const ok = await verifyAdmin();
    if (!ok) return;
    await loadActivity();
  }

  boot();
})();

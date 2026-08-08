// Application activity log viewer (admin only).
(function () {
  let events = [];
  let pageSize = 50, offset = 0, hasMore = true;

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
    const me = await Attest.getCurrentUser();
    if (!(me.capabilities || []).includes('activity:read')) {
      window.location.href = '/';
      return false;
    }
    return true;
  }

  async function loadActivity(reset) {
    try {
      if (reset) { offset = 0; events = []; hasMore = true; }
      const res = await Attest.api.fetch('/api/activity?limit=' + pageSize + '&offset=' + offset);
      const batch = await res.json();
      if (batch.length < pageSize) hasMore = false;
      events = events.concat(batch);
      offset += batch.length;
      render();
      const btn = document.getElementById('activityLoadMore');
      const bar = document.getElementById('activityPagination');
      const info = document.getElementById('activityPageInfo');
      if (bar) bar.style.display = hasMore ? '' : 'none';
      if (btn) { btn.disabled = !hasMore; btn.textContent = hasMore ? 'Load More' : 'All loaded'; }
      if (info) info.textContent = 'Showing ' + events.length + ' events';
    } catch (e) { events = []; render(); }
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
    const emptyState = document.getElementById('activityEmptyState');
    if (emptyState) emptyState.style.display = rows.length === 0 && events.length === 0 ? '' : 'none';
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

  async function boot() {
    const ok = await verifyAdmin();
    if (!ok) return;
    await loadActivity(true);
    const loadMore = document.getElementById('activityLoadMore');
    if (loadMore) loadMore.addEventListener('click', function() { loadActivity(false); });
  }

  boot().catch(function(err){Attest.showLoadError(body.parentElement||document.body,err.message||'Could not load activity.',function(){boot();});});
})();

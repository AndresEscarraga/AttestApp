// Attest — Role Review frontend (aligned with mockup-futuro.html)
(function () {
  'use strict';

  // Auth handled by shared.js — no need to duplicate fetch override here

  const ACTIONS = ['Keep Business Role','Modify Business Role','Modify Technical Role','Reject Business Role'];
  const KEEP = ACTIONS[0], REJECT = ACTIONS[3];

  const state = { email:'', approver:'', approverRoles:[], rowSeq:0, isAdmin:false, impersonated:false, submitting:false };

  const getEl = id => document.getElementById(id);

  // Init
  async function loadCurrentUser() {
    try {
      const res = await fetch('/api/me');
      const me = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(me.error || 'Could not verify your access.');
      state.email = me.email || '';
      state.isAdmin = !!me.isAdmin;
      const params = new URLSearchParams(location.search);
      const imp = params.get('impersonate');
      if (imp) {
        if (!state.isAdmin) throw new Error('Only admins can impersonate.');
        await loadApproverProfile(imp, true);
      } else if (me.approverName) {
        state.approver = me.approverName;
        state.approverRoles = Array.isArray(me.roles) ? me.roles : [];
        state.impersonated = false;
      } else if (state.isAdmin) {
        state.approver = 'Admin'; state.approverRoles = []; state.impersonated = false;
      }
      updateSidebar();
      init();
    } catch (e) {
      console.error('Access denied:', e.message || 'Unauthorized');
    }
  }

  async function loadApproverProfile(name, imp) {
    const res = await fetch('/api/roles/by-approver', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({approver:name}) });
    const roles = await res.json().catch(() => []);
    if (!res.ok) throw new Error(roles.error || 'Could not load roles.');
    state.approver = name; state.approverRoles = Array.isArray(roles) ? roles : []; state.impersonated = !!imp;
    // Load SoD conflicts for this approver
    loadSodConflicts(name);
  }

  var conflictedRoles = {}; // roleName -> true if conflicted
  async function loadSodConflicts(approverName) {
    try {
      var res = await fetch('/api/sod/conflicts?approver_name=' + encodeURIComponent(approverName) + '&status=open');
      var conflicts = await res.json();
      conflictedRoles = {};
      conflicts.forEach(function(c) {
        conflictedRoles[c.role_a] = true;
        conflictedRoles[c.role_b] = true;
      });
      // Re-render rows if already loaded
      var rows = document.querySelectorAll('#reviewTableBody tr');
      rows.forEach(function(tr) {
        var roleName = tr.dataset.roleName;
        if (conflictedRoles[roleName]) {
          tr.style.background = '#FEF2F2';
          var statusCell = tr.querySelector('td:nth-child(4)');
          if (statusCell) statusCell.innerHTML = '<span class="badge badge-danger">Flagged — SoD</span>';
          var sel = tr.querySelector('select');
          if (sel) { sel.value = 'Reject Business Role'; sel.style.background = '#FEF2F2'; sel.style.borderColor = '#FECACA'; }
        }
      });
    } catch(e) {}
  }

  function updateSidebar() {
    const initials = (state.approver || 'U').split(' ').map(function(n){return n[0]}).join('').substring(0,2).toUpperCase();
    const av = document.getElementById('sidebarAvatar');
    const nm = document.getElementById('sidebarName');
    const rl = document.getElementById('sidebarRole');
    if (av) av.textContent = initials;
    if (nm) nm.textContent = state.approver || 'User';
    if (rl) rl.textContent = state.isAdmin ? 'Administrator' : 'Approver';
  }

  // Dark mode handled by shared.js — no need to duplicate here

  loadCurrentUser();

  // Review Table
  function init() {
    var printBtn = getEl('printBtn');
    var newReviewBtn = getEl('newReviewBtn');
    var addRowBtn = getEl('addRowBtn');

    // If admin has no approver roles, show impersonation panel
    if (state.isAdmin && !state.impersonated && !state.approverRoles.length) {
      showAdminImpersonationPanel();
      updateStats();
      return;
    }

    state.approverRoles.forEach(function(r){addRow(r)});
    if (printBtn) printBtn.addEventListener('click', onPrintAndSubmit);
    if (newReviewBtn) newReviewBtn.addEventListener('click', function(){location.reload()});
    if (addRowBtn) addRowBtn.addEventListener('click', function(){addRow('')});
    updateStats();
  }

  function showAdminImpersonationPanel() {
    // Fetch available approvers for impersonation
    fetch('/api/approvers').then(function(r){return r.json();}).then(function(approvers){
      var tbody = document.getElementById('reviewTableBody');
      if (!tbody) return;

      var approverList = (approvers || []).slice(0, 8);
      if (!approverList.length) {
        tbody.innerHTML = '<tr><td colspan="6"><div style="text-align:center;padding:40px"><p style="font-weight:600;margin-bottom:8px">No approvers found</p><p class="text-sm text-muted">Upload role data to populate approver profiles.</p></div></td></tr>';
        return;
      }

      var html = '<tr><td colspan="6" style="padding:24px 20px">' +
        '<div style="text-align:center;margin-bottom:16px">' +
          '<div style="font-size:32px;margin-bottom:8px">👤</div>' +
          '<h3 style="margin-bottom:4px">You are logged in as Administrator</h3>' +
          '<p class="text-sm text-muted">Select an approver below to review and certify their assigned roles.</p>' +
        '</div>' +
        '<div style="display:grid;grid-template-columns:repeat(auto-fill, minmax(200px, 1fr));gap:10px">';

      approverList.forEach(function(name){
        html += '<button class="btn btn-secondary" style="text-align:left;padding:14px 16px" ' +
          'onclick="location.href=\'?impersonate=' + encodeURIComponent(name) + '\'">' +
          '<span style="font-weight:600;display:block">' + name + '</span>' +
          '<span class="text-sm text-muted">Click to review roles →</span>' +
        '</button>';
      });

      html += '</div></td></tr>';
      tbody.innerHTML = html;

      // Update header
      var h1 = document.querySelector('.content-header h1');
      if (h1) h1.textContent = 'My Role Reviews';
      var sub = document.querySelector('.content-header p');
      if (sub) sub.textContent = 'Impersonate an approver to certify their business roles.';
    }).catch(function(){
      var tbody = document.getElementById('reviewTableBody');
      if (tbody) tbody.innerHTML = '<tr><td colspan="6"><div style="text-align:center;padding:40px;color:var(--text-tertiary)">Could not load approvers.</div></td></tr>';
    });
  }

  function addRow(roleName) {
    state.rowSeq++;
    const tr = document.createElement('tr');
    tr.dataset.rowId = String(state.rowSeq);
    tr.dataset.roleName = roleName;
    tr.dataset.txAcknowledged = 'false';
    tr.dataset.rejected = 'false';
    tr.dataset.confirmedAction = '';

    // Extract system from role name: "BE - SYSTEM - ..."
    var roleParts = roleName.split(' - ');
    var system = roleParts.length >= 2 ? roleParts[1] : '—';

    // Business Role
    const tdRole = document.createElement('td');
    const roleSpan = document.createElement('span'); roleSpan.className = 'role-name-cell';
    roleSpan.innerHTML = '<strong>' + escHtml(roleName) + '</strong>';
    tdRole.appendChild(roleSpan); tr.appendChild(tdRole);

    // System
    const tdSys = document.createElement('td');
    tdSys.textContent = system; tdSys.style.fontSize = '12px';
    tr.appendChild(tdSys);

    // Technical Roles (loaded async)
    const tdTech = document.createElement('td');
    tdTech.className = 'text-sm text-muted';
    tdTech.textContent = 'Loading...';
    tdTech.style.fontSize = '11px';
    tr.appendChild(tdTech);

    // Load technical roles from transactions
    fetch('/api/transactions?role=' + encodeURIComponent(roleName)).then(function(r){return r.json();}).then(function(data){
      var techRoles = [];
      if (data.rows && data.rows.length) {
        // Get unique technical roles from column index 1 or 2
        var techCol = data.header.indexOf('Technical Role');
        if (techCol < 0) techCol = 2;
        var seen = {};
        data.rows.forEach(function(row){
          var trName = String(row[techCol] || '').trim();
          if (trName && !seen[trName]) { seen[trName] = true; techRoles.push(trName); }
        });
      }
      tdTech.textContent = techRoles.length ? techRoles.slice(0,3).join(', ') + (techRoles.length > 3 ? ' (+' + (techRoles.length-3) + ')' : '') : '—';
      if (techRoles.length >= 3) tdTech.title = techRoles.join(', ');
      // Update View Permissions button with T-code count
      txBtn.textContent = techRoles.length ? 'View ' + techRoles.length + ' T-codes →' : 'View Permissions →';
    }).catch(function(){ tdTech.textContent = '—'; });

    // Status
    const tdStatus = document.createElement('td');
    tdStatus.innerHTML = '<span class="badge badge-warning">Pending</span>';
    tr.appendChild(tdStatus);

    // Action dropdown
    const tdAct = document.createElement('td');
    const sel = document.createElement('select');
    sel.style.cssText = 'font-size:11px;padding:4px 8px;border:1px solid #E2E8F0;border-radius:4px;font-family:inherit';
    sel.appendChild(opt('', 'Select action...'));
    ACTIONS.forEach(function(a){sel.appendChild(opt(a,a))});
    sel.addEventListener('change', function(){onActionChange(tr, sel.value, tdStatus)});
    tdAct.appendChild(sel); tr.appendChild(tdAct);

    // View Permissions
    const tdTx = document.createElement('td');
    const txBtn = document.createElement('button');
    txBtn.className = 'btn btn-ghost btn-xs'; txBtn.textContent = 'View Permissions →';
    txBtn.addEventListener('click', function(){openTxModal(roleName, txBtn)});
    tdTx.appendChild(txBtn); tr.appendChild(tdTx);

    getEl('reviewTableBody').appendChild(tr);

    // SoD flagging
    if (conflictedRoles[roleName]) {
      tr.style.background = '#FEF2F2';
      tdStatus.innerHTML = '<span class="badge badge-danger">Flagged — SoD</span>';
      sel.value = 'Reject Business Role';
      sel.style.background = '#FEF2F2'; sel.style.borderColor = '#FECACA';
      tr.dataset.rejected = 'true';
    }

    updateStats();
    return tr;
  }

  function opt(value, text) { const o = document.createElement('option'); o.value = value; o.textContent = text; return o; }

  function onActionChange(tr, action, tdStatus) {
    var isReject = action === REJECT;
    tr.dataset.rejected = String(isReject);
    tr.classList.toggle('rejected-row', isReject);
    if (action === KEEP) {
      tr.dataset.confirmedAction = KEEP;
      if (tdStatus) tdStatus.innerHTML = '<span class="badge badge-success">Keep</span>';
    } else if (action) {
      tr.dataset.confirmedAction = '';
      if (tdStatus) tdStatus.innerHTML = '<span class="badge badge-info">' + escHtml(action) + '</span>';
    } else {
      tr.dataset.confirmedAction = '';
      if (tdStatus) tdStatus.innerHTML = '<span class="badge badge-warning">Pending</span>';
    }
    updateStats();
  }

  // Permissions Modal
  function openTxModal(roleName, btn) {
    if (!roleName) return;
    const ex = document.getElementById('txModal'); if (ex) ex.remove();
    const backdrop = document.createElement('div'); backdrop.id = 'txModal'; backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = '<div class=modal-wide style="background:var(--bg-surface);border-radius:12px;box-shadow:var(--shadow-md);width:900px;max-width:94vw;max-height:85vh;overflow-y:auto;margin:auto">' +
      '<div style="padding:18px 22px 0;display:flex;justify-content:space-between;align-items:center"><h3>Permissions — ' + escHtml(roleName) + '</h3><button class=modal-close>&times;</button></div>' +
      '<div style="padding:18px 22px"><p style="font-size:12px;color:var(--text-secondary);margin-bottom:12px"><strong>Reviewer notice.</strong> Please read every permission carefully before continuing.</p>' +
      '<div class=table-scroll style=max-height:50vh><table class=data-table id=txTable><thead></thead><tbody></tbody></table></div>' +
      '<div style="margin-top:14px;padding:12px;border-top:2px solid var(--accent);background:var(--bg-root);border-radius:0 0 8px 8px">' +
      '<label style="display:flex;align-items:flex-start;gap:8px;font-size:12px;cursor:pointer"><input type=checkbox id=txAck> <span>I have read and understood the complete list of permissions.</span></label>' +
      '<div style="display:flex;justify-content:flex-end;gap:8px;margin-top:10px"><button class="btn btn-secondary" id=txCancelAck>Cancel</button><button class="btn btn-primary" id=txConfirmAck disabled>Confirm</button></div>' +
      '</div></div></div>';
    document.body.appendChild(backdrop);

    backdrop.querySelector('.modal-close').addEventListener('click',function(){backdrop.remove()});
    backdrop.querySelector('#txCancelAck').addEventListener('click',function(){backdrop.remove()});
    const ackCb = backdrop.querySelector('#txAck'), cf = backdrop.querySelector('#txConfirmAck');
    ackCb.addEventListener('change',function(){cf.disabled=!ackCb.checked});
    cf.addEventListener('click',function(){
      btn.classList.add('acknowledged'); btn.textContent='Permissions \u2713';
      btn.closest('tr').dataset.txAcknowledged='true'; backdrop.remove(); updateStats();
    });

    fetch('/api/transactions?role='+encodeURIComponent(roleName)).then(function(r){return r.json()}).then(function(data){
      const th = backdrop.querySelector('#txTable thead'), tb = backdrop.querySelector('#txTable tbody');
      if (data.header && data.header.length) {
        const trh = document.createElement('tr');
        data.header.forEach(function(h){const thh=document.createElement('th');thh.textContent=h;trh.appendChild(thh)});
        th.appendChild(trh);
      }
      (data.rows||[]).forEach(function(row){
        const trr = document.createElement('tr');
        row.forEach(function(c){const td=document.createElement('td');td.textContent=c;trr.appendChild(td)});
        tb.appendChild(trr);
      });
      if (!data.rows||!data.rows.length) tb.innerHTML='<tr><td colspan=10 style="text-align:center;padding:20px;color:var(--text-tertiary)">No permission details available.</td></tr>';
    });
  }

  // Action Details Modal
  function openActionModal(tr, currentValue) {
    const ex = document.getElementById('actionModal'); if (ex) ex.remove();
    const role = tr.dataset.roleName || '';
    const backdrop = document.createElement('div'); backdrop.id = 'actionModal'; backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = '<div class=modal>' +
      '<div class=modal-header><h3>Action Details — ' + escHtml(role) + '</h3><button class=modal-close>&times;</button></div>' +
      '<div class=modal-body><p style="font-size:12px;color:var(--text-secondary);margin-bottom:8px">Enter the details required.</p>' +
      '<textarea id=actionDetailsInput rows=4 style="width:100%;padding:8px 12px;border:1px solid var(--border);border-radius:6px;font:inherit;font-size:13px;resize:vertical">' + escHtml(currentValue) + '</textarea>' +
      '<div class=modal-error id=actionModalError></div></div>' +
      '<div class=modal-footer><button class="btn btn-secondary" id=actionCancel>Cancel</button><button class="btn btn-primary" id=actionConfirm>Save</button></div></div>';
    document.body.appendChild(backdrop);

    backdrop.querySelector('.modal-close').addEventListener('click',function(){backdrop.remove()});
    backdrop.querySelector('#actionCancel').addEventListener('click',function(){backdrop.remove()});
    backdrop.querySelector('#actionConfirm').addEventListener('click',function(){
      const val = backdrop.querySelector('#actionDetailsInput').value.trim();
      if (!val) { backdrop.querySelector('#actionModalError').textContent='Details are required.'; return; }
      const detInput = tr.querySelector('textarea'); detInput.value = val; detInput.readOnly = true;
      tr.dataset.confirmedAction = tr.querySelector('select').value; backdrop.remove(); updateStats();
    });
  }

  // Submit
  async function onPrintAndSubmit() {
    const rows = Array.from(document.querySelectorAll('#reviewTableBody tr')).map(function(tr){return {
      roleName: tr.dataset.roleName||'', action: tr.querySelector('select')?.value||'',
      actionDetails: tr.querySelector('textarea')?.value||'',
      txAcknowledged: tr.dataset.txAcknowledged==='true', confirmedAction: tr.dataset.confirmedAction||''
    }});
    const unack = rows.filter(function(r){return r.roleName&&!r.txAcknowledged});
    if (unack.length) { submitWarning.textContent=unack.length+' role(s) need permission acknowledgement.'; return; }
    const noAct = rows.filter(function(r){return r.roleName&&!r.confirmedAction});
    if (noAct.length) { submitWarning.textContent=noAct.length+' role(s) need an action selected.'; return; }
    state.submitting=true; submitWarning.textContent='';
    try {
      const res = await fetch('/api/log',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({approver:state.approver,rows:rows.filter(function(r){return r.roleName})})});
      const result = await res.json().catch(function(){return{}});
      if (!res.ok) throw new Error(result.error||'Submission failed');
      const modal = completionModal; completionDetail.textContent='Submission ID: '+(result.submissionId||'N/A'); modal.classList.remove('hidden');
    } catch(e) { submitWarning.textContent='Error: '+e.message; } finally { state.submitting=false; }
  }

  // Stats
  function updateStats() {
    var rows = Array.from(document.querySelectorAll('#reviewTableBody tr'));
    var total = rows.length;
    var ack = rows.filter(function(r){return r.dataset.txAcknowledged==='true';}).length;
    var acted = rows.filter(function(r){return r.dataset.confirmedAction;}).length;
    var rej = rows.filter(function(r){return r.dataset.rejected==='true';}).length;
    var pending = total - acted;

    var sa = document.getElementById('statAssigned'), sr = document.getElementById('statReviewed');
    var sp = document.getElementById('statPending'), sj = document.getElementById('statRejected');
    if (sa) sa.textContent = total;
    if (sr) sr.textContent = acted;
    if (sp) sp.textContent = pending;
    if (sj) sj.textContent = rej;

    // Update sidebar badge
    var badge = document.getElementById('reviewBadge');
    if (badge && pending > 0) { badge.textContent = pending; badge.style.display = ''; }
    else if (badge) { badge.style.display = 'none'; }

    // Update submit warning
    var warn = document.getElementById('submitWarning');
    if (warn) warn.textContent = ack === total ? 'All permissions acknowledged. Ready to submit.' : (total - ack) + ' of ' + total + ' roles need permission review.';
  }

  function escHtml(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}

  // Tenant selector
  fetch('/api/me').then(function(r){return r.json();}).then(function(me){
    var sel = document.getElementById('tenantSelector');
    if (sel && me.tenants && me.tenants.length > 1) {
      sel.innerHTML = '';
      me.tenants.forEach(function(t){
        var o = document.createElement('option'); o.value = t.id;
        o.textContent = t.name; if (t.id === me.tenantId) o.selected = true;
        sel.appendChild(o);
      });
    }
  }).catch(function(){});
})();

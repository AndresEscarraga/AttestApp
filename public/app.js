// Attest — Role Review frontend (aligned with mockup-futuro.html)
(function () {
  'use strict';

  // Inject JWT token from localStorage into all fetch requests
  var token = localStorage.getItem('attest_token');
  var origFetch = window.fetch;
  window.fetch = function(url, opts) {
    opts = opts || {};
    opts.headers = opts.headers || {};
    if (token && !opts.headers['Authorization']) {
      opts.headers['Authorization'] = 'Bearer ' + token;
    }
    return origFetch(url, opts);
  };

  const ACTIONS = ['Keep Business Role','Modify Business Role','Modify Technical Role','Reject Business Role'];
  const KEEP = ACTIONS[0], REJECT = ACTIONS[3];

  const state = { email:'', approver:'', approverRoles:[], rowSeq:0, isAdmin:false, impersonated:false, submitting:false };

  const $" = id => document.getElementById(id);

  // Init
  async function loadCurrentUser() {
    try {
      const res = await fetch('/api/me');
      const me = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(me.error || 'Could not verify your access.');
      state.email = me.email || '';
      state.isAdmin = !!me.isAdmin;
      const adminLink = adminLink;
      if (adminLink) adminLink.style.display = state.isAdmin ? '' : 'none';
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
      signedInName.textContent = 'Access denied: ' + (e.message || 'Unauthorized');
    }
  }

  async function loadApproverProfile(name, imp) {
    const res = await fetch('/api/roles/by-approver', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({approver:name}) });
    const roles = await res.json().catch(() => []);
    if (!res.ok) throw new Error(roles.error || 'Could not load roles.');
    state.approver = name; state.approverRoles = Array.isArray(roles) ? roles : []; state.impersonated = !!imp;
  }

  function updateSidebar() {
    const initials = (state.approver || 'U').split(' ').map(function(n){return n[0]}).join('').substring(0,2).toUpperCase();
    const av = sidebarAvatar, nm = sidebarName, rl = sidebarRole;
    if (av) av.textContent = initials;
    if (nm) nm.textContent = state.approver || 'User';
    if (rl) rl.textContent = state.isAdmin ? 'Administrator' : 'Approver';
    const label = state.impersonated ? state.approver + ' (impersonated)' : state.approver + (state.email ? ' (' + state.email + ')' : '');
    signedInName.textContent = 'Signed in as: ' + label;
  }

  // Dark mode
  const dt = darkToggle;
  if (dt) dt.addEventListener('click', function() {
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    document.documentElement.setAttribute('data-theme', isDark ? 'light' : 'dark');
    dt.textContent = isDark ? '\u{1F319} Dark Mode' : '\u{2600}\u{FE0F} Light Mode';
  });

  loadCurrentUser();

  // Review Table
  function init() {
    state.approverRoles.forEach(function(r){addRow(r)});
    printBtn.addEventListener('click', onPrintAndSubmit);
    newReviewBtn.addEventListener('click', function(){location.reload()});
    addRowBtn.addEventListener('click', function(){addRow('')});
    updateStats();
  }

  function addRow(roleName) {
    state.rowSeq++;
    const tr = document.createElement('tr');
    tr.dataset.rowId = String(state.rowSeq);
    tr.dataset.roleName = roleName;
    tr.dataset.txAcknowledged = 'false';
    tr.dataset.rejected = 'false';
    tr.dataset.confirmedAction = '';

    const tdNum = document.createElement('td'); tdNum.textContent = state.rowSeq; tr.appendChild(tdNum);

    const tdRole = document.createElement('td');
    const roleSpan = document.createElement('span'); roleSpan.className = 'role-name-cell'; roleSpan.textContent = roleName;
    tdRole.appendChild(roleSpan); tr.appendChild(tdRole);

    const tdApp = document.createElement('td');
    const appSpan = document.createElement('span'); appSpan.className = 'approver-cell'; appSpan.textContent = state.approver;
    tdApp.appendChild(appSpan); tr.appendChild(tdApp);

    const tdAct = document.createElement('td');
    const sel = document.createElement('select');
    sel.style.cssText = 'font-size:11px;padding:4px 6px;border:1px solid #CBD5E1;border-radius:4px;font-family:inherit;min-width:160px';
    sel.appendChild(opt('', 'Select action...'));
    ACTIONS.forEach(function(a){sel.appendChild(opt(a,a))});
    sel.addEventListener('change', function(){onActionChange(tr, sel.value)});
    tdAct.appendChild(sel); tr.appendChild(tdAct);

    const tdDet = document.createElement('td');
    const detInput = document.createElement('textarea');
    detInput.rows = 2;
    detInput.style.cssText = 'width:100%;font:inherit;padding:4px 6px;border:1px solid #CBD5E1;border-radius:3px;resize:vertical;min-height:28px;min-width:280px';
    detInput.placeholder = 'Details for Modify/Reject';
    detInput.readOnly = true;
    tdDet.appendChild(detInput); tr.appendChild(tdDet);

    const tdTx = document.createElement('td');
    const txBtn = document.createElement('button');
    txBtn.className = 'btn-tx'; txBtn.textContent = 'View Permissions';
    txBtn.addEventListener('click', function(){openTxModal(roleName, txBtn)});
    tdTx.appendChild(txBtn); tr.appendChild(tdTx);

    reviewTableBody.appendChild(tr);
    updateStats();
    return tr;
  }

  function opt(value, text) { const o = document.createElement('option'); o.value = value; o.textContent = text; return o; }

  function onActionChange(tr, action) {
    const detInput = tr.querySelector('textarea');
    const isReject = action === REJECT;
    tr.dataset.rejected = String(isReject);
    tr.classList.toggle('rejected-row', isReject);
    if (action === KEEP) {
      detInput.readOnly = true; detInput.value = ''; tr.dataset.confirmedAction = KEEP;
    } else if (action) {
      detInput.readOnly = false; tr.dataset.confirmedAction = '';
      if (!detInput.value) openActionModal(tr, '');
    } else {
      detInput.readOnly = true; detInput.value = ''; tr.dataset.confirmedAction = '';
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
    const rows = Array.from(document.querySelectorAll('#reviewTableBody tr'));
    const total=rows.length, ack=rows.filter(function(r){return r.dataset.txAcknowledged==='true'}).length;
    const acted=rows.filter(function(r){return r.dataset.confirmedAction}).length;
    const rej=rows.filter(function(r){return r.dataset.rejected==='true'}).length;
    reviewStats.innerHTML =
      '<div class=stat-card><div class=stat-label>Total Roles</div><div class=stat-value>'+total+'</div></div>'+
      '<div class=stat-card><div class=stat-label>Acknowledged</div><div class=stat-value>'+ack+'</div><div class="stat-change '+(ack===total?'up':'')+'">'+(ack===total?'All done':(total-ack)+' pending')+'</div></div>'+
      '<div class=stat-card><div class=stat-label>Actions Ready</div><div class=stat-value>'+acted+'</div><div class=stat-change>'+(total-acted)+' remaining</div></div>'+
      '<div class=stat-card><div class=stat-label>Rejected</div><div class=stat-value style=color:'+(rej>0?'var(--danger)':'inherit')+'>'+rej+'</div></div>';
  }

  function escHtml(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
})();

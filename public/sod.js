(function(){
  'use strict';
  var el=function(id){return document.getElementById(id);};
  var state={conflicts:[],rules:[],stats:{},canManage:false,user:null,selectedConflict:null};
  var statusLabels={open:'Open',mitigated:'Mitigated',risk_accepted:'Risk accepted',false_positive:'False positive'};

  function esc(value){return Attest.escHtml(String(value==null?'':value));}
  function fmtDate(value){if(!value)return '—';try{return new Date(value).toLocaleString();}catch(err){return value;}}
  function severityBadge(value){return value==='critical'?'badge-danger':value==='high'?'badge-warning':value==='medium'?'badge-info':'badge-neutral';}
  function statusBadge(value){return value==='open'?'badge-danger':value==='risk_accepted'?'badge-purple':value==='mitigated'?'badge-success':'badge-neutral';}
  function compactSnapshot(value){value=String(value||'');return value.length>22?value.slice(0,19)+'…':value;}
  function toLocalInput(value){
    var date=value?new Date(value):new Date(Date.now()+90*24*60*60*1000);
    if(Number.isNaN(date.getTime()))date=new Date(Date.now()+90*24*60*60*1000);
    var local=new Date(date.getTime()-date.getTimezoneOffset()*60000);
    return local.toISOString().slice(0,16);
  }

  async function loadData(){
    var container=document.querySelector('.content');
    try{
      var results=await Promise.all([
        Attest.api.json('/api/sod/conflicts'),
        Attest.api.json('/api/sod/rules'),
        Attest.api.json('/api/sod/stats')
      ]);
      state.conflicts=results[0];state.rules=results[1];state.stats=results[2];
      Attest.clearLoadError(container);render();
    }catch(err){
      Attest.showLoadError(container,err.message||'Could not load segregation-of-duties data.',loadData);
    }
  }

  function render(){
    el('sodOpen').textContent=state.stats.open||0;
    el('sodCritical').textContent=state.stats.criticalOpen||0;
    el('sodMitigated').textContent=state.stats.mitigated||0;
    el('sodAccepted').textContent=state.stats.riskAccepted||0;
    renderConflicts();renderRules();
    var badge=el('sodBadge');
    if(badge){badge.textContent=state.stats.open||0;badge.style.display=state.stats.open?'':'none';}
  }

  function renderConflicts(){
    var body=el('conflictsBody');
    el('conflictsCount').textContent=state.conflicts.length+' finding'+(state.conflicts.length===1?'':'s');
    if(!state.conflicts.length){body.innerHTML='<tr><td colspan="8" class="text-sm text-muted" style="text-align:center;padding:32px">No effective-access conflicts found.</td></tr>';return;}
    body.innerHTML=state.conflicts.map(function(conflict){
      var rule=state.rules.find(function(item){return item.id===conflict.rule_id;});
      var resolution=conflict.status==='open'?'':('<span class="sod-resolution-meta">Owner: '+esc(conflict.resolution_owner||'—')+'</span>'+(conflict.resolution_expires_at?'<span class="sod-resolution-meta">Review: '+esc(fmtDate(conflict.resolution_expires_at))+'</span>':''));
      var owner=conflict.approver_name?'<span class="sod-resolution-meta">Review owner: '+esc(conflict.approver_name)+'</span>':'';
      var search=[conflict.subject_name,conflict.user_email,conflict.role_a,conflict.role_b,rule&&rule.name,conflict.application_a,conflict.application_b].join(' ').toLowerCase();
      return '<tr data-search="'+esc(search)+'">'+
        '<td><span class="badge '+severityBadge(conflict.severity)+'">'+esc(conflict.severity)+'</span></td>'+
        '<td class="sod-subject"><strong>'+esc(conflict.subject_name||'Unknown subject')+'</strong><span>'+esc(conflict.user_email)+'</span></td>'+
        '<td class="sod-access"><div class="sod-access-line"><span class="sod-access-key">A</span><span>'+esc(conflict.role_a)+'</span></div><div class="sod-access-line"><span class="sod-access-key">B</span><span>'+esc(conflict.role_b)+'</span></div></td>'+
        '<td class="sod-access"><div>'+esc(conflict.application_a||'Unknown app')+'<small>'+esc(conflict.account_a||'')+'</small></div><div style="margin-top:6px">'+esc(conflict.application_b||'Unknown app')+'<small>'+esc(conflict.account_b||'')+'</small></div></td>'+
        '<td><strong>'+esc(rule?rule.name:'Archived rule')+'</strong>'+owner+'</td>'+
        '<td><div class="sod-snapshot" title="'+esc(conflict.source_snapshot_id)+'">'+esc(compactSnapshot(conflict.source_snapshot_id))+'</div><span class="sod-resolution-meta">Detected '+esc(fmtDate(conflict.detected_at))+'</span></td>'+
        '<td><span class="badge '+statusBadge(conflict.status)+'">'+esc(statusLabels[conflict.status]||conflict.status)+'</span>'+resolution+'</td>'+
        '<td>'+(state.canManage?'<button class="btn btn-sm btn-secondary resolve-btn" data-id="'+esc(conflict.id)+'">'+(conflict.status==='open'?'Resolve':'Review')+'</button>':'')+'</td></tr>';
    }).join('');
    body.querySelectorAll('.resolve-btn').forEach(function(button){button.addEventListener('click',function(){openResolution(button.dataset.id);});});
  }

  function renderRules(){
    var body=el('rulesBody');
    el('rulesCount').textContent=state.rules.length+' active rule'+(state.rules.length===1?'':'s');
    if(!state.rules.length){body.innerHTML='<tr><td colspan="6" class="text-sm text-muted" style="text-align:center;padding:24px">No active incompatibility rules.</td></tr>';return;}
    body.innerHTML=state.rules.map(function(rule){return '<tr><td><strong>'+esc(rule.name)+'</strong><span class="sod-resolution-meta">'+esc(rule.description||'No rationale documented')+'</span></td><td>'+esc(rule.role_a)+'</td><td>'+esc(rule.role_b)+'</td><td><span class="badge '+severityBadge(rule.severity)+'">'+esc(rule.severity)+'</span></td><td>'+esc(rule.framework)+'</td><td>'+(state.canManage?'<button class="btn btn-xs btn-ghost archive-rule" data-id="'+esc(rule.id)+'">Archive</button>':'')+'</td></tr>';}).join('');
    body.querySelectorAll('.archive-rule').forEach(function(button){button.addEventListener('click',function(){archiveRule(button.dataset.id);});});
  }

  async function runDetection(){
    var button=el('detectBtn');Attest.btnLoading(button,true,'Evaluating assignments…');
    try{
      var result=await Attest.api.json('/api/sod/detect',{method:'POST'});
      Attest.showToast(result.detected?result.detected+' conflict(s) created or reopened.':'No new conflicts; '+result.evaluated+' effective assignment pair(s) evaluated.','success');
      await loadData();
    }catch(err){Attest.showToast(err.message||'SoD detection failed.','error');}
    finally{Attest.btnLoading(button,false);}
  }

  async function openRuleModal(){
    el('ruleModalError').textContent='';el('ruleName').value='';el('ruleRoleA').value='';el('ruleRoleB').value='';el('ruleDescription').value='';
    el('ruleModal').classList.remove('hidden');
    try{
      var roles=await Attest.api.json('/api/roles');
      el('rolesList').innerHTML=roles.map(function(role){return '<option value="'+esc(role)+'"></option>';}).join('');
    }catch(err){el('ruleModalError').textContent=err.message||'Could not load entitlements.';}
  }

  function closeRuleModal(){el('ruleModal').classList.add('hidden');}
  async function saveRule(){
    var button=el('ruleModalSave');el('ruleModalError').textContent='';
    var payload={name:el('ruleName').value.trim(),role_a:el('ruleRoleA').value.trim(),role_b:el('ruleRoleB').value.trim(),severity:el('ruleSeverity').value,framework:el('ruleFramework').value,description:el('ruleDescription').value.trim()};
    if(!payload.name||!payload.role_a||!payload.role_b){el('ruleModalError').textContent='Name and both entitlements are required.';return;}
    Attest.btnLoading(button,true,'Creating…');
    try{await Attest.api.fetch('/api/sod/rules',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});closeRuleModal();await loadData();}
    catch(err){el('ruleModalError').textContent=err.message||'Could not create rule.';}
    finally{Attest.btnLoading(button,false);}
  }

  async function archiveRule(id){
    if(!await Attest.confirm('Archive this rule? Existing findings and resolution history will be preserved.','Archive'))return;
    try{await Attest.api.fetch('/api/sod/rules/'+encodeURIComponent(id),{method:'DELETE'});await loadData();}
    catch(err){Attest.showToast(err.message||'Could not archive rule.','error');}
  }

  function resolutionOptions(conflict){
    return conflict.status==='open'
      ? [['mitigated','Mitigated by compensating control'],['risk_accepted','Accept risk (admin approval)'],['false_positive','False positive']]
      : [['open','Reopen finding']];
  }

  async function openResolution(id){
    var conflict=state.conflicts.find(function(item){return item.id===id;});if(!conflict)return;
    state.selectedConflict=conflict;
    el('resolutionError').textContent='';el('resolutionTitle').textContent=conflict.status==='open'?'Resolve effective-access conflict':'Review current resolution';
    el('resolutionSubject').textContent=(conflict.subject_name||conflict.user_email)+' · '+conflict.role_a+' + '+conflict.role_b;
    el('resolutionStatus').innerHTML=resolutionOptions(conflict).map(function(option){return '<option value="'+option[0]+'">'+option[1]+'</option>';}).join('');
    el('resolutionOwner').value=conflict.resolution_owner||state.user.email||'';
    el('resolutionReason').value='';
    el('resolutionExpiry').value=toLocalInput(conflict.resolution_expires_at);
    el('resolutionEvidence').value=conflict.resolution_evidence||'';
    el('resolutionModal').classList.remove('hidden');updateResolutionFields();
    el('resolutionHistory').textContent='Loading…';
    try{
      var history=await Attest.api.json('/api/sod/conflicts/'+encodeURIComponent(id)+'/history');
      el('resolutionHistory').innerHTML=history.length?history.map(function(event){return '<div class="sod-history-item"><strong>'+esc(statusLabels[event.from_status]||event.from_status)+' → '+esc(statusLabels[event.to_status]||event.to_status)+'</strong> · '+esc(fmtDate(event.created_at))+'<div>'+esc(event.reason)+'</div><span class="text-muted">Owner: '+esc(event.owner)+' · Actor: '+esc(event.actor)+'</span></div>';}).join(''):'No prior resolution events.';
    }catch(err){el('resolutionHistory').textContent=err.message||'Could not load history.';}
  }

  function closeResolution(){el('resolutionModal').classList.add('hidden');state.selectedConflict=null;}
  function updateResolutionFields(){
    var status=el('resolutionStatus').value;
    var requiresEvidence=status==='mitigated'||status==='risk_accepted';
    el('resolutionExpiryField').classList.toggle('hidden',!requiresEvidence);
    el('resolutionEvidenceField').classList.toggle('hidden',!requiresEvidence);
    el('resolutionGuidance').textContent=status==='risk_accepted'?'Risk acceptance records the current tenant administrator as approver and automatically reopens after expiry.':status==='mitigated'?'Document a compensating control, its evidence, owner and next review date.':status==='false_positive'?'Explain why the evaluated assignment pair does not represent an actual conflict.':'Reopening returns the finding to the active review queue; document why the previous disposition no longer applies.';
  }

  async function saveResolution(){
    var conflict=state.selectedConflict;if(!conflict)return;
    var status=el('resolutionStatus').value,button=el('resolutionModalSave');
    var payload={status:status,resolution_reason:el('resolutionReason').value.trim(),resolution_owner:el('resolutionOwner').value.trim(),resolution_expires_at:'',resolution_evidence:''};
    if(status==='mitigated'||status==='risk_accepted'){
      var localExpiry=el('resolutionExpiry').value;
      payload.resolution_expires_at=localExpiry?new Date(localExpiry).toISOString():'';
      payload.resolution_evidence=el('resolutionEvidence').value.trim();
    }
    if(!payload.resolution_reason||!payload.resolution_owner){el('resolutionError').textContent='Reason and resolution owner are required.';return;}
    Attest.btnLoading(button,true,'Saving…');
    try{await Attest.api.fetch('/api/sod/conflicts/'+encodeURIComponent(conflict.id),{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});closeResolution();await loadData();}
    catch(err){el('resolutionError').textContent=err.message||'Could not save the decision.';}
    finally{Attest.btnLoading(button,false);}
  }

  function wire(){
    el('detectBtn').addEventListener('click',runDetection);el('newRuleBtn').addEventListener('click',openRuleModal);
    el('ruleModalClose').addEventListener('click',closeRuleModal);el('ruleModalCancel').addEventListener('click',closeRuleModal);el('ruleModalSave').addEventListener('click',saveRule);
    el('resolutionModalClose').addEventListener('click',closeResolution);el('resolutionModalCancel').addEventListener('click',closeResolution);el('resolutionModalSave').addEventListener('click',saveResolution);el('resolutionStatus').addEventListener('change',updateResolutionFields);
    document.addEventListener('keydown',function(event){if(event.key==='Escape'){closeRuleModal();closeResolution();}});
    document.addEventListener('attest:search',function(event){var query=String(event.detail.query||'').toLowerCase();document.querySelectorAll('#conflictsBody tr[data-search]').forEach(function(row){row.classList.toggle('search-hidden',query&&!row.dataset.search.includes(query));});});
  }

  async function boot(){
    wire();state.user=await Attest.getCurrentUser();state.canManage=Attest.hasCapability('sod:manage');
    el('detectBtn').classList.toggle('hidden',!state.canManage);el('newRuleBtn').classList.toggle('hidden',!state.canManage);
    await loadData();
  }
  boot().catch(function(err){Attest.showLoadError(document.querySelector('.content'),err.message||'Could not initialize segregation of duties.',boot);});
})();

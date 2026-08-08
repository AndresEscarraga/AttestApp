// Admin user management.
(function () {
  let admins = [];
  let members = [];
  let protectedAdmins = [];

  const body = document.getElementById('adminUsersBody');
  const empty = document.getElementById('adminUsersEmpty');
  const error = document.getElementById('adminUserError');
  const form = document.getElementById('adminUserForm');
  const input = document.getElementById('adminEmailInput');
  const roleInput = document.getElementById('memberRoleInput');

  async function verifyAdmin() {
    const me = await Attest.getCurrentUser();
    if (!(me.capabilities || []).includes('members:manage')) {
      window.location.href = '/';
      return false;
    }
    return true;
  }

  async function loadAdmins() {
    error.textContent = ''; error.style.display = 'none';
    try {
      const res = await Attest.api.fetch('/api/admin-users');
      const data = await res.json();
      admins = data.admins || [];
      members = data.members || admins.map(email => ({ email, role:'admin', protected:false }));
      protectedAdmins = data.protectedAdmins || [];
      render();
    } catch (e) {
      error.textContent = e.message || 'Could not load admin users.';
    }
  }

  function render() {
    body.innerHTML = '';
    empty.hidden = members.length > 0;
    const frag = document.createDocumentFragment();
    members.forEach(member => {
      const email = member.email;
      const tr = document.createElement('tr');
      const isProtected = protectedAdmins.includes(email);
      tr.appendChild(td(email));
      var typeCell = document.createElement('td');
      var labels = {admin:'Administrator',approver:'Approver',auditor:'Auditor'};
      if(isProtected){typeCell.innerHTML='<span class="badge badge-info">Technical Support</span>';}
      else{
        var roleSelect=document.createElement('select');roleSelect.className='form-select';roleSelect.style.maxWidth='160px';
        ['admin','approver','auditor'].forEach(function(role){roleSelect.appendChild(new Option(labels[role],role));});
        roleSelect.value=member.role;roleSelect.addEventListener('change',function(){updateRole(email,roleSelect.value,roleSelect);});
        typeCell.appendChild(roleSelect);
      }
      tr.appendChild(typeCell);
      const action = document.createElement('td');
      const btn = document.createElement('button');
      btn.className = 'btn-secondary';
      btn.textContent = isProtected ? 'Protected' : 'Remove';
      btn.disabled = isProtected;
      btn.addEventListener('click', () => removeAdmin(email));
      action.appendChild(btn);
      tr.appendChild(action);
      frag.appendChild(tr);
    });
    body.appendChild(frag);
  }

  function td(text) {
    const c = document.createElement('td');
    c.textContent = text == null ? '' : String(text);
    return c;
  }

  async function addAdmin(email, role) {
    error.textContent = '';
    const res = await Attest.api.fetch('/api/admin-users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, role: role || 'admin' }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Could not add admin user.');
    input.value = '';
    await loadAdmins();
  }

  async function removeAdmin(email) {
    error.textContent = '';
    const res = await Attest.api.fetch('/api/admin-users/' + encodeURIComponent(email), {
      method: 'DELETE',
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      error.textContent = data.error || 'Could not remove admin user.';
      return;
    }
    await loadAdmins();
  }

  async function updateRole(email, role, select) {
    select.disabled=true;error.textContent='';
    try{
      await Attest.api.fetch('/api/admin-users/' + encodeURIComponent(email), {
        method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({role})
      });
      await loadAdmins();
    }catch(e){error.textContent=e.message||'Could not update membership role.';error.style.display='block';await loadAdmins();}
    finally{select.disabled=false;}
  }

  form.addEventListener('submit', async event => {
    event.preventDefault();
    try {
      await addAdmin(input.value, roleInput ? roleInput.value : 'admin');
    } catch (e) {
      error.textContent = e.message || 'Could not add admin user.';
      error.style.display = 'block';
    }
  });

  async function boot() {
    const ok = await verifyAdmin();
    if (!ok) return;
    await loadAdmins();
  }

  boot().catch(function(err){Attest.showLoadError(body.parentElement||document.body,err.message||'Could not load users.',function(){boot();});});
})();

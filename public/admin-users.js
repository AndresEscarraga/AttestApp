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
    const res = await fetch('/api/me');
    const me = await res.json().catch(() => ({}));
    if (!res.ok || !me.isAdmin) {
      window.location.href = '/';
      return false;
    }
    return true;
  }

  async function loadAdmins() {
    error.textContent = ''; error.style.display = 'none';
    try {
      const res = await fetch('/api/admin-users');
      if (!res.ok) throw new Error('Could not load admin users.');
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
      var badges = {admin:'badge-purple',approver:'badge-info',auditor:'badge-teal'};
      typeCell.innerHTML = isProtected ? '<span class="badge badge-info">Technical Support</span>' : '<span class="badge '+(badges[member.role]||'badge-neutral')+'">'+(labels[member.role]||member.role)+'</span>';
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
    const res = await fetch('/api/admin-users', {
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
    const res = await fetch('/api/admin-users/' + encodeURIComponent(email), {
      method: 'DELETE',
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      error.textContent = data.error || 'Could not remove admin user.';
      return;
    }
    await loadAdmins();
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
      // Populate tenant selector if multi-tenant
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
    await loadAdmins();
  }

  boot();
})();

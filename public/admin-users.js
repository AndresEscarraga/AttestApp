// Admin user management.
(function () {
  let admins = [];
  let protectedAdmins = [];

  const body = document.getElementById('adminUsersBody');
  const empty = document.getElementById('adminUsersEmpty');
  const error = document.getElementById('adminUserError');
  const form = document.getElementById('adminUserForm');
  const input = document.getElementById('adminEmailInput');

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
    error.textContent = '';
    try {
      const res = await fetch('/api/admin-users');
      if (!res.ok) throw new Error('Could not load admin users.');
      const data = await res.json();
      admins = data.admins || [];
      protectedAdmins = data.protectedAdmins || [];
      render();
    } catch (e) {
      error.textContent = e.message || 'Could not load admin users.';
    }
  }

  function render() {
    body.innerHTML = '';
    empty.hidden = admins.length > 0;
    const frag = document.createDocumentFragment();
    admins.forEach(email => {
      const tr = document.createElement('tr');
      const isProtected = protectedAdmins.includes(email);
      tr.appendChild(td(email));
      tr.appendChild(td(isProtected ? 'Technical Support' : 'Admin'));
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

  async function addAdmin(email) {
    error.textContent = '';
    const res = await fetch('/api/admin-users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
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
      await addAdmin(input.value);
    } catch (e) {
      error.textContent = e.message || 'Could not add admin user.';
    }
  });

  async function boot() {
    const ok = await verifyAdmin();
    if (!ok) return;
    await loadAdmins();
  }

  boot();
})();

// routes/auth.js — Authentication, user info, tenant switching
module.exports = function register(deps) {
  const { app, adminUserStore, tenantStore, approverEmailToName, approverNameToEmail, generateToken, normalizeEmail } = deps;

  // POST /api/auth — unified login + signup
  app.post('/api/auth', async (req, res) => {
    try {
      const { action, email, password, name } = req.body || {};
      const normalizedEmail = normalizeEmail(email);
      if (!normalizedEmail || !password) {
        return res.status(400).json({ error: 'Email and password are required.' });
      }

      if (action === 'signup') {
        const admins = await adminUserStore.listAdmins('default');
        if (admins.length > 0) {
          return res.status(403).json({ error: 'Registration is closed. Contact your administrator for an account.' });
        }
        if (!name || name.trim().length < 2) {
          return res.status(400).json({ error: 'Name is required (min 2 characters).' });
        }
        await adminUserStore.addAdmin(normalizedEmail, 'default');
        await adminUserStore.setPassword(normalizedEmail, password);
        const token = generateToken({ email: normalizedEmail, name: name.trim(), tenant_id: 'default' });
        const tenants = await tenantStore.listAll();
        return res.json({ token, email: normalizedEmail, isAdmin: true, approverName: name.trim(), tenantId: 'default', tenants, message: 'Account created.' });
      }

      // Login
      const tenantId = String(req.body.tenant_id || '').trim() || 'default';
      const admins = await adminUserStore.listAdmins(tenantId);
      if (!admins.includes(normalizedEmail)) {
        return res.status(401).json({ error: 'Invalid credentials. If this is your first time, sign up to create an admin account.' });
      }
      const valid = await adminUserStore.verifyPassword(normalizedEmail, password);
      if (!valid) {
        return res.status(401).json({ error: 'Invalid credentials.' });
      }
      const isAdmin = admins.includes(normalizedEmail);
      const approverName = approverEmailToName[normalizedEmail] || '';
      const token = generateToken({ email: normalizedEmail, tenant_id: tenantId });
      const tenants = await tenantStore.listAll();
      res.json({ token, email: normalizedEmail, isAdmin, approverName, tenantId, tenants });
    } catch (err) {
      console.error('POST /api/auth failed:', err);
      res.status(500).json({ error: 'Authentication failed.' });
    }
  });

  // GET /api/me
  app.get('/api/me', async (req, res) => {
    const tenants = await tenantStore.listAll();
    const currentTenant = await tenantStore.getById(req.tenantId || 'default');
    const userRole = req.auth.isAdmin ? (await adminUserStore.getUserRole(req.auth.email) || 'admin') : 'approver';
    res.json({
      email: req.auth.email,
      approverName: req.auth.approverName,
      approverEmail: req.auth.approverName ? approverNameToEmail[req.auth.approverName] || '' : '',
      roles: req.auth.roles,
      isAdmin: req.auth.isAdmin,
      role: userRole,
      tenantId: req.tenantId || 'default',
      tenant: currentTenant || { id: 'default', name: 'Default Organization' },
      tenants,
    });
  });

  // POST /api/auth/switch-tenant
  app.post('/api/auth/switch-tenant', async (req, res) => {
    try {
      const { tenant_id } = req.body || {};
      if (!tenant_id) return res.status(400).json({ error: 'tenant_id is required.' });
      const tenant = await tenantStore.getById(tenant_id);
      if (!tenant || tenant.status !== 'active') {
        return res.status(400).json({ error: 'Invalid or inactive tenant.' });
      }
      const token = generateToken({ email: req.auth.email, tenant_id });
      res.json({ token, tenantId: tenant_id, tenant });
    } catch (err) {
      console.error('POST /api/auth/switch-tenant failed:', err);
      res.status(500).json({ error: 'Failed to switch tenant.' });
    }
  });
};

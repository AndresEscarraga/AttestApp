// Authentication, current principal and membership-validated tenant switching.
module.exports = function register(deps) {
  const {
    app,
    adminUserStore,
    tenantStore,
    roleCatalogStore,
    generateToken,
    normalizeEmail,
  } = deps;
  const { capabilitiesForRole } = require('../security/capabilities');
  const BOOTSTRAP_TENANT_ID = process.env.BOOTSTRAP_TENANT_ID || 'default';

  // POST /api/auth — unified login + signup
  app.post('/api/auth', async (req, res) => {
    try {
      const { action, email, password, name } = req.body || {};
      const normalizedEmail = normalizeEmail(email);
      if (!normalizedEmail || !password) {
        return res.status(400).json({ error: 'Email and password are required.' });
      }

      if (action === 'signup') {
        const admins = await adminUserStore.listAdmins(BOOTSTRAP_TENANT_ID);
        if (admins.length > 0) {
          return res.status(403).json({ error: 'Registration is closed. Contact your administrator for an account.' });
        }
        if (!name || name.trim().length < 2) {
          return res.status(400).json({ error: 'Name is required (min 2 characters).' });
        }
        await adminUserStore.addMembership(normalizedEmail, BOOTSTRAP_TENANT_ID, 'admin', {
          displayName: name.trim(),
        });
        await adminUserStore.setPassword(normalizedEmail, password);
      } else {
        const valid = await adminUserStore.verifyPassword(normalizedEmail, password);
        if (!valid) return res.status(401).json({ error: 'Invalid credentials.' });
      }

      const memberships = await adminUserStore.listMemberships(normalizedEmail);
      if (!memberships.length) {
        return res.status(403).json({ error: 'This account has no active tenant membership.' });
      }
      const requestedTenantId = String(req.body.tenant_id || '').trim();
      const membership = requestedTenantId
        ? memberships.find(item => item.tenant_id === requestedTenantId)
        : memberships.find(item => item.tenant_id === BOOTSTRAP_TENANT_ID) || memberships[0];
      if (!membership) {
        return res.status(403).json({ error: 'You do not have an active membership in the requested tenant.' });
      }
      const tenantId = membership.tenant_id;
      const catalogApprover = roleCatalogStore.getApproverByEmail(tenantId, normalizedEmail);
      const approverName = membership.approver_name || (catalogApprover && catalogApprover.name) || '';
      const token = generateToken({ email: normalizedEmail, tenant_id: tenantId });
      const tenants = await tenantStore.listForUser(normalizedEmail);

      return res.json({
        token,
        email: normalizedEmail,
        isAdmin: membership.role === 'admin',
        role: membership.role,
        capabilities: capabilitiesForRole(membership.role),
        approverName,
        tenantId,
        tenants,
        message: action === 'signup' ? 'Account created.' : undefined,
      });
    } catch (err) {
      console.error('POST /api/auth failed:', err);
      res.status(500).json({ error: 'Authentication failed.' });
    }
  });

  // GET /api/me
  app.get('/api/me', async (req, res) => {
    try {
      const context = req.context;
      const tenants = await tenantStore.listForUser(context.email);
      const currentTenant = tenants.find(tenant => tenant.id === context.tenantId);
      if (!currentTenant) {
        return res.status(403).json({ error: 'Active tenant membership not found.' });
      }
      const approver = context.approverName
        ? roleCatalogStore.getApproverByEmail(context.tenantId, context.email)
        : null;
      res.json({
        email: context.email,
        approverName: context.approverName,
        approverEmail: approver ? approver.email : '',
        roles: context.roles,
        isAdmin: context.isAdmin,
        role: context.role,
        capabilities: context.capabilities,
        tenantId: context.tenantId,
        tenant: currentTenant,
        tenants,
      });
    } catch (err) {
      console.error('GET /api/me failed:', err);
      res.status(500).json({ error: 'Failed to load the current user.' });
    }
  });

  // POST /api/auth/switch-tenant
  app.post('/api/auth/switch-tenant', async (req, res) => {
    try {
      const tenantId = String((req.body && req.body.tenant_id) || '').trim();
      if (!tenantId) return res.status(400).json({ error: 'tenant_id is required.' });
      if (req.context.principal.type !== 'user') return res.status(403).json({ error: 'Only users can switch tenant.' });
      const membership = await adminUserStore.getMembership(req.context.email, tenantId);
      const tenant = await tenantStore.getById(tenantId);
      if (!membership || membership.status !== 'active' || !tenant || tenant.status !== 'active') {
        return res.status(403).json({ error: 'You do not have an active membership in that tenant.' });
      }
      const token = generateToken({ email: req.context.email, tenant_id: tenantId });
      res.json({ token, tenantId, tenant, role: membership.role, capabilities: capabilitiesForRole(membership.role) });
    } catch (err) {
      console.error('POST /api/auth/switch-tenant failed:', err);
      res.status(500).json({ error: 'Failed to switch tenant.' });
    }
  });
};

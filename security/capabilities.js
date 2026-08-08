// Central authorization policy for tenant memberships and API-key principals.

const CAPABILITIES = Object.freeze({
  DASHBOARD_READ: 'dashboard:read',
  REVIEW_READ: 'review:read',
  REVIEW_SUBMIT: 'review:submit',
  AUDIT_READ: 'audit:read',
  AUDIT_UPDATE: 'audit:update',
  CAMPAIGN_READ: 'campaign:read',
  CAMPAIGN_MANAGE: 'campaign:manage',
  SOD_READ: 'sod:read',
  SOD_MANAGE: 'sod:manage',
  EVIDENCE_READ: 'evidence:read',
  EVIDENCE_DOWNLOAD: 'evidence:download',
  EVIDENCE_MANAGE: 'evidence:manage',
  NOTIFICATION_READ: 'notification:read',
  NOTIFICATION_UPDATE: 'notification:update',
  MEMBERS_MANAGE: 'members:manage',
  DATA_SOURCE_MANAGE: 'data-source:manage',
  API_KEY_MANAGE: 'api-key:manage',
  SETTINGS_READ: 'settings:read',
  SETTINGS_MANAGE: 'settings:manage',
  TENANT_READ: 'tenant:read',
  TENANT_CREATE: 'tenant:create',
  TENANT_MANAGE: 'tenant:manage',
  ACTIVITY_READ: 'activity:read',
});

const ALL = Object.freeze(Object.values(CAPABILITIES));

const ROLE_CAPABILITIES = Object.freeze({
  admin: ALL,
  approver: Object.freeze([
    CAPABILITIES.DASHBOARD_READ,
    CAPABILITIES.REVIEW_READ,
    CAPABILITIES.REVIEW_SUBMIT,
    CAPABILITIES.CAMPAIGN_READ,
    CAPABILITIES.SOD_READ,
    CAPABILITIES.EVIDENCE_READ,
    CAPABILITIES.EVIDENCE_DOWNLOAD,
    CAPABILITIES.NOTIFICATION_READ,
    CAPABILITIES.NOTIFICATION_UPDATE,
    CAPABILITIES.SETTINGS_READ,
    CAPABILITIES.TENANT_READ,
  ]),
  auditor: Object.freeze([
    CAPABILITIES.DASHBOARD_READ,
    CAPABILITIES.REVIEW_READ,
    CAPABILITIES.AUDIT_READ,
    CAPABILITIES.CAMPAIGN_READ,
    CAPABILITIES.SOD_READ,
    CAPABILITIES.EVIDENCE_READ,
    CAPABILITIES.EVIDENCE_DOWNLOAD,
    CAPABILITIES.NOTIFICATION_READ,
    CAPABILITIES.NOTIFICATION_UPDATE,
    CAPABILITIES.SETTINGS_READ,
    CAPABILITIES.TENANT_READ,
  ]),
});

const API_KEY_CAPABILITIES = Object.freeze({
  'health-check': Object.freeze([]),
  'read-only': Object.freeze([
    CAPABILITIES.DASHBOARD_READ,
    CAPABILITIES.REVIEW_READ,
    CAPABILITIES.AUDIT_READ,
    CAPABILITIES.CAMPAIGN_READ,
    CAPABILITIES.SOD_READ,
    CAPABILITIES.EVIDENCE_READ,
    CAPABILITIES.EVIDENCE_DOWNLOAD,
    CAPABILITIES.SETTINGS_READ,
    CAPABILITIES.TENANT_READ,
  ]),
  'read-write': Object.freeze([
    CAPABILITIES.DASHBOARD_READ,
    CAPABILITIES.REVIEW_READ,
    CAPABILITIES.AUDIT_READ,
    CAPABILITIES.AUDIT_UPDATE,
    CAPABILITIES.CAMPAIGN_READ,
    CAPABILITIES.SOD_READ,
    CAPABILITIES.EVIDENCE_READ,
    CAPABILITIES.EVIDENCE_DOWNLOAD,
    CAPABILITIES.SETTINGS_READ,
    CAPABILITIES.TENANT_READ,
  ]),
});

function capabilitiesForRole(role) {
  return ROLE_CAPABILITIES[role] || Object.freeze([]);
}

function capabilitiesForApiKey(permission) {
  return API_KEY_CAPABILITIES[permission] || Object.freeze([]);
}

function hasCapability(context, capability) {
  return !!context && Array.isArray(context.capabilities) && context.capabilities.includes(capability);
}

function requireCapability(capability) {
  return function capabilityMiddleware(req, res, next) {
    if (hasCapability(req.context, capability)) return next();
    const requestId = req.requestId || '';
    return res.status(403).json({
      error: 'You do not have permission to perform this action.',
      code: 'CAPABILITY_REQUIRED',
      capability,
      requestId,
    });
  };
}

module.exports = {
  CAPABILITIES,
  capabilitiesForRole,
  capabilitiesForApiKey,
  hasCapability,
  requireCapability,
};

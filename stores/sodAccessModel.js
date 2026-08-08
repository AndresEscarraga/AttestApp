// Effective-access model used by the SoD engine. Review ownership stays separate
// from the synthetic subject/account/entitlement assignments being evaluated.

const crypto = require('crypto');

function stableId(prefix, ...parts) {
  return `${prefix}${crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 20)}`;
}

function roleSystem(db, tenantId, roleName) {
  const row = db.prepare(`
    SELECT system_name FROM tenant_role_assignments
    WHERE tenant_id = ? AND role_name = ?
  `).get(tenantId, roleName);
  if (row && String(row.system_name || '').trim()) return String(row.system_name).trim();
  const parts = String(roleName || '').split(' - ').map(value => value.trim()).filter(Boolean);
  return parts.length > 1 ? parts.slice(0, 2).join(' / ') : 'Imported Access Catalog';
}

function ensureEntitlement(db, tenantId, roleName) {
  const applicationName = roleSystem(db, tenantId, roleName);
  const applicationId = stableId('app_', tenantId, applicationName);
  const entitlementId = stableId('ent_', tenantId, applicationName, roleName);
  const now = new Date().toISOString();
  db.prepare(`
    INSERT OR IGNORE INTO access_applications
      (id, tenant_id, external_key, name, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'active', ?, ?)
  `).run(applicationId, tenantId, applicationName, applicationName, now, now);
  db.prepare(`
    INSERT OR IGNORE INTO access_entitlements
      (id, tenant_id, application_id, external_key, name, description, entitlement_type, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'business_role', 'active', ?, ?)
  `).run(entitlementId, tenantId, applicationId, roleName, roleName, 'Synthetic effective-access entitlement', now, now);
  return { applicationId, applicationName, entitlementId };
}

function ensureAssignment(db, conflict, subjectId, roleName, side, snapshotId) {
  const tenantId = conflict.tenant_id;
  const catalog = ensureEntitlement(db, tenantId, roleName);
  const accountId = stableId('acct_', tenantId, subjectId, catalog.applicationId);
  const accountName = `${String(conflict.user_email || subjectId).split('@')[0]}@${catalog.applicationName}`;
  const assignmentId = stableId('asg_', tenantId, subjectId, catalog.entitlementId, snapshotId);
  const now = new Date().toISOString();
  db.prepare(`
    INSERT OR IGNORE INTO access_accounts
      (id, tenant_id, subject_id, application_id, account_name, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
  `).run(accountId, tenantId, subjectId, catalog.applicationId, accountName, now, now);
  db.prepare(`
    INSERT OR IGNORE INTO access_entitlement_assignments
      (id, tenant_id, subject_id, account_id, entitlement_id, status, valid_from, valid_to,
       source_snapshot_id, review_owner_name, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'active', ?, '', ?, ?, ?, ?)
  `).run(assignmentId, tenantId, subjectId, accountId, catalog.entitlementId,
    conflict.detected_at || now, snapshotId, conflict.approver_name || '', now, now);
  return { assignmentId, accountId, ...catalog, side };
}

function ensureSyntheticAccessForConflict(db, conflict) {
  const tenantId = String(conflict.tenant_id || '').trim();
  if (!tenantId || !conflict.id) return null;
  const subjectId = conflict.subject_id || stableId('sub_', tenantId, conflict.id);
  const generatedEmail = `sod-subject-${stableId('', tenantId, conflict.id).slice(0, 10)}@synthetic.attest.local`;
  const email = String(conflict.user_email || generatedEmail).trim().toLowerCase();
  const subjectName = String(conflict.subject_name || '').trim() || `Synthetic Access Subject ${conflict.id}`;
  const snapshotId = String(conflict.source_snapshot_id || '').trim() || `synthetic-seed:${tenantId}:v1`;
  const now = new Date().toISOString();
  const isResolved = conflict.status && conflict.status !== 'open';
  const legacyExpiry = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();
  const resolutionReason = String(conflict.resolution_reason || conflict.mitigation_notes || '').trim();
  const resolutionOwner = String(conflict.resolution_owner || conflict.mitigated_by || '').trim();
  const resolutionExpiry = String(conflict.resolution_expires_at || '').trim()
    || (isResolved && conflict.status !== 'false_positive' ? legacyExpiry : '');
  const resolutionEvidence = String(conflict.resolution_evidence || '').trim()
    || (isResolved ? `synthetic-seed://${tenantId}/${conflict.id}` : '');
  db.prepare(`
    INSERT OR IGNORE INTO access_subjects
      (id, tenant_id, external_key, email, display_name, status, source_snapshot_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)
  `).run(subjectId, tenantId, email, email, subjectName, snapshotId, now, now);
  const assignmentA = ensureAssignment(db, { ...conflict, user_email: email }, subjectId, conflict.role_a, 'a', snapshotId);
  const assignmentB = ensureAssignment(db, { ...conflict, user_email: email }, subjectId, conflict.role_b, 'b', snapshotId);
  db.prepare(`
    UPDATE sod_conflicts
    SET user_email = ?, subject_id = ?, subject_name = ?, assignment_a_id = ?, assignment_b_id = ?,
        source_snapshot_id = ?, resolution_reason = ?, resolution_owner = ?,
        resolution_expires_at = ?, resolution_evidence = ?,
        updated_at = COALESCE(NULLIF(updated_at, ''), detected_at)
    WHERE id = ? AND tenant_id = ?
  `).run(email, subjectId, subjectName, assignmentA.assignmentId, assignmentB.assignmentId,
    snapshotId, resolutionReason, resolutionOwner, resolutionExpiry, resolutionEvidence,
    conflict.id, tenantId);
  if (isResolved && resolutionReason && resolutionOwner) {
    const eventId = stableId('sod_evt_', tenantId, conflict.id, 'legacy-seed-resolution');
    db.prepare(`
      INSERT OR IGNORE INTO sod_resolution_events
        (id, tenant_id, conflict_id, from_status, to_status, reason, owner,
         expires_at, evidence_ref, actor, approved_by, approved_at, created_at)
      VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(eventId, tenantId, conflict.id, conflict.status, resolutionReason, resolutionOwner,
      resolutionExpiry, resolutionEvidence, conflict.mitigated_by || 'synthetic-seed',
      conflict.status === 'risk_accepted' ? conflict.mitigated_by || 'synthetic-seed' : '',
      conflict.status === 'risk_accepted' ? conflict.mitigated_at || conflict.detected_at : '',
      conflict.mitigated_at || conflict.detected_at || now);
  }
  return { subjectId, email, subjectName, snapshotId, assignmentA, assignmentB };
}

function backfillLegacySodConflicts(db) {
  const rows = db.prepare(`
    SELECT * FROM sod_conflicts
    WHERE COALESCE(subject_id, '') = '' OR COALESCE(assignment_a_id, '') = ''
       OR COALESCE(assignment_b_id, '') = ''
  `).all();
  const run = db.transaction(conflicts => {
    conflicts.forEach(conflict => ensureSyntheticAccessForConflict(db, conflict));
  });
  run(rows);
  return rows.length;
}

module.exports = { stableId, ensureEntitlement, ensureSyntheticAccessForConflict, backfillLegacySodConflicts };

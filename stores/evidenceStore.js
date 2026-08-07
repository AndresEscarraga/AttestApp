// Evidence Locker — generates downloadable evidence packages (ZIP with text + CSV + audit log).
// Phase 3 — Evidence Locker

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const AdmZip = require('adm-zip');
const { getDb } = require('./db');

const EVIDENCE_DIR = process.env.EVIDENCE_DIR || path.join(__dirname, '..', 'data', 'evidence');

function newId() {
  return 'ev_' + crypto.randomUUID().slice(0, 8);
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

class EvidenceStore {
  constructor() {
    this.db = getDb();
    ensureDir(EVIDENCE_DIR);
  }

  // ── Generate evidence package ──
  async generate({ name, campaignId, description, generatedBy, submissions, activityLog, campaign }) {
    const id = newId();
    const generatedAt = new Date().toISOString();
    const safeName = name.replace(/[^a-z0-9_-]/gi, '_').substring(0, 80);
    const zipName = `${safeName}_${id}.zip`;
    const zipPath = path.join(EVIDENCE_DIR, zipName);

    const zip = new AdmZip();

    // 1. Summary text
    const summary = this._generateSummary(campaign, submissions, activityLog);
    zip.addFile('00_Summary.txt', Buffer.from(summary, 'utf-8'));

    // 2. Submissions CSV
    const csv = this._generateCsv(submissions);
    zip.addFile('01_Submissions.csv', Buffer.from(csv, 'utf-8'));

    // 3. Activity log CSV
    const activityCsv = this._generateActivityCsv(activityLog);
    zip.addFile('02_Activity_Log.csv', Buffer.from(activityCsv, 'utf-8'));

    // 4. Campaign info JSON
    if (campaign) {
      zip.addFile('03_Campaign_Info.json', Buffer.from(JSON.stringify(campaign, null, 2), 'utf-8'));
    }

    // 5. Manifest
    const manifest = this._generateManifest({ id, name, generatedAt, generatedBy });
    zip.addFile('MANIFEST.txt', Buffer.from(manifest, 'utf-8'));

    // Write to disk
    zip.writeZip(zipPath);

    const stat = fs.statSync(zipPath);

    // Persist record
    this.db.prepare(`
      INSERT INTO evidence_packages (id, name, campaign_id, description, file_path, file_size, generated_by, generated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, name, campaignId || '', description || '', zipPath, stat.size, generatedBy, generatedAt);

    return {
      id,
      name,
      campaign_id: campaignId || '',
      description: description || '',
      file_size: stat.size,
      generated_by: generatedBy,
      generated_at: generatedAt,
    };
  }

  // ── Download package ──
  async getById(id) {
    const row = this.db.prepare('SELECT * FROM evidence_packages WHERE id = ?').get(id);
    if (!row) return null;
    return this._rowToPackage(row);
  }

  // ── List packages ──
  async listAll(filters = {}) {
    let sql = 'SELECT * FROM evidence_packages WHERE 1=1';
    const params = [];
    if (filters.campaign_id) { sql += ' AND campaign_id = ?'; params.push(filters.campaign_id); }
    sql += ' ORDER BY generated_at DESC';
    if (filters.limit) { sql += ' LIMIT ?'; params.push(filters.limit); }
    const rows = this.db.prepare(sql).all(...params);
    return rows.map(r => this._rowToPackage(r));
  }

  // ── Share with external auditor (temp link) ──
  async generateShareLink(id) {
    const pkg = await this.getById(id);
    if (!pkg) return null;
    if (!fs.existsSync(pkg.file_path)) return null;

    const token = crypto.randomBytes(24).toString('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(); // 7 days

    this.db.prepare('UPDATE evidence_packages SET share_token = ?, share_expires_at = ? WHERE id = ?')
      .run(token, expiresAt, id);

    return { token, expiresAt };
  }

  async getByShareToken(token) {
    const row = this.db.prepare(
      "SELECT * FROM evidence_packages WHERE share_token = ? AND share_expires_at > datetime('now')"
    ).get(token);
    if (!row) return null;
    return this._rowToPackage(row);
  }

  // ── Delete package ──
  async delete(id) {
    const pkg = await this.getById(id);
    if (pkg && fs.existsSync(pkg.file_path)) {
      try { fs.unlinkSync(pkg.file_path); } catch {}
    }
    const result = this.db.prepare('DELETE FROM evidence_packages WHERE id = ?').run(id);
    return result.changes > 0;
  }

  // ── Private helpers ──
  _rowToPackage(r) {
    return {
      id: r.id,
      tenant_id: r.tenant_id,
      name: r.name,
      campaign_id: r.campaign_id,
      description: r.description,
      file_path: r.file_path,
      file_size: r.file_size,
      generated_by: r.generated_by,
      generated_at: r.generated_at,
      share_token: r.share_token,
      share_expires_at: r.share_expires_at,
    };
  }

  _generateSummary(campaign, submissions, activityLog) {
    const lines = [];
    lines.push('='.repeat(60));
    lines.push('ATTEST — EVIDENCE PACKAGE SUMMARY');
    lines.push('='.repeat(60));
    lines.push('');
    if (campaign) {
      lines.push(`Campaign: ${campaign.name || 'N/A'}`);
      lines.push(`Framework: ${campaign.framework || 'N/A'}`);
      lines.push(`Period: ${campaign.period || 'N/A'}`);
      lines.push(`Status: ${campaign.status || 'N/A'}`);
      lines.push(`Deadline: ${campaign.deadline || 'N/A'}`);
      lines.push(`Approvers: ${Array.isArray(campaign.approvers) ? campaign.approvers.map(a => typeof a === 'string' ? a : a.name).join(', ') : 'N/A'}`);
    }
    lines.push('');
    lines.push(`Total Submissions: ${submissions.length}`);
    lines.push(`Activity Events: ${activityLog.length}`);
    lines.push('');
    lines.push(`Generated: ${new Date().toISOString()}`);
    lines.push('='.repeat(60));
    return lines.join('\n');
  }

  _generateCsv(submissions) {
    const cols = ['timestamp', 'approver', 'roleName', 'action', 'ritm', 'ritmStatus', 'actionDetails', 'submissionId'];
    const esc = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
    const lines = [cols.join(',')];
    submissions.forEach(s => {
      lines.push(cols.map(c => esc(s[c] || '')).join(','));
    });
    return lines.join('\n');
  }

  _generateActivityCsv(events) {
    const cols = ['timestamp', 'type', 'action', 'email', 'detail'];
    const esc = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
    const lines = [cols.join(',')];
    events.forEach(e => {
      lines.push(cols.map(c => esc(e[c] || '')).join(','));
    });
    return lines.join('\n');
  }

  _generateManifest({ id, name, generatedAt, generatedBy }) {
    return [
      'ATTEST EVIDENCE PACKAGE MANIFEST',
      '='.repeat(40),
      `Package ID: ${id}`,
      `Name: ${name}`,
      `Generated: ${generatedAt}`,
      `Generated By: ${generatedBy}`,
      '',
      'Contents:',
      '  00_Summary.txt        — Campaign summary & metadata',
      '  01_Submissions.csv    — All certification submissions',
      '  02_Activity_Log.csv   — Application activity events',
      '  03_Campaign_Info.json — Full campaign configuration (if applicable)',
      '  MANIFEST.txt          — This file',
      '',
      'This evidence package is digitally generated by Attest.',
      'For questions, contact your system administrator.',
    ].join('\n');
  }
}

function createEvidenceStore() {
  return new EvidenceStore();
}

module.exports = { createEvidenceStore, EVIDENCE_DIR };

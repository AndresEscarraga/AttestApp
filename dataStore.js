// Source-data layer for the Excel reports (roles/approvers and transactions).
// Single backend: local filesystem. GCS backend removed.
//
// API:
//   getVersion(name)  -> Promise<string|null>
//   getFile(name)     -> Promise<{ buffer, version, source }>

const path = require('path');
const {
  fileMtimeMs,
  normalizeSafeFileName,
  pathExists,
  readBuffer,
  resolveInside,
} = require('./fileSafety');

class LocalDataStore {
  constructor(dir, allowedNames = []) {
    this.dir = path.resolve(dir);
    this.allowedNames = new Set(allowedNames.map(name => normalizeSafeFileName(name, '.xlsx')));
  }
  _safeName(name) {
    const safeName = normalizeSafeFileName(name, '.xlsx');
    if (this.allowedNames.size && !this.allowedNames.has(safeName)) {
      throw new Error(`Unexpected source file: ${safeName}`);
    }
    return safeName;
  }
  _path(name) {
    return resolveInside(this.dir, this._safeName(name));
  }
  async getVersion(name) {
    const p = this._path(name);
    if (!pathExists(p)) return null;
    return String(fileMtimeMs(p));
  }
  async getFile(name) {
    const p = this._path(name);
    if (!pathExists(p)) throw new Error(`Source file not found: ${p}`);
    return {
      buffer: readBuffer(p),
      version: String(fileMtimeMs(p)),
      source: p,
    };
  }
}

function createDataStore() {
  const dir = process.env.REPORTS_DIR || path.join(__dirname, 'Reports');
  const allowedNames = [
    process.env.ROLES_FILE_NAME || 'Roles Approvers.xlsx',
    process.env.TX_FILE_NAME || 'Transactions.xlsx',
  ];
  console.log(`[data-store] backend=local dir=${dir}`);
  return new LocalDataStore(dir, allowedNames);
}

module.exports = { createDataStore, LocalDataStore };

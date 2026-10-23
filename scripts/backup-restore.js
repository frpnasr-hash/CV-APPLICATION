const fs = require('node:fs');
const path = require('node:path');
const { DEFAULT_DB_PATH, resetDbConnection } = require('../src/db/database');

const BACKUP_DIR = path.resolve(process.cwd(), 'runtime-data', 'backups');
if (!fs.existsSync(BACKUP_DIR)) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

const action = process.argv[2] || 'backup';

if (action === 'backup') {
  if (!fs.existsSync(DEFAULT_DB_PATH)) {
    console.error('Database file does not exist yet at:', DEFAULT_DB_PATH);
    process.exit(1);
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(BACKUP_DIR, `radiology_cv_studio_backup_${stamp}.sqlite`);
  fs.copyFileSync(DEFAULT_DB_PATH, backupPath);
  console.log(JSON.stringify({ ok: true, action: 'backup', backupPath, sizeBytes: fs.statSync(backupPath).size }));
} else if (action === 'restore') {
  const sourceFile = process.argv[3];
  const files = fs
    .readdirSync(BACKUP_DIR)
    .filter((f) => f.endsWith('.sqlite'))
    .sort()
    .reverse();

  const targetBackup = sourceFile ? path.resolve(sourceFile) : files[0] ? path.join(BACKUP_DIR, files[0]) : null;
  if (!targetBackup || !fs.existsSync(targetBackup)) {
    console.error('No backup file found to restore.');
    process.exit(1);
  }
  resetDbConnection();
  fs.copyFileSync(targetBackup, DEFAULT_DB_PATH);
  console.log(JSON.stringify({ ok: true, action: 'restore', restoredFrom: targetBackup }));
}

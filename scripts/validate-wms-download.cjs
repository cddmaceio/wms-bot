// Runs only WMS download and local CSV validation. No destination API or WhatsApp.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const root = process.cwd();
const Database = require('better-sqlite3');
const { Vault } = require(path.join(root, 'dist/security.js'));
const { readCsv } = require(path.join(root, 'dist/csv.js'));
const download = require(path.join(root, 'automation/wms.cjs'));
async function main() {
  const data = process.env.DATA_DIR || '/data';
  const db = new Database(path.join(data, 'wms.sqlite3'), {readonly:true});
  const saved = db.prepare('SELECT value FROM settings WHERE id=1').get();
  const job = db.prepare('SELECT date FROM jobs ORDER BY created DESC LIMIT 1').get();
  const active = db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE state IN ('queued','downloading','validating','uploading')").get().count;
  db.close();
  if (active) throw new Error('Wait until the active WMS job finishes');
  if (!job) throw new Error('No previous query date available');
  const config = new Vault(process.env.SETTINGS_KEY || '').open(saved.value);
  const directory = path.join(data, 'diagnostics', 'download-' + randomUUID());
  fs.mkdirSync(directory, {recursive:true});
  const result = await download(config, directory, path.join(data, 'wms-profile/storageState.json'), job.date);
  const parsed = readCsv(result.file);
  console.log('WMS_DOWNLOAD_VALIDATED', JSON.stringify({date:job.date,records:parsed.records.length,duplicates:parsed.duplicates,file:result.file,apiCalled:false,whatsappCalled:false}));
}
main().catch(error => { console.error(error.name, error.message.split('\n')[0]); process.exitCode=1; });

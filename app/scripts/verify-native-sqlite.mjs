import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const electronBin = require('electron');
const appDir = join(dirname(fileURLToPath(import.meta.url)), '..');

const script = `
const Database = require('better-sqlite3');
const db = new Database(':memory:');
db.exec('create table native_check(value integer); insert into native_check values (1)');
const row = db.prepare('select value from native_check').get();
db.close();
if (!row || row.value !== 1) throw new Error('unexpected sqlite result');
console.log(JSON.stringify({
  electron: process.versions.electron,
  modules: process.versions.modules,
  sqlite: 'ok'
}));
`;

const result = spawnSync(electronBin, ['-e', script], {
  cwd: appDir,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  encoding: 'utf8',
});

if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.status !== 0) process.exit(result.status ?? 1);

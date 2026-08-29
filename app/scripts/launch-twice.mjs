import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const electronBin = require('electron');
const appDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = process.env.STAFFDESK_LAUNCH_SCRATCH;
if (!scratch) {
  console.error('STAFFDESK_LAUNCH_SCRATCH required');
  process.exit(1);
}
mkdirSync(scratch, { recursive: true });
const brainFile = join(scratch, 'brain.db');
const round = process.argv[2] ?? '1';
const logFile = join(scratch, `launch-${round}.log`);

function run() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const child = spawn(electronBin, ['.'], {
      cwd: appDir,
      env: {
        ...process.env,
        STAFFDESK_BRAIN: brainFile,
        ELECTRON_ENABLE_LOGGING: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const onData = (buf) => {
      chunks.push(buf);
      process.stdout.write(buf);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const timer = setTimeout(() => {
      child.kill();
    }, 8000);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const text = Buffer.concat(chunks).toString('utf8');
      writeFileSync(logFile, text, 'utf8');
      resolve({ code, text, brainFile, exists: existsSync(brainFile) });
    });
  });
}

const result = await run();
console.log(JSON.stringify({ round, exists: result.exists, brainFile, logFile }, null, 2));
if (!result.exists) process.exit(2);
if (!/better-sqlite3 loaded in main process/.test(result.text)) process.exit(3);

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const electronBin = require('electron');
const appDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const vitest = join(appDir, 'node_modules/vitest/vitest.mjs');
const args = [vitest, ...process.argv.slice(2)];
const child = spawn(electronBin, args, {
  cwd: appDir,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  stdio: 'inherit',
});
child.on('exit', (code) => process.exit(code ?? 1));

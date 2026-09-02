import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const electronBin = require('electron');
const appDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const vitest = join(appDir, 'node_modules/vitest/vitest.mjs');
const args = [vitest, ...process.argv.slice(2)];
// 默认 Electron-as-node（与产品运行时一致）；CI 的 Linux runner 上该组合会让 vite-node
// 的 fork 临时缓存整片 ENOENT（PR #29，Electron 补丁版 fs 所致，零断言失败也 exit 1）。
// STAFFDESK_VITEST_RUNTIME=node 时改跑纯 Node——better-sqlite3 是 N-API prebuild 运行时无关，
// Electron 运行时验证由 native:check 与 e2e 两个独立门禁承担，单测跑 Node 零损失。
const runtime = process.env.STAFFDESK_VITEST_RUNTIME === 'node' ? process.execPath : electronBin;
const env =
  runtime === electronBin ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' } : { ...process.env };
const child = spawn(runtime, args, {
  cwd: appDir,
  env,
  stdio: 'inherit',
});
child.on('exit', (code) => process.exit(code ?? 1));

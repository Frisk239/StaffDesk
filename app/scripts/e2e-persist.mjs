import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

const require = createRequire(import.meta.url);
const electronBin = require('electron');
const appDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = process.env.STAFFDESK_LAUNCH_SCRATCH;
if (!scratch) throw new Error('STAFFDESK_LAUNCH_SCRATCH required');
mkdirSync(scratch, { recursive: true });
const brainFile = join(scratch, 'e2e-brain.db');

async function launch() {
  return electron.launch({
    executablePath: electronBin,
    args: [appDir],
    env: {
      ...process.env,
      STAFFDESK_BRAIN: brainFile,
    },
    timeout: 30_000,
  });
}

const logs = [];
const app1 = await launch();
app1.on('window', () => logs.push('window'));
const win1 = await app1.firstWindow();
await win1.waitForTimeout(800);
await win1.evaluate(async () => {
  await window.staffdesk.dispatch({ type: 'ADD_WORKSPACE', name: '验收区', scenario: '求职面试' });
  await window.staffdesk.dispatch({ type: 'ADD_OBJECT', kind: '组织', name: '验收组织' });
});
const snap1 = await win1.evaluate(() => window.staffdesk.snapshot());
logs.push(`first objects=${snap1.objects.map((o) => o.name).join(',')}`);
await win1.screenshot({ path: join(scratch, 'm1-shell.png') });
await app1.close();

const app2 = await launch();
const win2 = await app2.firstWindow();
await win2.waitForTimeout(800);
const snap2 = await win2.evaluate(() => window.staffdesk.snapshot());
logs.push(`second objects=${snap2.objects.map((o) => o.name).join(',')}`);
const visible = await win2.getByText('验收组织').isVisible().catch(() => false);
logs.push(`visible=${visible}`);
await app2.close();

const text = logs.join('\n') + `\nbrain=${brainFile} exists=${existsSync(brainFile)}\n`;
writeFileSync(join(scratch, 'e2e.log'), text, 'utf8');
console.log(text);
if (!snap2.objects.some((o) => o.name === '验收组织')) process.exit(1);

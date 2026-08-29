import fs from 'node:fs';
import path from 'node:path';

function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (/\.(ts|tsx)$/.test(e.name)) acc.push(p);
  }
  return acc;
}

const root = path.resolve(import.meta.dirname, '..');
const files = walk(path.join(root, 'src/renderer/src'));
for (const f of files) {
  const s = fs.readFileSync(f, 'utf8');
  const n = s
    .replace(/from '\.\.\/types'/g, "from '@shared/types'")
    .replace(/from '\.\.\/scenario'/g, "from '@shared/scenario'")
    .replace(/from '\.\.\/\.\.\/types'/g, "from '@shared/types'");
  if (n !== s) {
    fs.writeFileSync(f, n, 'utf8');
    console.log('updated', f);
  }
}

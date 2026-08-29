import fs from 'node:fs';

const p = new URL('../src/renderer/src/markdown.tsx', import.meta.url);
let s = fs.readFileSync(p, 'utf8');
s = s.replace(/lines\[i\]/g, "(lines[i] ?? '')");
s = s.replace("const line = (lines[i] ?? '') ?? '';", "const line = (lines[i] ?? '');");
fs.writeFileSync(p, s);
console.log('patched markdown');

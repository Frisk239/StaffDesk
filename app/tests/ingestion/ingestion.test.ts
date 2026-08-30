import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openBrain, type Brain } from '../../src/main/brain';
import { createIngestionExecutor, IngestFailure, parseIngestInput } from '../../src/main/ingestion';

const dirs: string[] = [];
const brains: Brain[] = [];
const servers: Server[] = [];

afterEach(async () => {
  while (brains.length) brains.pop()?.close();
  await Promise.all(
    servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
  );
  while (dirs.length) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'staffdesk-ingest-'));
  dirs.push(dir);
  return dir;
}

function tmpBrain(): Brain {
  const brain = openBrain(join(tmpDir(), 'brain.db'));
  brains.push(brain);
  brain.dispatch({ type: 'ADD_WORKSPACE', name: '导入测试', scenario: '求职面试' });
  return brain;
}

async function serve(
  routes: Record<string, { status?: number; type?: string; body: string | Buffer }>,
) {
  const server = createServer((req, res) => {
    const route = routes[req.url ?? '/'];
    if (!route) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(route.status ?? 200, { 'content-type': route.type ?? 'text/plain' });
    res.end(route.body);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server listen failed');
  return `http://127.0.0.1:${address.port}`;
}

describe('真实进料', () => {
  it('粘贴文本会生成可定位来源材料', async () => {
    const material = await parseIngestInput({
      kind: 'text',
      text: 'Acme uses Rust.\nAcme is hiring interns.',
      suggestedTitle: 'Acme note',
    });

    expect(material.title).toBe('Acme note');
    expect(material.origin.kind).toBe('text');
    expect(material.contentHash).toHaveLength(64);
    expect(material.segments[0]).toMatchObject({ start: 0, end: material.body.length });
  });

  it('URL 获取失败只留下导入任务，不写业务来源', async () => {
    const base = await serve({
      '/ok': {
        type: 'text/html',
        body: '<html><head><title>Acme JD</title></head><body><h1>Acme uses Rust.</h1></body></html>',
      },
    });
    const brain = tmpBrain();
    const execute = createIngestionExecutor({ brain, publish: () => undefined });

    await execute({ kind: 'url', url: `${base}/ok` });
    const afterOk = brain.snapshot();
    expect(afterOk.sources.filter((source) => !source.virtual)).toHaveLength(1);
    expect(afterOk.sources.find((source) => !source.virtual)?.body).toContain('Acme uses Rust');
    expect(afterOk.ingestJobs[0]).toMatchObject({ status: '完成' });

    await execute({ kind: 'url', url: `${base}/missing` });
    const afterFail = brain.snapshot();
    expect(afterFail.sources.filter((source) => !source.virtual)).toHaveLength(1);
    expect(
      afterFail.ingestJobs.some(
        (job) => job.status === '失败' && job.failureKind === 'fetch-failed',
      ),
    ).toBe(true);
  });

  it('主进程可以解析 TXT 与 PDF 文件', async () => {
    const dir = tmpDir();
    const txt = join(dir, 'note.txt');
    const pdf = join(dir, 'note.pdf');
    writeFileSync(txt, 'Acme has a platform team.');
    writeFileSync(pdf, simplePdf('Acme uses Rust'));

    const textMaterial = await parseIngestInput({ kind: 'file', filePath: txt });
    expect(textMaterial.title).toBe('note.txt');
    expect(textMaterial.body).toContain('platform team');
    expect(textMaterial.origin.kind).toBe('file');

    const pdfMaterial = await parseIngestInput({ kind: 'file', filePath: pdf });
    expect(pdfMaterial.title).toBe('note.pdf');
    expect(pdfMaterial.body).toContain('Acme uses Rust');
    expect(pdfMaterial.segments[0]?.page).toBe(1);
  });

  it('URL 正文读取超时会失败为 timeout', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.write('Acme slow stream starts.');
      setTimeout(() => res.end('Acme slow stream ends.'), 50);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server listen failed');

    await expect(
      parseIngestInput(
        { kind: 'url', url: `http://127.0.0.1:${address.port}/slow` },
        { limits: { fetchMs: 10 } },
      ),
    ).rejects.toMatchObject({
      kind: 'timeout',
    } satisfies Partial<IngestFailure>);
  });

  it('文件解析超时会失败为 timeout', async () => {
    const dir = tmpDir();
    const pdf = join(dir, 'note.pdf');
    writeFileSync(pdf, simplePdf('Acme uses Rust'));

    await expect(
      parseIngestInput({ kind: 'file', filePath: pdf }, { limits: { parseMs: 0 } }),
    ).rejects.toMatchObject({
      kind: 'timeout',
    } satisfies Partial<IngestFailure>);
  });

  it('空文本会报错且不生成来源材料', async () => {
    await expect(parseIngestInput({ kind: 'text', text: '   ' })).rejects.toMatchObject({
      kind: 'empty-body',
    } satisfies Partial<IngestFailure>);
  });
});

function simplePdf(text: string): Buffer {
  const stream = `BT /F1 24 Tf 72 720 Td (${escapePdfText(text)}) Tj ET`;
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>\nendobj\n',
    `4 0 obj\n<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream\nendobj\n`,
    '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
  ];
  let body = '%PDF-1.4\n';
  const offsets = [0];
  for (const object of objects) {
    offsets.push(Buffer.byteLength(body, 'latin1'));
    body += object;
  }
  const xref = Buffer.byteLength(body, 'latin1');
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('');
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

function escapePdfText(text: string): string {
  return text.replace(/[\\()]/g, (char) => `\\${char}`);
}

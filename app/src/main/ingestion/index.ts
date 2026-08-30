import { createHash, randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import type {
  IngestFailureKind,
  IngestInput,
  SourceOrigin,
  SourceSegment,
  State,
} from '@shared/types';
import type { Brain } from '../brain';

const DEFAULT_LIMITS = {
  urlBytes: 5 * 1024 * 1024,
  fileBytes: 25 * 1024 * 1024,
  bodyChars: 1_000_000,
  pdfPages: 500,
  fetchMs: 20_000,
  parseMs: 20_000,
};

const TEXT_EXTENSIONS = new Set([
  '.txt',
  '.md',
  '.markdown',
  '.csv',
  '.json',
  '.html',
  '.htm',
  '.log',
  '.yaml',
  '.yml',
  '.xml',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
]);

export interface ParsedMaterial {
  title: string;
  body: string;
  origin: SourceOrigin;
  segments: SourceSegment[];
  contentHash: string;
}

export class IngestFailure extends Error {
  readonly kind: IngestFailureKind;
  readonly title?: string | undefined;
  readonly locator?: string | undefined;

  constructor(
    kind: IngestFailureKind,
    message: string,
    extra: { title?: string | undefined; locator?: string | undefined } = {},
  ) {
    super(message);
    this.name = 'IngestFailure';
    this.kind = kind;
    this.title = extra.title;
    this.locator = extra.locator;
  }
}

type IngestionBrain = Pick<Brain, 'snapshot' | 'dispatch'>;

export function createIngestionExecutor(args: {
  brain: IngestionBrain;
  publish: (state: State) => void;
  parse?: typeof parseIngestInput | undefined;
}): (input: IngestInput, existingJobId?: string) => Promise<State> {
  const parse = args.parse ?? parseIngestInput;
  return async (input, existingJobId) => {
    const state = args.brain.snapshot();
    const existing = existingJobId
      ? state.ingestJobs.find((job) => job.id === existingJobId)
      : undefined;
    const now = new Date().toISOString();
    const jobId = existing?.id ?? `ing-${randomUUID()}`;
    const job = {
      id: jobId,
      inputKind: input.kind,
      input,
      status: input.kind === 'text' ? ('解析中' as const) : ('获取中' as const),
      title: ingestTitleHint(input, existing?.title),
      locator: ingestLocator(input, existing?.locator),
      attempt: existing ? existing.attempt + 1 : 1,
      workspaceId: state.currentWorkspaceId,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    let next = args.brain.dispatch({ type: 'INGEST_STARTED', job });
    args.publish(next);
    try {
      const material = await parse(input);
      next = args.brain.dispatch({
        type: 'INGEST_SUCCEEDED',
        jobId,
        title: material.title,
        body: material.body,
        origin: material.origin,
        segments: material.segments,
        contentHash: material.contentHash,
      });
      args.publish(next);
      return next;
    } catch (error) {
      const failure = normalizeFailure(error);
      next = args.brain.dispatch({
        type: 'INGEST_FAILED',
        jobId,
        failureKind: failure.kind,
        detail: failure.detail,
        title: failure.title ?? job.title,
        locator: failure.locator ?? job.locator,
      });
      args.publish(next);
      return next;
    }
  };
}

export async function parseIngestInput(
  input: IngestInput,
  options: {
    fetchImpl?: typeof fetch | undefined;
    now?: (() => Date) | undefined;
    limits?: Partial<typeof DEFAULT_LIMITS> | undefined;
  } = {},
): Promise<ParsedMaterial> {
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  const now = options.now ?? (() => new Date());
  if (input.kind === 'text') return parseTextInput(input, now, limits);
  if (input.kind === 'url') return parseUrlInput(input, options.fetchImpl ?? fetch, now, limits);
  return parseFileInput(input, now, limits);
}

function parseTextInput(
  input: Extract<IngestInput, { kind: 'text' }>,
  now: () => Date,
  limits: typeof DEFAULT_LIMITS,
): ParsedMaterial {
  const body = normalizeText(input.text);
  if (!body) throw new IngestFailure('empty-body', '没有可指向的正文');
  ensureBodyLimit(body, limits.bodyChars);
  const contentHash = hashText(body);
  return {
    title: titleFromText(body, input.suggestedTitle),
    body,
    contentHash,
    origin: {
      kind: 'text',
      mimeType: 'text/plain; charset=utf-8',
      sizeBytes: Buffer.byteLength(body),
      contentHash,
      fetchedAt: now().toISOString(),
    },
    segments: [segmentFor(body, '正文')],
  };
}

function ingestTitleHint(input: IngestInput, fallback: string | undefined): string | undefined {
  if (input.kind === 'text') return input.suggestedTitle ?? fallback;
  if (input.kind === 'file') return basename(input.filePath);
  return fallback;
}

function ingestLocator(input: IngestInput, fallback: string | undefined): string | undefined {
  if (input.kind === 'url') return input.url;
  if (input.kind === 'file') return basename(input.filePath);
  return fallback;
}

function normalizeFailure(error: unknown): {
  kind: IngestFailureKind;
  detail: string;
  title?: string | undefined;
  locator?: string | undefined;
} {
  if (error instanceof IngestFailure) {
    return {
      kind: error.kind,
      detail: error.message,
      title: error.title,
      locator: error.locator,
    };
  }
  return { kind: 'parse-failed', detail: safeErrorDetail(error) };
}

async function parseUrlInput(
  input: Extract<IngestInput, { kind: 'url' }>,
  fetchImpl: typeof fetch,
  now: () => Date,
  limits: typeof DEFAULT_LIMITS,
): Promise<ParsedMaterial> {
  let url: URL;
  try {
    url = new URL(input.url.trim());
  } catch {
    throw new IngestFailure('invalid-input', 'URL 格式不正确', { locator: input.url });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new IngestFailure('invalid-input', '只支持 http/https 链接', { locator: input.url });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), limits.fetchMs);
  try {
    const response = await fetchImpl(url.toString(), {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        accept: 'text/html, text/plain, application/pdf, application/json;q=0.8, */*;q=0.2',
      },
    });

    if (!response.ok) {
      throw new IngestFailure('fetch-failed', `HTTP ${response.status}`, {
        locator: response.url || url.toString(),
      });
    }
    const mimeType = normalizeMime(response.headers.get('content-type'));
    const bytes = await readResponseBytes(response, limits.urlBytes, controller.signal);
    return await materialFromBytes({
      buffer: bytes,
      mimeType,
      titleHint: titleFromUrl(response.url || url.toString()),
      origin: {
        kind: 'url',
        locator: url.toString(),
        finalUrl: response.url || url.toString(),
        mimeType,
        sizeBytes: bytes.length,
        fetchedAt: now().toISOString(),
      },
      limits,
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof IngestFailure) throw error;
    const timedOut = controller.signal.aborted || isAbortLike(error);
    if (timedOut) throw timeoutFailure(undefined, url.toString());
    throw new IngestFailure('fetch-failed', safeErrorDetail(error), {
      locator: url.toString(),
    });
  } finally {
    clearTimeout(timer);
  }
}

async function parseFileInput(
  input: Extract<IngestInput, { kind: 'file' }>,
  now: () => Date,
  limits: typeof DEFAULT_LIMITS,
): Promise<ParsedMaterial> {
  const filePath = input.filePath.trim();
  if (!filePath) throw new IngestFailure('invalid-input', '文件路径为空');
  const fileName = basename(filePath);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), limits.parseMs);
  try {
    const size = (await stat(filePath)).size;
    if (size > limits.fileBytes) {
      throw new IngestFailure(
        'too-large',
        `文件超过 ${Math.round(limits.fileBytes / 1024 / 1024)} MB`,
        {
          title: fileName,
          locator: fileName,
        },
      );
    }
    const buffer = await readFile(filePath);
    assertNotAborted(controller.signal, fileName, fileName);
    const mimeType = mimeFromFile(filePath, buffer);
    return await materialFromBytes({
      buffer,
      mimeType,
      titleHint: fileName,
      origin: {
        kind: 'file',
        locator: fileName,
        fileName,
        mimeType,
        sizeBytes: buffer.length,
        fetchedAt: now().toISOString(),
      },
      limits,
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof IngestFailure) throw error;
    if (controller.signal.aborted) throw timeoutFailure(fileName, fileName);
    throw new IngestFailure('invalid-input', safeErrorDetail(error), { title: fileName });
  } finally {
    clearTimeout(timer);
  }
}

async function materialFromBytes(args: {
  buffer: Buffer;
  mimeType: string;
  titleHint: string;
  origin: SourceOrigin;
  limits: typeof DEFAULT_LIMITS;
  signal?: AbortSignal | undefined;
}): Promise<ParsedMaterial> {
  assertNotAborted(args.signal, args.titleHint, args.origin.locator);
  if (args.mimeType === 'application/pdf') {
    return parsePdf(args);
  }
  if (!isSupportedTextMime(args.mimeType)) {
    throw new IngestFailure('unsupported-mime', `暂不支持 ${args.mimeType || '未知格式'}`, {
      title: args.titleHint,
      locator: args.origin.locator,
    });
  }
  const raw = decodeUtf8(args.buffer);
  assertNotAborted(args.signal, args.titleHint, args.origin.locator);
  const parsed =
    args.mimeType === 'text/html'
      ? extractHtml(raw, args.titleHint)
      : { title: args.titleHint, body: raw };
  const body = normalizeText(parsed.body);
  if (!body) {
    throw new IngestFailure('empty-body', '没有可指向的正文', {
      title: parsed.title,
      locator: args.origin.locator,
    });
  }
  ensureBodyLimit(body, args.limits.bodyChars);
  const contentHash = hashText(body);
  return {
    title: parsed.title,
    body,
    contentHash,
    origin: { ...args.origin, contentHash },
    segments: [segmentFor(body, '正文')],
  };
}

async function parsePdf(args: {
  buffer: Buffer;
  titleHint: string;
  origin: SourceOrigin;
  limits: typeof DEFAULT_LIMITS;
  signal?: AbortSignal | undefined;
}): Promise<ParsedMaterial> {
  let loadingTask: { promise: Promise<unknown>; destroy?: () => Promise<void> };
  try {
    const pdfjs = await raceAbort(
      import('pdfjs-dist/legacy/build/pdf.mjs'),
      args.signal,
      args.titleHint,
      args.origin.locator,
    );
    loadingTask = pdfjs.getDocument({
      data: new Uint8Array(args.buffer),
      disableFontFace: true,
      useSystemFonts: true,
    }) as typeof loadingTask;
  } catch (error) {
    if (error instanceof IngestFailure) throw error;
    throw new IngestFailure('parse-failed', safeErrorDetail(error), {
      title: args.titleHint,
      locator: args.origin.locator,
    });
  }

  try {
    const doc = (await raceAbort(
      loadingTask.promise,
      args.signal,
      args.titleHint,
      args.origin.locator,
    )) as {
      numPages: number;
      getPage: (pageNumber: number) => Promise<{
        getTextContent: () => Promise<{ items: unknown[] }>;
      }>;
      destroy?: () => Promise<void>;
    };
    if (doc.numPages > args.limits.pdfPages) {
      throw new IngestFailure('too-many-pages', `PDF 超过 ${args.limits.pdfPages} 页`, {
        title: args.titleHint,
        locator: args.origin.locator,
      });
    }
    const parts: string[] = [];
    const segments: SourceSegment[] = [];
    let offset = 0;
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
      assertNotAborted(args.signal, args.titleHint, args.origin.locator);
      const page = await raceAbort(
        doc.getPage(pageNumber),
        args.signal,
        args.titleHint,
        args.origin.locator,
      );
      const content = await raceAbort(
        page.getTextContent(),
        args.signal,
        args.titleHint,
        args.origin.locator,
      );
      const text = normalizeText(
        content.items
          .map((item) => (hasTextStr(item) ? item.str : ''))
          .filter(Boolean)
          .join(' '),
      );
      if (!text) continue;
      if (parts.length > 0) {
        parts.push('\n\n');
        offset += 2;
      }
      const start = offset;
      parts.push(text);
      offset += text.length;
      segments.push({
        id: `page-${pageNumber}`,
        start,
        end: offset,
        page: pageNumber,
        label: `第 ${pageNumber} 页`,
      });
    }
    await doc.destroy?.();
    const body = parts.join('');
    if (!body.trim()) {
      throw new IngestFailure('empty-body', 'PDF 没有可提取文字', {
        title: args.titleHint,
        locator: args.origin.locator,
      });
    }
    ensureBodyLimit(body, args.limits.bodyChars);
    const contentHash = hashText(body);
    return {
      title: args.titleHint,
      body,
      contentHash,
      origin: {
        ...args.origin,
        contentHash,
        pageCount: doc.numPages,
      },
      segments,
    };
  } catch (error) {
    if (error instanceof IngestFailure) throw error;
    throw new IngestFailure('parse-failed', safeErrorDetail(error), {
      title: args.titleHint,
      locator: args.origin.locator,
    });
  } finally {
    await loadingTask.destroy?.().catch(() => undefined);
  }
}

async function readResponseBytes(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal | undefined,
): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > maxBytes) {
    throw new IngestFailure('too-large', `响应超过 ${Math.round(maxBytes / 1024 / 1024)} MB`, {
      locator: response.url,
    });
  }
  if (!response.body) {
    const bytes = await raceAbort(response.arrayBuffer(), signal, undefined, response.url);
    return Buffer.from(bytes);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      assertNotAborted(signal, undefined, response.url);
      const { done, value } = await raceAbort(reader.read(), signal, undefined, response.url);
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new IngestFailure('too-large', `响应超过 ${Math.round(maxBytes / 1024 / 1024)} MB`, {
          locator: response.url,
        });
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}

function timeoutFailure(title: string | undefined, locator: string | undefined): IngestFailure {
  return new IngestFailure('timeout', '导入超过时间限制', { title, locator });
}

function assertNotAborted(
  signal: AbortSignal | undefined,
  title: string | undefined,
  locator: string | undefined,
): void {
  if (signal?.aborted) throw timeoutFailure(title, locator);
}

function isAbortLike(error: unknown): boolean {
  const name =
    error && typeof error === 'object' && 'name' in error
      ? String((error as { name?: unknown }).name)
      : '';
  return name === 'AbortError' || name === 'TimeoutError';
}

async function raceAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  title: string | undefined,
  locator: string | undefined,
): Promise<T> {
  if (!signal) return promise;
  assertNotAborted(signal, title, locator);
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(timeoutFailure(title, locator));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        if (signal.aborted) reject(timeoutFailure(title, locator));
        else resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        if (signal.aborted && isAbortLike(error)) reject(timeoutFailure(title, locator));
        else reject(error);
      },
    );
  });
}

function segmentFor(body: string, label: string): SourceSegment {
  return { id: `seg-${randomUUID()}`, start: 0, end: body.length, label };
}

function mimeFromFile(filePath: string, buffer: Buffer): string {
  if (buffer.subarray(0, 5).toString('ascii') === '%PDF-') return 'application/pdf';
  const ext = extname(filePath).toLowerCase();
  if (TEXT_EXTENSIONS.has(ext))
    return ext === '.html' || ext === '.htm' ? 'text/html' : 'text/plain';
  return 'application/octet-stream';
}

function normalizeMime(contentType: string | null): string {
  const mime = (contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  if (!mime) return 'application/octet-stream';
  if (mime === 'application/json' || mime.endsWith('+json')) return 'text/plain';
  if (mime === 'application/xhtml+xml') return 'text/html';
  return mime;
}

function isSupportedTextMime(mimeType: string): boolean {
  return mimeType === 'text/html' || mimeType === 'text/plain' || mimeType.startsWith('text/');
}

function decodeUtf8(buffer: Buffer): string {
  return buffer.toString('utf8').replace(/^\uFEFF/, '');
}

function normalizeText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\f\v]+/g, ' ')
    .trim();
}

function extractHtml(html: string, fallbackTitle: string): { title: string; body: string } {
  const title = decodeEntities(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').trim();
  const body = decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<\/(p|div|section|article|li|h[1-6]|tr|br)>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  );
  return { title: title || fallbackTitle, body };
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function titleFromText(body: string, suggestedTitle: string | undefined): string {
  const suggested = suggestedTitle?.trim();
  if (suggested) return suggested.slice(0, 80);
  return body.split('\n')[0]?.slice(0, 80).trim() || body.slice(0, 24) || '粘贴文本';
}

function titleFromUrl(raw: string): string {
  try {
    const url = new URL(raw);
    const path = decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() ?? '');
    return path || url.hostname || raw;
  } catch {
    return raw.slice(0, 80);
  }
}

function ensureBodyLimit(body: string, maxChars: number): void {
  if (body.length > maxChars) throw new IngestFailure('too-large', `正文超过 ${maxChars} 字符`);
}

function hashText(body: string): string {
  return createHash('sha256').update(body).digest('hex');
}

function hasTextStr(value: unknown): value is { str: string } {
  return Boolean(
    value && typeof value === 'object' && typeof (value as { str?: unknown }).str === 'string',
  );
}

function safeErrorDetail(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/Bearer\s+\S+/gi, 'Bearer ***')
    .replace(/sk-[A-Za-z0-9_-]+/g, 'sk-***')
    .slice(0, 180);
}

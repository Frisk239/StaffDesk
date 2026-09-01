import { spawn } from 'node:child_process';

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

export interface OpenResult {
  url: string;
  ok: boolean;
  body: string;
  finalUrl?: string | undefined;
  title?: string | undefined;
  error?: string | undefined;
}

export interface DoctorResult {
  ok: boolean;
  detail: string;
  hint?: string;
}

export interface ReachAdapter {
  doctor: () => Promise<DoctorResult>;
  search: (query: string) => Promise<SearchHit[]>;
  open: (url: string) => Promise<OpenResult>;
}

export type SpawnFn = typeof spawn;
export type FetchFn = typeof fetch;

export class ReachError extends Error {
  readonly hint?: string | undefined;

  constructor(message: string, hint?: string | undefined) {
    super(message);
    this.name = 'ReachError';
    this.hint = hint;
  }
}

const INSTALL_HINT =
  '本机没有可用的检索适配。请安装 Agent Reach（agent-reach / mcporter），然后重试；也可以先手动导入 URL 或文本作为降级路径。';

function executable(name: string): string {
  return name;
}

function runCommand(
  spawnFn: SpawnFn,
  command: string,
  args: string[],
  timeoutMs = 20_000,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawnFn(command, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new ReachError('检索适配超时', INSTALL_HINT));
    }, timeoutMs);
    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new ReachError(err.message, INSTALL_HINT));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

export function createReachAdapter(
  spawnFn: SpawnFn = spawn,
  fetchFn: FetchFn = fetch,
): ReachAdapter {
  // e2e 隔离机没有 Agent Reach；费用触顶 spec 走罐头检索，不触外网。
  if (process.env.STAFFDESK_E2E_REACH === '1') return createE2eReachAdapter();
  return {
    async doctor() {
      try {
        const r = await runCommand(spawnFn, executable('agent-reach'), ['doctor', '--json'], 8000);
        if (r.code === 0) {
          return { ok: true, detail: r.stdout.trim() || 'agent-reach 可用' };
        }
        return {
          ok: false,
          detail: compact(r.stderr || r.stdout || 'agent-reach doctor 失败'),
          hint: INSTALL_HINT,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, detail: compact(msg), hint: INSTALL_HINT };
      }
    },
    async search(query: string) {
      try {
        const r = await runCommand(
          spawnFn,
          executable('mcporter'),
          ['call', 'exa.web_search_exa', query],
          25_000,
        );
        if (r.code !== 0) {
          throw new ReachError(
            compact(r.stderr || r.stdout || `mcporter 退出 ${r.code}`),
            INSTALL_HINT,
          );
        }
        return parseHitsOrThrow(r.stdout);
      } catch (err) {
        const detail = compact(err instanceof Error ? err.message : String(err));
        throw new ReachError(detail || '检索适配不可用', INSTALL_HINT);
      }
    },
    async open(url: string) {
      return openViaJinaReader(fetchFn, url);
    },
  };
}

async function openViaJinaReader(fetchFn: FetchFn, url: string): Promise<OpenResult> {
  try {
    const reader = `https://r.jina.ai/${url}`;
    const res = await fetchFn(reader, {
      headers: { Accept: 'text/plain' },
    });
    if (!res.ok) {
      return { url, ok: false, body: '', error: `打开失败 HTTP ${res.status}` };
    }
    const body = (await res.text()).trim().slice(0, 40_000);
    if (!body) return { url, ok: false, body: '', error: '打开后正文为空' };
    return { url, ok: true, body, finalUrl: url };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { url, ok: false, body: '', error: compact(msg) };
  }
}

function parseHitsOrThrow(stdout: string): SearchHit[] {
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch {
    throw new ReachError('检索返回不是 JSON', INSTALL_HINT);
  }
  const rows = Array.isArray(json)
    ? json
    : typeof json === 'object' && json && 'results' in json
      ? (json as { results: unknown }).results
      : typeof json === 'object' && json && 'data' in json
        ? (json as { data: unknown }).data
        : [];
  if (!Array.isArray(rows)) throw new ReachError('检索返回缺少 results 数组', INSTALL_HINT);
  return rows
    .map((row) => {
      const r = row as {
        title?: string;
        url?: string;
        link?: string;
        snippet?: string;
        text?: string;
        content?: string;
      };
      const url = r.url ?? r.link ?? '';
      return {
        title: r.title ?? url,
        url,
        snippet: r.snippet ?? r.text ?? r.content ?? '',
      };
    })
    .filter((h) => Boolean(h.url));
}

function compact(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 240);
}

export const UNAVAILABLE_ADAPTER: ReachAdapter = {
  async doctor() {
    return { ok: false, detail: '未配置检索适配', hint: INSTALL_HINT };
  },
  async search() {
    throw new ReachError('未配置检索适配', INSTALL_HINT);
  },
  async open(url: string) {
    return { url, ok: false, body: '', error: INSTALL_HINT };
  },
};

function createE2eReachAdapter(): ReachAdapter {
  const hits: SearchHit[] = [
    {
      title: '费用触顶来源甲',
      url: 'https://e2e.staffdesk.test/a',
      snippet: '主栈是 Rust',
    },
    {
      title: '费用触顶来源乙',
      url: 'https://e2e.staffdesk.test/b',
      snippet: '融资轮次为 A 轮',
    },
  ];
  return {
    async doctor() {
      return { ok: true, detail: 'e2e reach' };
    },
    async search() {
      return hits;
    },
    async open(url: string) {
      const hit = hits.find((item) => item.url === url) ?? hits[0];
      const body =
        url.endsWith('/a') || hit?.url.endsWith('/a')
          ? '费用触顶组织主栈是 Rust。'
          : '费用触顶组织融资轮次为 A 轮。';
      return { url, ok: true, body, finalUrl: url, title: hit?.title ?? url };
    },
  };
}

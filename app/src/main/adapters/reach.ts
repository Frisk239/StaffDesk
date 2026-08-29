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
  error?: string;
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

const INSTALL_HINT =
  '本机没有可用的检索适配。请安装 Agent Reach（agent-reach / mcporter），然后重试。';

function runCommand(
  spawnFn: SpawnFn,
  command: string,
  args: string[],
  timeoutMs = 20_000,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawnFn(command, args, { shell: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('超时'));
    }, timeoutMs);
    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

export function createReachAdapter(spawnFn: SpawnFn = spawn): ReachAdapter {
  return {
    async doctor() {
      try {
        const r = await runCommand(spawnFn, 'agent-reach', ['doctor', '--json'], 8000);
        if (r.code === 0) {
          return { ok: true, detail: r.stdout.trim() || 'agent-reach 可用' };
        }
        return { ok: false, detail: r.stderr || r.stdout, hint: INSTALL_HINT };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, detail: msg, hint: INSTALL_HINT };
      }
    },
    async search(query: string) {
      try {
        const r = await runCommand(spawnFn, 'mcporter', ['call', 'exa.web_search_exa', query], 25_000);
        const parsed = parseHits(r.stdout);
        if (parsed.length > 0) return parsed;
        throw new Error(r.stderr || '没有检索命中');
      } catch {
        const fallback = await openViaJinaSearch(query);
        return fallback;
      }
    },
    async open(url: string) {
      try {
        const reader = `https://r.jina.ai/${url}`;
        const res = await fetch(reader, { headers: { Accept: 'text/plain' } });
        if (!res.ok) {
          return { url, ok: false, body: '', error: `打开失败 HTTP ${res.status}` };
        }
        const body = (await res.text()).slice(0, 20_000);
        return { url, ok: true, body };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { url, ok: false, body: '', error: msg };
      }
    },
  };
}

function parseHits(stdout: string): SearchHit[] {
  try {
    const json: unknown = JSON.parse(stdout);
    const rows = Array.isArray(json)
      ? json
      : typeof json === 'object' && json && 'results' in json
        ? (json as { results: unknown }).results
        : [];
    if (!Array.isArray(rows)) return [];
    return rows
      .map((row) => {
        const r = row as { title?: string; url?: string; snippet?: string; text?: string };
        return {
          title: r.title ?? r.url ?? '',
          url: r.url ?? '',
          snippet: r.snippet ?? r.text ?? '',
        };
      })
      .filter((h) => Boolean(h.url));
  } catch {
    return [];
  }
}

async function openViaJinaSearch(query: string): Promise<SearchHit[]> {
  void query;
  return [];
}

export const UNAVAILABLE_ADAPTER: ReachAdapter = {
  async doctor() {
    return { ok: false, detail: '未配置检索适配', hint: INSTALL_HINT };
  },
  async search() {
    return [];
  },
  async open(url: string) {
    return { url, ok: false, body: '', error: INSTALL_HINT };
  },
};

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

/** 单路体检结论：红路只描述自己，不挡别的路（0061）。 */
export interface PathDoctor {
  ok: boolean;
  detail: string;
  hint?: string | undefined;
}

export interface PathDoctorResult extends PathDoctor {
  name: ReachPathName;
}

/** 聚合体检：任一路绿即 ok；paths 逐路红绿，引擎据此决定扇出哪些路（0061）。 */
export interface DoctorResult extends PathDoctor {
  paths: PathDoctorResult[];
}

/** 0061：检索路 = 零配置工具；登录态平台（Cookie/令牌）不进 v1，名字即审计文案。 */
export type ReachPathName = 'Exa' | 'GitHub';

export interface ReachPath {
  name: ReachPathName;
  doctorCheck: () => Promise<PathDoctor>;
  search: (query: string) => Promise<SearchHit[]>;
}

export interface ReachAdapter {
  /** 多路清单（0061）：每路独立体检、独立搜索；open 不分路。 */
  paths: ReachPath[];
  doctor: () => Promise<DoctorResult>;
  open: (url: string) => Promise<OpenResult>;
}

export type SpawnFn = typeof spawn;
export type FetchFn = typeof fetch;

// 审计 D1（2026-09-02）：fetch 网络路必须限时——任务墙钟只在步间判（engine capHit），
// fetch 挂死会让 allSettled / safeOpen 永久悬挂。search 对齐 Exa spawn 的 25s、open 对齐
// runCommand 默认的 20s。毫秒数经依赖注入仅为单测提速，产品口径不动。
export interface ReachTimeouts {
  githubSearchMs?: number | undefined;
  jinaOpenMs?: number | undefined;
}

const GITHUB_SEARCH_TIMEOUT_MS = 25_000;
const JINA_OPEN_TIMEOUT_MS = 20_000;

/** AbortSignal.timeout 到点在 Node 里抛 TimeoutError，人工 abort 抛 AbortError；两处都算限时。 */
function isTimeoutLike(err: unknown): boolean {
  return err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
}

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

function createExaPath(spawnFn: SpawnFn): ReachPath {
  return {
    name: 'Exa',
    async doctorCheck() {
      try {
        const r = await runCommand(spawnFn, executable('agent-reach'), ['doctor', '--json'], 8000);
        if (r.code === 0) {
          return { ok: true, detail: compact(r.stdout.trim() || 'agent-reach 可用') };
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
  };
}

// 0061：GitHub 路走匿名 REST（search/repositories，10 次/分钟）——机器红利（gh CLI 登录态、
// mcporter github server 凭据）不得进产品路径；限速/断网在搜索时按路记失败，不编造命中（0008）。
function createGitHubPath(fetchFn: FetchFn, searchTimeoutMs: number): ReachPath {
  return {
    name: 'GitHub',
    async doctorCheck() {
      // 匿名零配置、无本机依赖可查：体检恒绿；真失败（断网/限速）由搜索阶段按路审计。
      return { ok: true, detail: 'GitHub 公开仓库搜索（匿名，免配置）' };
    },
    async search(query: string) {
      const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&per_page=5`;
      let res: Response;
      try {
        res = await fetchFn(url, {
          headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'StaffDesk' },
          // 审计 D1：挂死的搜索必须限时折错，不许让任务的 allSettled 永久悬挂。
          signal: AbortSignal.timeout(searchTimeoutMs),
        });
      } catch (err) {
        if (isTimeoutLike(err)) {
          throw new ReachError(`GitHub 搜索超时（${Math.round(searchTimeoutMs / 1000)} 秒）`);
        }
        throw new ReachError(
          compact(err instanceof Error ? err.message : String(err)) || 'GitHub 搜索网络错误',
        );
      }
      if (res.status === 403 || res.status === 429) {
        throw new ReachError(`GitHub 匿名额度用尽（HTTP ${res.status}）`);
      }
      if (!res.ok) {
        throw new ReachError(`GitHub 搜索失败（HTTP ${res.status}）`);
      }
      return parseGitHubItems(res);
    },
  };
}

async function parseGitHubJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    throw new ReachError('GitHub 返回不是 JSON');
  }
}

async function parseGitHubItems(res: Response): Promise<SearchHit[]> {
  const json = await parseGitHubJson(res);
  const items =
    typeof json === 'object' && json && 'items' in json
      ? (json as { items?: unknown }).items
      : undefined;
  if (!Array.isArray(items)) throw new ReachError('GitHub 返回缺少 items 数组');
  return items
    .map((item) => {
      const repo = item as { full_name?: unknown; html_url?: unknown; description?: unknown };
      const url = typeof repo.html_url === 'string' ? repo.html_url : '';
      return {
        title: typeof repo.full_name === 'string' && repo.full_name ? repo.full_name : url,
        url,
        snippet: typeof repo.description === 'string' ? repo.description : '',
      };
    })
    .filter((hit) => Boolean(hit.url));
}

/** 0061：聚合体检——逐路红绿，红路不挡绿路；全红才整体失败并给安装引导。 */
async function aggregateDoctor(paths: readonly ReachPath[]): Promise<DoctorResult> {
  const results = await Promise.all(
    paths.map(async (path): Promise<PathDoctorResult> => {
      try {
        return { name: path.name, ...(await path.doctorCheck()) };
      } catch (err) {
        return {
          name: path.name,
          ok: false,
          detail: compact(err instanceof Error ? err.message : String(err)),
        };
      }
    }),
  );
  const ok = results.some((r) => r.ok);
  const detail = results
    .map((r) => `${r.name} ${r.ok ? '可用' : '不可用'}：${r.detail}`)
    .join('；');
  return ok
    ? { ok: true, detail, paths: results }
    : { ok: false, detail, paths: results, hint: INSTALL_HINT };
}

export function createReachAdapter(
  spawnFn: SpawnFn = spawn,
  fetchFn: FetchFn = fetch,
  timeouts: ReachTimeouts = {},
): ReachAdapter {
  // e2e 隔离机没有 Agent Reach；费用触顶 spec 走罐头检索，不触外网。
  if (process.env.STAFFDESK_E2E_REACH === '1') return createE2eReachAdapter();
  const paths: ReachPath[] = [
    createExaPath(spawnFn),
    createGitHubPath(fetchFn, timeouts.githubSearchMs ?? GITHUB_SEARCH_TIMEOUT_MS),
  ];
  return {
    paths,
    doctor: () => aggregateDoctor(paths),
    async open(url: string) {
      return openViaJinaReader(fetchFn, url, timeouts.jinaOpenMs ?? JINA_OPEN_TIMEOUT_MS);
    },
  };
}

async function openViaJinaReader(
  fetchFn: FetchFn,
  url: string,
  openTimeoutMs: number,
): Promise<OpenResult> {
  try {
    const reader = `https://r.jina.ai/${url}`;
    const res = await fetchFn(reader, {
      headers: { Accept: 'text/plain' },
      // 审计 D1：挂死的打开必须限时折失败（与 HTTP 非 200 同形状），不许让 safeOpen 永久悬挂。
      signal: AbortSignal.timeout(openTimeoutMs),
    });
    if (!res.ok) {
      return { url, ok: false, body: '', error: `打开失败 HTTP ${res.status}` };
    }
    const body = (await res.text()).trim().slice(0, 40_000);
    if (!body) return { url, ok: false, body: '', error: '打开后正文为空' };
    return { url, ok: true, body, finalUrl: url };
  } catch (err) {
    if (isTimeoutLike(err)) {
      return {
        url,
        ok: false,
        body: '',
        error: `打开超时（${Math.round(openTimeoutMs / 1000)} 秒）`,
      };
    }
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
  paths: [],
  async doctor() {
    return { ok: false, detail: '未配置检索适配', hint: INSTALL_HINT, paths: [] };
  },
  async open(url: string) {
    return { url, ok: false, body: '', error: INSTALL_HINT };
  },
};

// e2e 罐头双路：Exa 两命中 + GitHub 两命中（其中一条与 Exa 同 URL，验证去重）。
// STAFFDESK_E2E_REACH_FAIL 指定路名（如 'GitHub'）让该路搜索恒失败，验证单路失败另一路照常。
// STAFFDESK_E2E_REACH_HANG（审计 D1）指定 'search' | 'open' 返回永不 settle 的 promise，
// 验证真实适配器的 AbortSignal.timeout 能把挂死的任务限时收口（罐头自身不超时）。
function createE2eReachAdapter(): ReachAdapter {
  const exaHits: SearchHit[] = [
    { title: '费用触顶来源甲', url: 'https://e2e.staffdesk.test/a', snippet: '主栈是 Rust' },
    { title: '费用触顶来源乙', url: 'https://e2e.staffdesk.test/b', snippet: '融资轮次为 A 轮' },
  ];
  const githubHits: SearchHit[] = [
    { title: '费用触顶来源甲', url: 'https://e2e.staffdesk.test/a', snippet: '镜像命中，应被去重' },
    { title: '费用触顶来源丙', url: 'https://e2e.staffdesk.test/c', snippet: '团队规模 20 人' },
  ];
  const failPath = process.env.STAFFDESK_E2E_REACH_FAIL;
  const hang = process.env.STAFFDESK_E2E_REACH_HANG;
  const paths: ReachPath[] = [
    {
      name: 'Exa',
      doctorCheck: async () => ({ ok: true, detail: 'e2e exa' }),
      search: async () => {
        if (failPath === 'Exa') throw new ReachError('Exa e2e 故障注入');
        if (hang === 'search') return new Promise<SearchHit[]>(() => {});
        return exaHits;
      },
    },
    {
      name: 'GitHub',
      doctorCheck: async () => ({ ok: true, detail: 'e2e github' }),
      search: async () => {
        if (failPath === 'GitHub') throw new ReachError('GitHub 匿名额度用尽（HTTP 403）');
        if (hang === 'search') return new Promise<SearchHit[]>(() => {});
        return githubHits;
      },
    },
  ];
  return {
    paths,
    doctor: () => aggregateDoctor(paths),
    async open(url: string) {
      if (hang === 'open') return new Promise<OpenResult>(() => {});
      const hit = [...exaHits, ...githubHits].find((item) => item.url === url) ?? exaHits[0];
      const body = url.endsWith('/a')
        ? '费用触顶组织主栈是 Rust。'
        : url.endsWith('/b')
          ? '费用触顶组织融资轮次为 A 轮。'
          : '费用触顶组织团队规模 20 人。';
      return { url, ok: true, body, finalUrl: url, title: hit?.title ?? url };
    },
  };
}

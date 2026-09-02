import type { Claim, DeskObject, Source, SourceRole, State } from './types';

/** 0062：绑定级角色，缺省转述。同一来源对不同对象可不同。 */
export function bindingRole(source: Source, objectId: string): SourceRole {
  return source.bindingRoles?.[objectId] ?? '转述';
}

/** 0062：只记录显式主键；转述从 map 里拿掉，避免把默认值写成数据。 */
export function withBindingRole(source: Source, objectId: string, role: SourceRole): Source {
  const current = { ...source.bindingRoles };
  if (role === '转述') delete current[objectId];
  else current[objectId] = role;
  const bindingRoles = Object.keys(current).length > 0 ? current : undefined;
  return { ...source, bindingRoles };
}

export function dropBindingRole(source: Source, objectId: string): Source {
  return withBindingRole(source, objectId, '转述');
}

const URL_RE = /https?:\/\/[^\s<>"']+/gi;

function hostnameOf(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    let host = url.hostname.toLowerCase();
    if (host.startsWith('www.')) host = host.slice(4);
    if (!host.includes('.')) return null;
    if (!/^[a-z0-9.-]+$/.test(host)) return null;
    if (!/[a-z]/.test(host)) return null;
    return host;
  } catch {
    return null;
  }
}

function hostnamesInText(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const match of text.match(URL_RE) ?? []) {
    const host = hostnameOf(match);
    if (!host || seen.has(host)) continue;
    seen.add(host);
    out.push(host);
  }
  return out;
}

/** 来源域名：只看出处 URL（finalUrl / locator）和本身就是 URL 的标题。宁可漏、不误标。 */
export function sourceHostname(source: Source): string | null {
  const fromOrigin =
    hostnameOf(source.origin?.finalUrl ?? '') ?? hostnameOf(source.origin?.locator ?? '');
  if (fromOrigin) return fromOrigin;
  const title = source.title.trim();
  if (/^https?:\/\//i.test(title)) return hostnameOf(title);
  return null;
}

/**
 * 0062 启发式输入：对象「官网/主页」线索。现有模型没有官网字段，只收：
 * 对象名本身是域名、备注里的 http(s) URL、该对象成立主张正文里的 http(s) URL。
 * 不用名称子串去撞二级域名（「Go」对 go.dev 会误伤）。
 */
export function objectOfficialHostnames(object: DeskObject, claims: Claim[]): string[] {
  const seen = new Set<string>();
  const add = (host: string | null) => {
    if (!host || seen.has(host)) return;
    seen.add(host);
  };
  add(hostnameOf(object.name));
  if (object.note) {
    for (const host of hostnamesInText(object.note)) add(host);
    add(hostnameOf(object.note));
  }
  for (const claim of claims) {
    if (claim.objectId !== object.id || claim.status !== '成立') continue;
    for (const host of hostnamesInText(claim.text)) add(host);
  }
  return [...seen];
}

/** 0062：域名一致才建议；永不自动写角色。 */
export function shouldSuggestPrimary(source: Source, object: DeskObject, claims: Claim[]): boolean {
  const host = sourceHostname(source);
  if (!host) return false;
  return objectOfficialHostnames(object, claims).includes(host);
}

export function isPrimaryBacked(state: State, claim: Claim): boolean {
  if (claim.sourceId === 'user-stmt') return false;
  const source = state.sources.find((item) => item.id === claim.sourceId);
  if (!source) return false;
  return bindingRole(source, claim.objectId) === '主键';
}

/**
 * 0062 守护不变量（测试断言用，非运行时闸）：prev→next 之后，原先成立且由主键绑定
 * 背书的主张不再成立。自动路径（抽取落账、调研写入、绑定时建议）的测试必须断言空数组；
 * 人确认关窗（新版过时提议）不在此列。
 */
export function primaryBackedClaimsNoLongerLive(prev: State, next: State): Claim[] {
  return prev.claims.filter((claim) => {
    if (claim.status !== '成立' || !isPrimaryBacked(prev, claim)) return false;
    const after = next.claims.find((item) => item.id === claim.id);
    return !after || after.status === '过时';
  });
}

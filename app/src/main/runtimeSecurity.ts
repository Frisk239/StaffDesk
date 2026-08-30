import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  shell,
  type BrowserWindow,
  type IpcMainInvokeEvent,
  type WindowOpenHandlerResponse,
} from 'electron';

export type RuntimeSecurityPolicy = {
  rendererFilePath: string;
  rendererFileUrl: string;
  trustedDevOrigin: string | null;
};

type OpenExternal = typeof shell.openExternal;

const LOCAL_DEV_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export function createRuntimeSecurityPolicy(options: {
  rendererFilePath: string;
  devServerUrl?: string | undefined;
}): RuntimeSecurityPolicy {
  const rendererFilePath = normalizeFilePath(options.rendererFilePath);
  return {
    rendererFilePath,
    rendererFileUrl: pathToFileURL(rendererFilePath).href,
    trustedDevOrigin: trustedDevOrigin(options.devServerUrl),
  };
}

export function trustedRendererDevServerUrl(rawUrl: string | undefined): string | null {
  const parsed = parseUrl(rawUrl);
  if (!parsed || !isLocalHttpUrl(parsed)) return null;
  return parsed.href;
}

export function isTrustedAppUrl(rawUrl: string, policy: RuntimeSecurityPolicy): boolean {
  const parsed = parseUrl(rawUrl);
  if (!parsed) return false;
  if (parsed.protocol === 'file:') {
    return isTrustedRendererFileUrl(parsed, policy);
  }
  return (
    policy.trustedDevOrigin !== null &&
    isLocalHttpUrl(parsed) &&
    parsed.origin === policy.trustedDevOrigin
  );
}

export function isAllowedExternalOpenUrl(rawUrl: string): boolean {
  return normalizeAllowedExternalOpenUrl(rawUrl) !== null;
}

export function normalizeAllowedExternalOpenUrl(rawUrl: string): string | null {
  const parsed = parseUrl(rawUrl);
  if (parsed?.protocol !== 'http:' && parsed?.protocol !== 'https:') return null;
  return parsed.href;
}

export function handleWindowOpenUrl(
  rawUrl: string,
  policy?: RuntimeSecurityPolicy,
  openExternal?: OpenExternal,
): WindowOpenHandlerResponse {
  if (!policy || !isTrustedAppUrl(rawUrl, policy)) openExternalIfAllowed(rawUrl, openExternal);
  return { action: 'deny' };
}

export function installRuntimeSecurity(
  win: BrowserWindow,
  policy: RuntimeSecurityPolicy,
  openExternal?: OpenExternal,
): void {
  win.webContents.setWindowOpenHandler((details) =>
    handleWindowOpenUrl(details.url, policy, openExternal),
  );
  win.webContents.on('will-navigate', (event, url) => {
    if (!isTrustedAppUrl(url, policy)) {
      event.preventDefault();
      openExternalIfAllowed(url, openExternal);
    }
  });
  win.webContents.on('will-attach-webview', (event) => {
    event.preventDefault();
    console.warn('webview blocked by runtime policy');
  });
  win.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
}

export function assertTrustedIpcSender(
  event: IpcMainInvokeEvent,
  win: BrowserWindow | null,
  policy: RuntimeSecurityPolicy,
): void {
  if (!win || event.sender.id !== win.webContents.id) {
    throw new Error('拒绝非主窗口请求');
  }
  const frameUrl = event.senderFrame?.url;
  if (!frameUrl || !isTrustedAppUrl(frameUrl, policy)) {
    throw new Error('拒绝非应用页面请求');
  }
}

function openExternalIfAllowed(
  rawUrl: string,
  openExternal: OpenExternal = shell.openExternal,
): void {
  const normalized = normalizeAllowedExternalOpenUrl(rawUrl);
  if (normalized) {
    void openExternal(normalized).catch((error) => {
      console.warn('external open denied by system', safeLogDetail(error));
    });
  } else {
    console.warn('external open blocked by runtime policy', safeLogUrl(rawUrl));
  }
}

function isTrustedRendererFileUrl(url: URL, policy: RuntimeSecurityPolicy): boolean {
  const filePath = normalizeFilePath(fileURLToPath(url));
  return filePath === policy.rendererFilePath;
}

function trustedDevOrigin(rawUrl: string | undefined): string | null {
  const parsed = parseUrl(rawUrl);
  return parsed && isLocalHttpUrl(parsed) ? parsed.origin : null;
}

function isLocalHttpUrl(url: URL): boolean {
  return (
    (url.protocol === 'http:' || url.protocol === 'https:') && LOCAL_DEV_HOSTS.has(url.hostname)
  );
}

function parseUrl(rawUrl: string | undefined): URL | null {
  if (!rawUrl) return null;
  try {
    return new URL(rawUrl);
  } catch {
    return null;
  }
}

function normalizeFilePath(path: string): string {
  const normalized = resolve(path);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function safeLogUrl(rawUrl: string): string {
  return rawUrl.replace(/sk-[A-Za-z0-9_-]+/g, 'sk-***').slice(0, 200);
}

function safeLogDetail(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/Bearer\s+\S+/gi, 'Bearer ***')
    .replace(/sk-[A-Za-z0-9_-]+/g, 'sk-***')
    .slice(0, 200);
}

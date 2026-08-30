import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import {
  assertTrustedIpcSender,
  createRuntimeSecurityPolicy,
  handleWindowOpenUrl,
  isAllowedExternalOpenUrl,
  isTrustedAppUrl,
  normalizeAllowedExternalOpenUrl,
  trustedRendererDevServerUrl,
} from '../../src/main/runtimeSecurity';

function rendererPath(): string {
  return join(tmpdir(), 'staffdesk-security-test', 'out', 'renderer', 'index.html');
}

function fakeWindow(id: number): BrowserWindow {
  return { webContents: { id } } as unknown as BrowserWindow;
}

function fakeInvokeEvent(senderId: number, frameUrl: string | null): IpcMainInvokeEvent {
  return {
    sender: { id: senderId },
    senderFrame: frameUrl === null ? null : { url: frameUrl },
  } as unknown as IpcMainInvokeEvent;
}

describe('Electron 运行时安全边界', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('只信任打包 renderer 文件和本机开发服务器', () => {
    const file = rendererPath();
    const policy = createRuntimeSecurityPolicy({
      rendererFilePath: file,
      devServerUrl: 'http://localhost:5173/',
    });

    expect(isTrustedAppUrl(pathToFileURL(file).href, policy)).toBe(true);
    expect(isTrustedAppUrl(`${pathToFileURL(file).href}#/settings`, policy)).toBe(true);
    expect(
      isTrustedAppUrl(
        pathToFileURL(
          join(tmpdir(), 'staffdesk-security-test', 'out', 'renderer', 'assets', 'index.js'),
        ).href,
        policy,
      ),
    ).toBe(false);
    expect(isTrustedAppUrl('http://localhost:5173/src/main.tsx', policy)).toBe(true);
    expect(isTrustedAppUrl('http://127.0.0.1:5173/src/main.tsx', policy)).toBe(false);
    expect(isTrustedAppUrl('https://example.com/', policy)).toBe(false);
    expect(isTrustedAppUrl(pathToFileURL(join(tmpdir(), 'other.html')).href, policy)).toBe(false);
  });

  it('开发服务器必须是本机地址，远端 ELECTRON_RENDERER_URL 不进入可信集合', () => {
    expect(trustedRendererDevServerUrl('http://localhost:5173/')).toBe('http://localhost:5173/');
    expect(trustedRendererDevServerUrl('http://127.0.0.1:5173/')).toBe('http://127.0.0.1:5173/');
    expect(trustedRendererDevServerUrl('https://example.com/app')).toBeNull();
    expect(trustedRendererDevServerUrl('file:///tmp/index.html')).toBeNull();
  });

  it('系统浏览器出站只允许 http/https，且不在应用内创建新窗口', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const opened: string[] = [];
    const openExternal = async (url: string) => {
      opened.push(url);
    };

    expect(handleWindowOpenUrl('https://example.com/a?b=1', undefined, openExternal)).toEqual({
      action: 'deny',
    });
    expect(handleWindowOpenUrl('http://example.com/', undefined, openExternal)).toEqual({
      action: 'deny',
    });
    expect(handleWindowOpenUrl('file:///etc/passwd', undefined, openExternal)).toEqual({
      action: 'deny',
    });
    expect(handleWindowOpenUrl('javascript:alert(1)', undefined, openExternal)).toEqual({
      action: 'deny',
    });
    await Promise.resolve();

    expect(opened).toEqual(['https://example.com/a?b=1', 'http://example.com/']);
    expect(isAllowedExternalOpenUrl('https://example.com/a')).toBe(true);
    expect(isAllowedExternalOpenUrl('http://example.com/a')).toBe(true);
    expect(isAllowedExternalOpenUrl('data:text/html,blocked')).toBe(false);
    expect(normalizeAllowedExternalOpenUrl('HTTPS://EXAMPLE.COM/a')).toBe('https://example.com/a');
  });

  it('IPC 只接受主窗口可信 app frame', () => {
    const file = rendererPath();
    const policy = createRuntimeSecurityPolicy({ rendererFilePath: file });
    const trustedFrame = pathToFileURL(file).href;

    expect(() =>
      assertTrustedIpcSender(fakeInvokeEvent(7, trustedFrame), fakeWindow(7), policy),
    ).not.toThrow();
    expect(() =>
      assertTrustedIpcSender(fakeInvokeEvent(8, trustedFrame), fakeWindow(7), policy),
    ).toThrow('拒绝非主窗口请求');
    expect(() =>
      assertTrustedIpcSender(fakeInvokeEvent(7, 'https://example.com/'), fakeWindow(7), policy),
    ).toThrow('拒绝非应用页面请求');
    expect(() => assertTrustedIpcSender(fakeInvokeEvent(7, null), fakeWindow(7), policy)).toThrow(
      '拒绝非应用页面请求',
    );
  });
});

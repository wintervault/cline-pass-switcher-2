/**
 * 单测的全局护栏：禁止测试意外打真实外网。
 * 代理打的是第三方实时网关，一次误发就是真实扣费，所以默认封死；
 * 但放行 localhost——测试自己起的 HTTP 服务需要被访问。
 * 需要模拟上游响应的测试用 vi.stubGlobal('fetch', ...) 显式替换。
 */
import { beforeEach, vi } from 'vitest';

const realFetch = globalThis.fetch;
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export function hostOf(input: unknown): string {
  const url =
    typeof input === 'string' ? input : input instanceof URL ? input.href : ((input as { url?: string })?.url ?? '');
  try {
    return new URL(url, 'http://localhost').hostname;
  } catch {
    return '';
  }
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown, init?: unknown) => {
      const host = hostOf(input);
      if (host && !LOCAL_HOSTS.has(host)) {
        throw new Error(`单测禁止真实外网请求（${host}）。如需模拟上游响应，请显式 vi.stubGlobal('fetch', ...) 替换。`);
      }
      return realFetch(input as Parameters<typeof realFetch>[0], init as Parameters<typeof realFetch>[1]);
    }),
  );
});

export { realFetch };

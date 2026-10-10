import http from 'node:http';

export interface TestResponse {
  status: number;
  body: string;
  json: <T = unknown>() => T;
  headers: http.IncomingHttpHeaders;
}

/** 用 node:http 发请求（而非 fetch），这样测试自身不依赖被护栏替换的全局 fetch。 */
export function request(
  port: number,
  path: string,
  options: { method?: string; body?: unknown; headers?: Record<string, string>; timeoutMs?: number } = {},
): Promise<TestResponse> {
  const timeoutMs = options.timeoutMs ?? 3000;
  return new Promise((resolve, reject) => {
    const payload = options.body === undefined ? null : JSON.stringify(options.body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: options.method ?? 'GET',
        headers: {
          ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
          ...options.headers,
        },
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          data += chunk;
        });
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: data,
            headers: res.headers,
            json: <T = unknown>() => JSON.parse(data) as T,
          }),
        );
      },
    );
    // 没有超时的话，「连接被接受但服务端从不响应」会让测试挂到 vitest 超时，排查困难
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`请求超时（${timeoutMs}ms）：${options.method ?? 'GET'} ${path}`));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** 起一个监听随机端口的小服务，返回端口与关闭函数。 */
export async function listen(server: http.Server): Promise<{ port: number; close: () => Promise<void> }> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('无法取得监听端口');
  return {
    port: address.port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 手动控制何时兑现的 Promise（用于卡住一个请求观察关闭行为）。 */
export function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  const box: { resolve: (value: T) => void } = { resolve: () => {} };
  const promise = new Promise<T>((resolve) => {
    box.resolve = resolve;
  });
  return { promise, resolve: (value: T) => box.resolve(value) };
}

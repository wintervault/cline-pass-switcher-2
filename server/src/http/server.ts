import http from 'node:http';

import { logger } from '../log/logger.ts';
import { sendError } from './respond.ts';
import { type Ctx, compose, type Handler, type Middleware } from './router.ts';

const log = logger.child({ module: 'http' });

export interface CreateHttpServerOptions {
  handler: Handler;
  middleware?: readonly Middleware[];
  /** 这个 listener 属于哪个网关（注入到每个请求的 Ctx）。 */
  gatewayId: string;
}

export function createHttpServer(options: CreateHttpServerOptions): http.Server {
  const composed = compose(options.middleware ?? [], options.handler);

  const server = http.createServer((req, res) => {
    // 固定 base：只取 pathname/searchParams，不信任 Host 头
    const url = new URL(req.url ?? '/', 'http://localhost');
    // 客户端提前断开 → 中止信号。注意 res 'close' 在正常结束时也会触发，
    // 必须用 writableEnded 区分「正常完成」与「客户端中途跑了」
    const abortController = new AbortController();
    const onResClose = () => {
      if (!res.writableEnded) abortController.abort(new Error('client disconnected'));
    };
    res.on('close', onResClose);
    const ctx: Ctx = {
      req,
      res,
      url,
      method: req.method ?? 'GET',
      path: url.pathname,
      gatewayId: options.gatewayId,
      abortSignal: abortController.signal,
    };

    void composed(ctx).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ err, method: ctx.method, path: ctx.path }, '请求处理异常');
      if (res.headersSent) {
        res.end();
        return;
      }
      sendError(res, 500, message, 'server_error');
    });
  });

  // 流式响应需要长连接；headersTimeout 必须大于 keepAliveTimeout
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 70_000;

  return server;
}

export interface ShutdownOptions {
  /** 等在途请求结束的最长时间（毫秒）。 */
  graceMs?: number;
  /** 关闭时的额外清理（落盘等）。 */
  onClose?: () => Promise<void> | void;
}

/**
 * 优雅退出：停止接受新连接 → 等在途请求结束（超时则强制断开）→ 落盘。
 *
 * 不做优雅退出的话，容器收到 SIGTERM 会立刻杀进程，正在进行的原子写可能停在
 * 「临时文件已写、rename 未执行」的中间态——虽然有原子写兜底不会损坏文件，
 * 但内存里最后一次变更会丢。
 */
export async function shutdownServer(server: http.Server, options: ShutdownOptions = {}): Promise<void> {
  const graceMs = options.graceMs ?? 30_000;

  const closed = new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  // 已建立但空闲的 keep-alive 连接不会自己关，主动断开
  server.closeIdleConnections();

  // 客户端可能持有 keep-alive：请求处理完后连接只是「变空闲」，不会自动关闭，
  // 而 server.close() 会一直等它。只调用一次 closeIdleConnections() 不够——那时它还在飞。
  // 定期回收，否则关闭会被这类连接拖满整个宽限期。
  const sweep = setInterval(() => server.closeIdleConnections(), 100);
  sweep.unref?.();

  const forced = setTimeout(() => {
    log.warn({ graceMs }, '在途请求未在宽限期内结束，强制断开剩余连接');
    server.closeAllConnections();
  }, graceMs);
  forced.unref?.();

  await closed;
  clearTimeout(forced);
  clearInterval(sweep);

  await options.onClose?.();
}

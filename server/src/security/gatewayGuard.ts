import { gatewayById } from '../config/derive.ts';
import type { Config } from '../config/schema.ts';
import { sendError } from '../http/respond.ts';
import type { Middleware } from '../http/router.ts';

/**
 * 网关存活守卫。
 *
 * 网关刚被删除、而它的 listener 还没关完的那一小段时间里，配置里已经找不到它。
 * 这时如果照常往下走，鉴权读到的是空 proxyKey → 按「不鉴权」放行，等于一个短暂的
 * 裸奔窗口。所以先确认网关仍然存在，否则直接 503（这个 listener 马上也会被关掉）。
 */
export function gatewayAliveGuard(config: () => Config): Middleware {
  return async (ctx, next) => {
    if (!gatewayById(config(), ctx.gatewayId)) {
      sendError(ctx.res, 503, 'gateway unavailable', 'gateway_error', 'gateway.notFound');
      return;
    }
    await next();
  };
}

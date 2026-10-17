import { sendError } from '../http/respond.ts';
import type { Ctx, Middleware } from '../http/router.ts';
import { safeEqual } from './compare.ts';
import { isTrustedLocal } from './local.ts';

export interface AuthOptions {
  /** 该路径是否需要密钥（静态页面永远不需要——它不含任何敏感数据）。 */
  needsAuth: (path: string) => boolean;
  /**
   * 该路径是否属于「控制台」（可被本机免密钥放行）。
   * 下游代理端点（`/v1/*`）**不在此列**：客户端无论从哪来都得带密钥，
   * 那正是密钥存在的意义。
   */
  consolePath: (path: string) => boolean;
  /** 可注入，便于测试。 */
  isLocal?: (req: Ctx['req']) => boolean;
}

/**
 * 下游代理密钥鉴权。
 *
 * 两档放行：
 * 1. **本机访问控制台**（回环对端 + 回环 Host）→ 直接放行，不需要任何密钥。
 *    控制台是机器主人的工具，本机用户就是最高权限；用下发给客户端的密钥去锁控制台
 *    会把主人自己锁在门外（忘了密钥就是死循环，v2.9.2 的真实反馈）。
 * 2. 其余请求按路径判定：`/v1/*`（下游契约）与远端访问的控制台 API 都要密钥。
 *
 * 未设置密钥时一律放行——启动闸门（security/bind.ts）已保证「绑定非回环却没有密钥」
 * 根本起不来，所以那种状态只可能是本机自用。
 *
 * 比较用恒定时间函数：直接 `===` 会在首个不同字符短路，可被逐字节计时猜出。
 */
export function authMiddleware(getProxyKey: (ctx: Ctx) => string, options: AuthOptions): Middleware {
  const isLocal = options.isLocal ?? isTrustedLocal;
  return async (ctx, next) => {
    if (!options.needsAuth(ctx.path)) return next();
    // 本机访问控制台 = 最高权限，不看密钥
    if (options.consolePath(ctx.path) && isLocal(ctx.req)) return next();

    const key = getProxyKey(ctx);
    if (!key) return next();

    const bearer = String(ctx.req.headers['authorization'] ?? '')
      .replace(/^Bearer\s+/i, '')
      .trim();
    const admin = String(ctx.req.headers['x-admin-key'] ?? '').trim();
    if ((bearer && safeEqual(bearer, key)) || (admin && safeEqual(admin, key))) return next();

    // 这句是给 OpenAI 兼容客户端看的（代理端点），用英文；控制台自己的 401
    // 由 access gate 处理，不依赖这段文案
    sendError(ctx.res, 401, 'unauthorized: missing or invalid API key', 'auth_error');
  };
}

/**
 * 本地 CSRF / DNS-rebinding 防护。
 *
 * 旧版所有响应都带 `Access-Control-Allow-Origin: *`，用户浏览器里任意网页都能
 * 跨域读写 127.0.0.1:3123 的 API。现在：
 * - 默认不发 CORS 头（同源访问本来就不需要）；
 * - 带 Origin 的状态变更请求必须是同源（Origin.host === Host）或在白名单里；
 * - 不带 Origin 的是非浏览器客户端（curl / Cline 扩展），放行。
 */
export function originCheckMiddleware(getAllowed: (ctx: Ctx) => string[]): Middleware {
  return async (ctx, next) => {
    const origin = ctx.req.headers.origin;
    if (!origin) return next();

    const allowed = getAllowed(ctx);
    if (allowed.includes(origin)) return next();

    // 同源请求：Origin 的 host:port 与 Host 头一致
    try {
      const originHost = new URL(origin).host;
      const hostHeader = String(ctx.req.headers['host'] ?? '');
      if (hostHeader && originHost === hostHeader) return next();
    } catch {
      /* 非法 Origin，按跨源处理 */
    }

    if (ctx.method === 'OPTIONS') {
      // 预检失败也要给个明确响应
      sendError(ctx.res, 403, 'origin not allowed', 'origin_error');
      return;
    }
    sendError(ctx.res, 403, `cross-origin request blocked: ${origin}`, 'origin_error');
  };
}

/**
 * CORS 响应头：仅在白名单命中时回显 Origin。
 * 命中白名单意味着站点是我们明确放行的，可以回显以支持浏览器调用。
 */
export function corsResponseHeaders(getAllowed: (ctx: Ctx) => string[]): Middleware {
  return async (ctx, next) => {
    const origin = ctx.req.headers.origin;
    const allowed = getAllowed(ctx);
    if (origin && allowed.includes(origin)) {
      ctx.res.setHeader('Access-Control-Allow-Origin', origin);
      ctx.res.setHeader('Vary', 'Origin');
      ctx.res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
      ctx.res.setHeader('Access-Control-Allow-Headers', 'Authorization,X-Admin-Key,Content-Type');
    }
    if (ctx.method === 'OPTIONS' && origin && allowed.includes(origin)) {
      ctx.res.writeHead(204);
      ctx.res.end();
      return;
    }
    return next();
  };
}

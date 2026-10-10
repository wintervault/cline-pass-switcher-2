import { sendError } from '../http/respond.ts';
import type { Middleware } from '../http/router.ts';
import { safeEqual } from './compare.ts';

/**
 * 下游代理密钥鉴权。未设置密钥 = 不鉴权（启动闸门已保证这种配置只可能出现在回环地址）。
 * 比较用恒定时间函数——直接 `===` 会在首个不同字符短路，可被逐字节计时猜出。
 *
 * 只保护 API 路径（由 needsAuth 判定）：控制台页面本身保持开放——它不含任何敏感数据，
 * 数据由带鉴权的 /api/* 提供；页面也被拦的话连登录框都加载不出来。
 */
export function authMiddleware(getProxyKey: () => string, needsAuth: (path: string) => boolean): Middleware {
  return async (ctx, next) => {
    const key = getProxyKey();
    if (!key) return next();
    if (!needsAuth(ctx.path)) return next();

    const bearer = String(ctx.req.headers['authorization'] ?? '')
      .replace(/^Bearer\s+/i, '')
      .trim();
    const admin = String(ctx.req.headers['x-admin-key'] ?? '').trim();
    if ((bearer && safeEqual(bearer, key)) || (admin && safeEqual(admin, key))) return next();

    sendError(ctx.res, 401, 'unauthorized: 代理密钥缺失或错误', 'auth_error');
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
export function originCheckMiddleware(getAllowed: () => string[]): Middleware {
  return async (ctx, next) => {
    const origin = ctx.req.headers.origin;
    if (!origin) return next();

    const allowed = getAllowed();
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
export function corsResponseHeaders(getAllowed: () => string[]): Middleware {
  return async (ctx, next) => {
    const origin = ctx.req.headers.origin;
    const allowed = getAllowed();
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

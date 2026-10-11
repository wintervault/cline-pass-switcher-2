import type http from 'node:http';

import { isLoopbackHost } from './compare.ts';

/**
 * 「本机访问」判定 —— 控制台免密钥的唯一依据。
 *
 * 为什么需要它：控制台是机器主人的工具。用「下发给下游客户端的代理密钥」来锁控制台
 * 是本末倒置——密钥一设，连自己在自己机器上都进不去，忘了密钥就彻底锁死。
 * 正确的心智模型是：**能坐在本机前面的人就是最高权限**，密钥只用于识别下游客户端。
 *
 * 两个条件缺一不可（只满足一个都有洞）：
 * 1. **对端地址是回环**：远程连接（公网/局域网/反代后面）永远拿不到这个身份。
 * 2. **Host 头也指向回环**：只查对端挡不住 DNS rebinding —— 攻击者把自己的域名解析到
 *    127.0.0.1，对端确实是回环，但 Host 是攻击者的域名。这里拒绝这种请求。
 *
 * 剩下的一种攻击是「本机网页直接 fetch http://127.0.0.1:3123/api/*」：
 * 对端回环、Host 回环，两道都过。但它必带 Origin，而 Origin 与 Host 不同源
 * → 被 originCheckMiddleware 拦下（见 middleware.ts 的同源判定）。
 */
export function isLoopbackPeer(req: http.IncomingMessage): boolean {
  const remote = req.socket.remoteAddress ?? '';
  return remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1' || remote.startsWith('127.');
}

/** Host 头解析成不含端口的裸主机名（兼容 `[::1]:3123` 与 `127.0.0.1:3123`）。 */
export function hostHeaderName(host: string): string {
  const h = host.trim();
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    return end > 0 ? h.slice(1, end) : h;
  }
  return h.split(':')[0] ?? '';
}

/** 客户端是否是「坐在本机前面的用户」（回环对端 + 回环 Host）。 */
export function isTrustedLocal(req: http.IncomingMessage): boolean {
  if (!isLoopbackPeer(req)) return false;
  const host = hostHeaderName(String(req.headers.host ?? ''));
  if (!host) return false;
  return isLoopbackHost(host);
}

import type { Config } from '../config/schema.ts';
import { isLoopbackHost } from './compare.ts';

/**
 * 监听非回环地址却没有下游代理密钥：任何人访问这个网关就能白嫖你的上游账号。
 * 这是公网部署最危险的默认状态，所以直接拒绝启动而不是打条警告——警告没人看。
 *
 * 3.0 起是**逐网关**判定：哪个网关裸奔就拒绝启动，并指出是哪一个。
 */
export class InsecureBindError extends Error {
  readonly bindHost: string;
  readonly gateway: string;
  constructor(gateway: string, bindHost: string) {
    super(
      `拒绝启动：网关「${gateway}」绑定地址为 ${bindHost}（非回环），但没有设置下游代理密钥。\n` +
        '  此时任何人都能通过这个端口使用你的全部上游账号。\n' +
        '  修复方式（任选其一）：\n' +
        `    1) 在控制台「网关」页给「${gateway}」设置 API Key\n` +
        '    2) 只允许本机访问：把该网关的绑定地址改成 127.0.0.1（BIND_HOST=127.0.0.1）\n' +
        '    3) 确实要裸奔（仅限隔离的内网）：ALLOW_INSECURE_BIND=1',
    );
    this.name = 'InsecureBindError';
    this.bindHost = bindHost;
    this.gateway = gateway;
  }
}

/**
 * 启动前的安全闸门。本地回环绑定不受影响；非回环必须提供下游密钥。
 * 逃生舱 ALLOW_INSECURE_BIND=1 供隔离内网使用。
 */
export function assertBindSafe(config: Pick<Config, 'gateways'>, env: NodeJS.ProcessEnv = process.env): void {
  if (env.ALLOW_INSECURE_BIND === '1') return;
  for (const gateway of config.gateways) {
    if (isLoopbackHost(gateway.bindHost)) continue;
    if (gateway.proxyKey) continue;
    throw new InsecureBindError(gateway.name || gateway.id, gateway.bindHost);
  }
}

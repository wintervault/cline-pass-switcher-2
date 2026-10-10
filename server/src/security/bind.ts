import type { Config } from '../config/schema.ts';
import { isLoopbackHost } from './compare.ts';

/**
 * 监听非回环地址却没有下游代理密钥：任何人访问 `/api/accounts` 就能拿到全部上游 key。
 * 这是公网部署最危险的默认状态，所以直接拒绝启动而不是打条警告——警告没人看。
 */
export class InsecureBindError extends Error {
  readonly bindHost: string;
  constructor(bindHost: string) {
    super(
      `拒绝启动：绑定地址为 ${bindHost}（非回环），但没有设置下游代理密钥。\n` +
        '  此时任何人都能访问 /api/accounts 拿到你的全部上游密钥。\n' +
        '  修复方式（任选其一）：\n' +
        '    1) 设置下游密钥：PROXY_KEY=<你自己定的一串密钥>  （或在控制台「访问与安全」里设置）\n' +
        '    2) 只允许本机访问：BIND_HOST=127.0.0.1\n' +
        '    3) 确实要裸奔（仅限隔离的内网）：ALLOW_INSECURE_BIND=1',
    );
    this.name = 'InsecureBindError';
    this.bindHost = bindHost;
  }
}

/**
 * 启动前的安全闸门。本地回环绑定不受影响；非回环必须提供下游密钥。
 * 逃生舱 ALLOW_INSECURE_BIND=1 供隔离内网使用。
 */
export function assertBindSafe(
  config: Pick<Config, 'bindHost' | 'proxyKey'>,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (isLoopbackHost(config.bindHost)) return;
  if (config.proxyKey) return;
  if (env.ALLOW_INSECURE_BIND === '1') return;
  throw new InsecureBindError(config.bindHost);
}

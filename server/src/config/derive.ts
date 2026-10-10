import { isLoopbackHost } from '../security/compare.ts';
import type { Config } from './schema.ts';

/** 账号池里是否有可用账号（决定控制台是否提示去配置）。 */
export function isConfigured(config: Config): boolean {
  return config.accounts.some((a) => a.key && a.enabled !== false);
}

/** 启用中的账号列表。 */
export function enabledAccounts(config: Config) {
  return config.accounts.filter((a) => a.key && a.enabled !== false);
}

/**
 * 给下游客户端用的代理 Base URL。
 * 设了 publicBaseUrl 就用它；否则按绑定地址推导（本地绑定展示 127.0.0.1 更实用）。
 */
export function publicProxyBase(config: Config): string {
  const base = config.publicBaseUrl.replace(/\/+$/, '');
  if (base) return `${base}/v1`;
  const host = isLoopbackHost(config.bindHost) ? '127.0.0.1' : config.bindHost;
  return `http://${host}:${config.port}/v1`;
}

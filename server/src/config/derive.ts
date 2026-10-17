import { isLoopbackHost } from '../security/compare.ts';
import { type Account, type Config, defaultGateway, type Gateway } from './schema.ts';

/** 账号池里是否有可用账号（决定控制台是否提示去配置）。 */
export function isConfigured(config: Config): boolean {
  return config.accounts.some((a) => a.key && a.enabled !== false);
}

/** 启用中的账号列表（全局）。 */
export function enabledAccounts(config: Config) {
  return config.accounts.filter((a) => a.key && a.enabled !== false);
}

/**
 * 该网关可见的账号。
 *
 * `gateway.accounts` 为空 = **全部账号**（见 GatewaySchema.accounts 的注释）；
 * 否则是全局账号池的子集。账号本身是全局的，网关只引用名字、不复制密钥。
 */
export function gatewayAccounts(config: Config, gateway: Gateway): Account[] {
  const names = new Set(gateway.accounts);
  if (!names.size) return config.accounts;
  return config.accounts.filter((a) => names.has(a.name));
}

/** 该网关的启用账号。 */
export function gatewayEnabledAccounts(config: Config, gateway: Gateway): Account[] {
  return gatewayAccounts(config, gateway).filter((a) => a.key && a.enabled !== false);
}

/** 该网关是否至少有一个可用账号。 */
export function gatewayConfigured(config: Config, gateway: Gateway): boolean {
  return gatewayEnabledAccounts(config, gateway).length > 0;
}

/** 按 id 找网关；不存在返回 null。 */
export function gatewayById(config: Config, id: string): Gateway | null {
  return config.gateways.find((g) => g.id === id) ?? null;
}

/**
 * 控制台网关。加载时已保证 `console.gatewayId` 指向存在的网关；
 * 这里的兜底只为「保存过程中瞬态不一致」不崩。
 */
export function consoleGateway(config: Config): Gateway {
  return gatewayById(config, config.console.gatewayId) ?? config.gateways[0] ?? defaultGateway();
}

/**
 * 给下游客户端用的代理 Base URL（按网关）。
 * 设了 publicBaseUrl 就用它；否则按绑定地址推导（本地绑定展示 127.0.0.1 更实用）。
 */
export function gatewayProxyBase(gateway: Gateway): string {
  const base = gateway.publicBaseUrl.replace(/\/+$/, '');
  if (base) return `${base}/v1`;
  const host = isLoopbackHost(gateway.bindHost) ? '127.0.0.1' : gateway.bindHost;
  return `http://${host}:${gateway.port}/v1`;
}

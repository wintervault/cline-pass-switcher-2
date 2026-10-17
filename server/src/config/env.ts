import { ensureUniqueAccountNames } from '../accounts/naming.ts';
import { consoleGateway } from './derive.ts';
import type { Config } from './schema.ts';

/**
 * 环境变量覆盖配置，便于 Docker 部署时注入密钥而不用把明文写进挂载卷。
 *
 * 3.0 起代理设置是**网关级**的：这些变量作用于**控制台网关**
 * （`console.gatewayId`）——桌面壳固定用 `PORT=3123` 指向控制台，语义不变。
 *
 * 注意：覆盖结果就是「当前生效值」，控制台保存设置时会以生效值写回 config.json
 * （与旧版行为一致，README 有说明）。因此这里只覆盖用户明确设了的环境变量。
 */
export function applyEnvOverrides(config: Config, env: NodeJS.ProcessEnv = process.env): string[] {
  const notes: string[] = [];
  const gateway = consoleGateway(config);

  const clineKey = env.CLINE_PASS_KEY?.trim();
  if (clineKey && !config.accounts.some((a) => a.key === clineKey)) {
    const merged = ensureUniqueAccountNames([
      { name: 'env-account', key: clineKey, enabled: true },
      ...config.accounts,
    ]);
    config.accounts = merged.accounts;
    for (const r of merged.renamed) notes.push(`账号名重复，已自动改名：${r.from} → ${r.to}`);
    notes.push('CLINE_PASS_KEY 已注入账号池');
  }

  const proxyKey = env.PROXY_KEY?.trim();
  if (proxyKey) {
    gateway.proxyKey = proxyKey;
    notes.push(`PROXY_KEY 已覆盖控制台网关「${gateway.name}」的代理密钥`);
  }

  const publicBase = env.PUBLIC_BASE_URL?.trim();
  if (publicBase) {
    gateway.publicBaseUrl = publicBase.replace(/\/+$/, '');
    notes.push(`PUBLIC_BASE_URL 已覆盖控制台网关「${gateway.name}」的公网地址`);
  }

  const port = Number(env.PORT);
  if (env.PORT && Number.isInteger(port) && port > 0 && port < 65536) {
    gateway.port = port;
    notes.push(`PORT 已覆盖控制台网关「${gateway.name}」的端口为 ${port}`);
  }

  const bindHost = env.BIND_HOST?.trim();
  if (bindHost) {
    gateway.bindHost = bindHost;
    notes.push(`BIND_HOST 已覆盖控制台网关「${gateway.name}」的绑定地址`);
  }

  return notes;
}

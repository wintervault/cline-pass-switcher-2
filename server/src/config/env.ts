import { ensureUniqueAccountNames } from '../accounts/naming.ts';
import type { Config } from './schema.ts';

/**
 * 环境变量覆盖配置，便于 Docker 部署时注入密钥而不用把明文写进挂载卷。
 *
 * 注意：覆盖结果就是「当前生效值」，控制台保存设置时会以生效值写回 config.json
 * （与旧版行为一致，README 有说明）。因此这里只覆盖用户明确设了的环境变量。
 */
export function applyEnvOverrides(config: Config, env: NodeJS.ProcessEnv = process.env): string[] {
  const notes: string[] = [];

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
    config.proxyKey = proxyKey;
    notes.push('PROXY_KEY 已覆盖下游代理密钥');
  }

  const publicBase = env.PUBLIC_BASE_URL?.trim();
  if (publicBase) {
    config.publicBaseUrl = publicBase.replace(/\/+$/, '');
    notes.push('PUBLIC_BASE_URL 已覆盖公网代理地址');
  }

  const port = Number(env.PORT);
  if (env.PORT && Number.isInteger(port) && port > 0 && port < 65536) {
    config.port = port;
    notes.push(`PORT 已覆盖为 ${port}`);
  }

  const bindHost = env.BIND_HOST?.trim();
  if (bindHost) {
    config.bindHost = bindHost;
    notes.push(`BIND_HOST 已覆盖为 ${bindHost}`);
  }

  return notes;
}

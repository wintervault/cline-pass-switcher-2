import { CONFIG_VERSION } from './schema.ts';

/** 配置文件版本高于本程序支持的版本——拒绝启动，否则会把新版配置改坏。 */
export class ConfigTooNewError extends Error {
  readonly version: number;
  constructor(version: number) {
    super(
      `配置版本为 ${version}，高于本程序支持的 ${CONFIG_VERSION}。请升级程序，或手动把 config.json 的 version 改回 ${CONFIG_VERSION}。`,
    );
    this.name = 'ConfigTooNewError';
    this.version = version;
  }
}

export interface MigrationResult {
  raw: Record<string, unknown>;
  /** 人类可读的迁移记录，用于启动日志。 */
  applied: string[];
}

export const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * 把任意版本的配置文件就地升级到当前版本。
 * 只做「搬运」，不做校验——校验交给 schema，这样迁移逻辑可以独立测试。
 */
export function migrateConfig(input: Record<string, unknown>): MigrationResult {
  const raw: Record<string, unknown> = { ...input };
  const applied: string[] = [];
  const from = typeof raw.version === 'number' && Number.isInteger(raw.version) ? raw.version : 1;

  if (from > CONFIG_VERSION) throw new ConfigTooNewError(from);

  if (from < 2) {
    // ① 旧版单 key 字段迁入账号池
    const legacyKey = typeof raw.apiKey === 'string' ? raw.apiKey.trim() : '';
    const accounts = Array.isArray(raw.accounts) ? [...raw.accounts] : [];
    if (legacyKey && !accounts.some((a) => isPlainObject(a) && a.key === legacyKey)) {
      accounts.unshift({ name: '默认账号', key: legacyKey, enabled: true });
      applied.push('旧版 apiKey 已迁入账号池');
    }
    if ('apiKey' in raw) delete raw.apiKey;
    raw.accounts = accounts;

    // ② perModel：单 upstream 转优先级列表；丢弃退役的 maxRetries 与 upstream 镜像
    if (isPlainObject(raw.perModel)) {
      let converted = 0;
      for (const cfg of Object.values(raw.perModel)) {
        if (!isPlainObject(cfg)) continue;
        let upstreams: string[];
        if (Array.isArray(cfg.upstreams)) {
          upstreams = cfg.upstreams.filter((u): u is string => typeof u === 'string');
        } else {
          upstreams = typeof cfg.upstream === 'string' && cfg.upstream ? [cfg.upstream] : [];
          if (upstreams.length) converted += 1;
        }
        cfg.upstreams = upstreams;
        delete cfg.upstream;
        delete cfg.maxRetries;
      }
      if (converted) applied.push(`${converted} 个模型的单上游配置已转为优先级列表`);
    }

    // ③ 每请求轮转 → 粘性：轮询式切换会让上游 prompt cache 全失效
    if (raw.accountMode === 'roundrobin') {
      raw.accountMode = 'sticky';
      applied.push('账号模式 roundrobin → sticky（避免轮询式切换浪费 prompt cache）');
    }

    raw.version = 2;
    applied.push(`配置格式 v${from} → v${CONFIG_VERSION}`);
  }

  return { raw, applied };
}

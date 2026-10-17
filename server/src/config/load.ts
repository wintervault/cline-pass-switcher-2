import { copyFile } from 'node:fs/promises';

import { ensureUniqueAccountNames } from '../accounts/naming.ts';
import { moduleLogger } from '../log/logger.ts';
import { atomicWriteFile, readJsonFile } from '../store/jsonStore.ts';
import { isPlainObject, migrateConfig } from './migrate.ts';
import {
  type Account,
  AccountSchema,
  type Config,
  ConfigSchema,
  defaultConfig,
  defaultGateway,
  type Gateway,
  type GatewayInput,
  GatewaySchema,
  MAX_GATEWAYS,
  type PerModelConfig,
  PerModelSchema,
} from './schema.ts';

const log = moduleLogger('config');

/** schema 里出现过的顶层字段名，用于识别旧版残留与拼写错误。 */
const KNOWN_KEYS = new Set(Object.keys(ConfigSchema.shape));

export interface LoadResult {
  config: Config;
  /** 加载过程中的迁移/修复记录，启动日志会打出来。 */
  notes: string[];
  /** 损坏文件被备份到的路径（没有损坏则为 null）。 */
  backupPath: string | null;
  /** 是否是全新安装（配置文件不存在）。 */
  fresh: boolean;
  /** 发生了版本迁移时为原版本号；调用方应在启动闸门通过后写回（保留原文件备份）。 */
  migrationFrom: number | null;
}

function backupPathFor(file: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${file}.broken-${stamp}`;
}

/** typeof null === 'object'，直接拼进报错信息会读成「顶层不是对象（是 object）」。 */
function describeType(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

async function backup(file: string, raw: string): Promise<string> {
  const target = backupPathFor(file);
  await atomicWriteFile(target, raw);
  return target;
}

/**
 * 加载配置。任何损坏都不会导致崩溃或静默丢数据：
 * - 文件不存在 → 默认配置（fresh）
 * - 不是合法 JSON / 顶层不是对象 / 结构无法解析 → 原始内容备份到 `*.broken-<时间>`，用默认配置启动并记 error
 * - 个别字段非法 → 字段级兜底修正并记 note
 * - 个别账号/模型配置非法 → 丢弃该项、保留其余，并记 note
 */
export async function loadConfig(file: string): Promise<LoadResult> {
  const notes: string[] = [];
  const { value, corrupt, raw } = await readJsonFile<unknown>(file);

  // raw === null 表示文件不存在（区别于文件内容就是 "null"）
  if (raw === null && !corrupt) {
    return { config: defaultConfig(), notes, backupPath: null, fresh: true, migrationFrom: null };
  }

  if (corrupt || !isPlainObject(value)) {
    const reason = corrupt ? '不是合法 JSON' : `顶层不是对象（是 ${describeType(value)}）`;
    const backupPath = await backup(file, raw ?? '');
    notes.push(`config.json ${reason}，已用默认配置启动；原文件已备份到 ${backupPath}`);
    log.error({ file, backupPath }, `配置文件${reason}，已回退默认配置（原文件已备份）`);
    return { config: defaultConfig(), notes, backupPath, fresh: false, migrationFrom: null };
  }

  const fromVersion = typeof value.version === 'number' && Number.isInteger(value.version) ? value.version : 1;
  const { raw: migrated, applied } = migrateConfig(value);
  notes.push(...applied);

  const parsed = ConfigSchema.safeParse(migrated);
  if (!parsed.success) {
    // 字段级 .catch() 已兜住绝大多数问题，走到这里说明是结构性问题
    const backupPath = await backup(file, raw ?? '');
    notes.push(`配置结构无法解析，已用默认配置启动；原文件已备份到 ${backupPath}`);
    log.error({ file, backupPath, issues: parsed.error.issues }, '配置结构无法解析，已回退默认配置');
    return { config: defaultConfig(), notes, backupPath, fresh: false, migrationFrom: null };
  }

  const base = parsed.data;

  // 账号逐个解析：坏的丢弃并计数，好的保留（比整体丢弃温和）
  const accounts: Account[] = [];
  let droppedAccounts = 0;
  for (const entry of base.accounts) {
    const r = AccountSchema.safeParse(entry);
    if (r.success) accounts.push(r.data);
    else droppedAccounts += 1;
  }
  if (droppedAccounts) notes.push(`丢弃了 ${droppedAccounts} 个无效账号（缺少 key 或字段类型错误）`);

  // 账号名是账号的标识（usage 统计与风控分类都按名字存）→ 必须唯一
  const unified = ensureUniqueAccountNames(accounts);
  if (unified.renamed.length)
    notes.push(`账号名重复，已自动改名：${unified.renamed.map((r) => `${r.from} → ${r.to}`).join('、')}`);
  const namedAccounts = unified.accounts;

  // 网关逐个解析：坏的丢弃并计数；id 必须唯一（id 是网关的引用键）
  const accountNames = new Set(namedAccounts.map((a) => a.name));
  const gateways: Gateway[] = [];
  const seenIds = new Set<string>();
  let droppedGateways = 0;
  for (const entry of base.gateways) {
    if (gateways.length >= MAX_GATEWAYS) {
      droppedGateways += 1;
      continue;
    }
    // 兼容早期 3.0 预发布写法：给了非空 accounts 却没写 allAccounts 时，意图显然是「子集」
    const normalizedEntry =
      isPlainObject(entry) && !('allAccounts' in entry) && Array.isArray(entry['accounts']) && entry['accounts'].length
        ? { ...entry, allAccounts: false }
        : entry;
    const r = GatewaySchema.safeParse(normalizedEntry);
    if (!r.success || seenIds.has(r.data.id)) {
      if (!r.success) log.warn({ issues: r.error.issues }, '网关配置无法解析，已丢弃');
      droppedGateways += 1;
      continue;
    }
    seenIds.add(r.data.id);
    gateways.push(normalizeGateway(r.data, accountNames, notes));
  }
  if (droppedGateways) notes.push(`丢弃了 ${droppedGateways} 个无效或重复的网关（最多 ${MAX_GATEWAYS} 个）`);
  if (!gateways.length) {
    gateways.push(defaultGateway());
    notes.push('没有可用的网关，已创建默认「主网关」');
  }

  // 控制台必须挂在一个存在的网关上
  let consoleGatewayId = base.console.gatewayId;
  if (!gateways.some((g) => g.id === consoleGatewayId)) {
    notes.push(`控制台网关「${consoleGatewayId}」不存在，已改为「${gateways[0]?.id ?? 'main'}」`);
    consoleGatewayId = gateways[0]?.id ?? 'main';
  }

  const unknownKeys = Object.keys(migrated).filter((k) => !KNOWN_KEYS.has(k));
  if (unknownKeys.length) notes.push(`忽略未知配置字段：${unknownKeys.join('、')}`);

  if (notes.length) log.warn({ notes }, '配置已迁移/修正');

  return {
    config: {
      ...base,
      accounts: namedAccounts,
      gateways,
      console: { gatewayId: consoleGatewayId },
    },
    notes,
    backupPath: null,
    fresh: false,
    // 只有真正的版本迁移才回写（字段级修正不写：那条路可能丢掉了坏条目，
    // 让用户还有机会在文件里自己修）。写盘不含环境变量覆盖。
    migrationFrom: applied.length ? fromVersion : null,
  };
}

/**
 * 把迁移后的配置写回文件。先复制原文件为 `config.json.v{旧版本}-<时间>`，
 * 再原子写入——降级或迁移出错时用户可以拿回原文件。
 */
export async function persistConfigMigration(file: string, config: Config, from: number): Promise<string | null> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${file}.v${from}-${stamp}`;
  let backedUp: string | null = backupPath;
  try {
    await copyFile(file, backupPath);
  } catch {
    backedUp = null;
  }
  await writeConfig(file, config);
  return backedUp;
}

/**
 * 网关归一化：
 * - `perModel` 逐个解析（坏的丢弃，exclude 优先于 upstreams）；
 * - 账号子集过滤掉已不存在的名字（**空 = 全部账号**，见 GatewaySchema）；
 * - single 模式的账号必须在该网关范围内，否则清空（pick 会回退到第一个启用账号）。
 */
function normalizeGateway(g: GatewayInput, accountNames: Set<string>, notes: string[]): Gateway {
  const perModel: Record<string, PerModelConfig> = {};
  let droppedModels = 0;
  for (const [id, cfg] of Object.entries(g.perModel as Record<string, unknown>)) {
    const r = PerModelSchema.safeParse(cfg);
    if (!r.success) {
      droppedModels += 1;
      continue;
    }
    const excl = new Set(r.data.exclude);
    perModel[id] = { ...r.data, upstreams: r.data.upstreams.filter((u) => !excl.has(u)) };
  }
  if (droppedModels) notes.push(`网关「${g.name}」丢弃了 ${droppedModels} 个无效的模型配置`);

  const missing = g.accounts.filter((n) => !accountNames.has(n));
  const accounts = [...new Set(g.accounts.filter((n) => accountNames.has(n)))];
  if (missing.length) notes.push(`网关「${g.name}」引用了不存在的账号：${missing.join('、')}（已忽略）`);

  let activeAccount = g.activeAccount;
  if (activeAccount) {
    const inScope = g.allAccounts || accounts.includes(activeAccount);
    if (!inScope) {
      notes.push(`网关「${g.name}」指定的账号「${activeAccount}」不在其账号范围内，已改为默认`);
      activeAccount = '';
    }
  }

  return { ...g, perModel, accounts, activeAccount };
}

/** 写回配置文件（原子写）。首次启动生成默认配置时使用。 */
export async function writeConfig(file: string, config: Config): Promise<void> {
  await atomicWriteFile(file, `${JSON.stringify(config, null, 2)}\n`);
}

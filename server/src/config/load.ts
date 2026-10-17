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
    return { config: defaultConfig(), notes, backupPath: null, fresh: true };
  }

  if (corrupt || !isPlainObject(value)) {
    const reason = corrupt ? '不是合法 JSON' : `顶层不是对象（是 ${describeType(value)}）`;
    const backupPath = await backup(file, raw ?? '');
    notes.push(`config.json ${reason}，已用默认配置启动；原文件已备份到 ${backupPath}`);
    log.error({ file, backupPath }, `配置文件${reason}，已回退默认配置（原文件已备份）`);
    return { config: defaultConfig(), notes, backupPath, fresh: false };
  }

  const { raw: migrated, applied } = migrateConfig(value);
  notes.push(...applied);

  const parsed = ConfigSchema.safeParse(migrated);
  if (!parsed.success) {
    // 字段级 .catch() 已兜住绝大多数问题，走到这里说明是结构性问题
    const backupPath = await backup(file, raw ?? '');
    notes.push(`配置结构无法解析，已用默认配置启动；原文件已备份到 ${backupPath}`);
    log.error({ file, backupPath, issues: parsed.error.issues }, '配置结构无法解析，已回退默认配置');
    return { config: defaultConfig(), notes, backupPath, fresh: false };
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

  // perModel 同理；同时保证 exclude 优先于 upstreams
  const perModel: Record<string, PerModelConfig> = {};
  let droppedModels = 0;
  for (const [id, cfg] of Object.entries(base.perModel)) {
    const r = PerModelSchema.safeParse(cfg);
    if (!r.success) {
      droppedModels += 1;
      continue;
    }
    const excl = new Set(r.data.exclude);
    perModel[id] = { ...r.data, upstreams: r.data.upstreams.filter((u) => !excl.has(u)) };
  }
  if (droppedModels) notes.push(`丢弃了 ${droppedModels} 个无效的模型配置`);

  // activeAccount 越界钳制（删账号后下标可能悬空）
  let activeAccount = base.activeAccount;
  if (namedAccounts.length === 0) {
    activeAccount = 0;
  } else if (activeAccount > namedAccounts.length - 1) {
    notes.push(`activeAccount=${activeAccount} 越界，已钳制为 ${namedAccounts.length - 1}`);
    activeAccount = namedAccounts.length - 1;
  }

  const unknownKeys = Object.keys(migrated).filter((k) => !KNOWN_KEYS.has(k));
  if (unknownKeys.length) notes.push(`忽略未知配置字段：${unknownKeys.join('、')}`);

  if (notes.length) log.warn({ notes }, '配置已迁移/修正');

  return {
    config: { ...base, accounts: namedAccounts, perModel, activeAccount },
    notes,
    backupPath: null,
    fresh: false,
  };
}

/** 写回配置文件（原子写）。首次启动生成默认配置时使用。 */
export async function writeConfig(file: string, config: Config): Promise<void> {
  await atomicWriteFile(file, `${JSON.stringify(config, null, 2)}\n`);
}

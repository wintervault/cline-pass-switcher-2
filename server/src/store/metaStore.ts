import { z } from 'zod';

import type { AccountClassRecord } from '../accounts/types.ts';
import { isPlainObject } from '../config/migrate.ts';
import { moduleLogger } from '../log/logger.ts';
import {
  type AccountStats,
  defaultMeta,
  type HistoryEntry,
  type MetaFile,
  type ModelMeta,
  type OfficialModelsFetch,
} from '../upstream/types.ts';
import { atomicWriteFile, JsonStore, readJsonFile } from './jsonStore.ts';

const log = moduleLogger('meta');

const TraceEntrySchema = z.object({
  upstream: z.string().nullable().catch(null).default(null),
  status: z.number().int().catch(0).default(0),
  ms: z.number().catch(0).default(0),
  note: z.string().catch('').default(''),
});

const HistoryEntrySchema = z.object({
  ts: z.number().catch(0).default(0),
  /** 旧记录没有网关字段：它们都产生于单网关时代，归到 main。 */
  gateway: z.string().catch('main').default('main'),
  model: z.string().catch(''),
  provider: z.string().nullable().catch(null).default(null),
  canonical: z.string().nullable().catch(null).default(null),
  ms: z.number().nullable().catch(null).default(null),
  stream: z.boolean().catch(false).default(false),
  error: z.string().nullable().catch(null).default(null),
  account: z.string().nullable().catch(null).default(null),
  attempts: z.array(z.string()).catch([]).default([]),
  trace: z.array(TraceEntrySchema).catch([]).default([]),
  pinMismatch: z.boolean().catch(false).default(false),
});

const UpstreamDetailSchema = z.object({
  name: z.string().optional().catch(undefined),
  endpoints: z.number().optional().catch(undefined),
  context: z.number().optional().catch(undefined),
  uptime: z.number().optional().catch(undefined),
});

const UpstreamStatusSchema = z.object({
  status: z.enum(['ok', 'limited', 'bad', 'auth', 'unknown']).catch('unknown').default('unknown'),
  note: z.string().optional().catch(undefined),
  /** 最近一次校验的往返耗时（毫秒）。缺了这条，UI 的「最近耗时」列永远显示「—」
   *  ——校验代码一直在算，却被 schema 静默丢弃。 */
  ms: z.number().optional().catch(undefined),
  checkedAt: z.number().optional().catch(undefined),
});

const ModelMetaSchema = z.object({
  pipeline: z.enum(['planner', 'direct']).nullable().catch(null).default(null),
  pinnable: z.boolean().catch(false).default(false),
  pinState: z.enum(['enforced', 'ignored', 'unknown']).catch('unknown').default('unknown'),
  pinProbeAt: z.number().nullable().catch(null).default(null),
  pinDisabledReason: z.string().nullable().catch(null).default(null),
  availableProviders: z.array(z.string()).catch([]).default([]),
  upstreams: z.array(z.string()).catch([]).default([]),
  upstreamDetail: z.record(z.string(), UpstreamDetailSchema).catch({}).default({}),
  upstreamStatus: z.record(z.string(), UpstreamStatusSchema).catch({}).default({}),
  tier0: z.array(z.string()).catch([]).default([]),
  canonicalSlug: z.string().nullable().catch(null).default(null),
  openrouterSlug: z.string().nullable().catch(null).default(null),
  lastProvider: z.string().nullable().catch(null).default(null),
  lastMs: z.number().nullable().catch(null).default(null),
  probedAt: z.number().nullable().catch(null).default(null),
  validatedAt: z.number().nullable().catch(null).default(null),
});

const AccountStatsSchema = z.object({
  requests: z.number().catch(0).default(0),
  lastUsed: z.number().nullable().catch(null).default(null),
  lastError: z.string().nullable().catch(null).default(null),
});

/**
 * 账号风控体检结论。`unknown` 是一等状态：没体检过、或最近一次体检没能
 * 得出结论（失败原因在 note），**不允许**用「不是 private 就是 normal」这种
 * 二分法把失败当成正常。
 */
const AccountClassSchema = z.object({
  class: z.enum(['normal', 'private', 'unknown']).catch('unknown').default('unknown'),
  checkedAt: z.number().nullable().catch(null).default(null),
  note: z.string().optional().catch(undefined),
});

const OfficialModelsFetchSchema = z.object({
  ts: z.number().catch(0).default(0),
  sources: z.array(z.string()).catch([]).default([]),
  found: z.number().catch(0).default(0),
  added: z.array(z.string()).catch([]).default([]),
  total: z.number().catch(0).default(0),
});

export function parseModelMeta(raw: unknown): ModelMeta | null {
  const r = ModelMetaSchema.safeParse(raw);
  return r.success ? r.data : null;
}

export function parseHistoryEntry(raw: unknown): HistoryEntry | null {
  const r = HistoryEntrySchema.safeParse(raw);
  return r.success ? r.data : null;
}

export function parseAccountStats(raw: unknown): AccountStats | null {
  const r = AccountStatsSchema.safeParse(raw);
  return r.success ? r.data : null;
}

export function parseAccountClass(raw: unknown): AccountClassRecord | null {
  const r = AccountClassSchema.safeParse(raw);
  return r.success ? r.data : null;
}

export function parseOfficialModelsFetch(raw: unknown): OfficialModelsFetch | null {
  const r = OfficialModelsFetchSchema.safeParse(raw);
  return r.success ? r.data : null;
}

/**
 * 字段级 `.catch()` 让任何输入都能被「修复」成默认值，所以解析几乎不会失败。
 * 副作用是全垃圾输入会变成一条只有默认值的空记录（ts=0、model=''、upstreams=[]）。
 * 这种记录没有任何信息量，只会污染 UI，修复后仍为空则丢弃。
 */
function isMeaningfulModelMeta(m: ModelMeta): boolean {
  return (
    m.pipeline !== null ||
    m.probedAt !== null ||
    m.lastProvider !== null ||
    m.upstreams.length > 0 ||
    m.availableProviders.length > 0
  );
}

function isMeaningfulHistory(e: HistoryEntry): boolean {
  return e.ts > 0 && e.model.length > 0;
}

function isMeaningfulStats(s: AccountStats): boolean {
  return s.requests > 0 || s.lastUsed !== null || s.lastError !== null;
}

function isMeaningfulAccountClass(c: AccountClassRecord): boolean {
  return c.class !== 'unknown' || c.checkedAt !== null || c.note !== undefined;
}

export interface LoadMetaResult {
  store: JsonStore<MetaFile>;
  notes: string[];
  backupPath: string | null;
}

/**
 * 加载运行时观测数据（metadata.json）。
 *
 * 旧版这里完全没有结构校验：文件内容为 `{}` 时 `META.history.unshift` 直接抛 TypeError，
 * 聊天接口变成 500（实测确认）。现在每个字段都有兜底，任何损坏都收敛到默认结构。
 */
export async function loadMetaStore(file: string): Promise<LoadMetaResult> {
  const notes: string[] = [];
  const { value, corrupt, raw } = await readJsonFile<unknown>(file);

  let backupPath: string | null = null;
  // 数组也是 typeof 'object'，但同样不能作为 MetaFile 使用——一并走备份 + 重建
  if (corrupt || (value !== null && (typeof value !== 'object' || Array.isArray(value)))) {
    backupPath = `${file}.broken-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    if (raw !== null) await atomicWriteFile(backupPath, raw);
    notes.push(`metadata.json ${corrupt ? '不是合法 JSON' : '顶层不是对象映射'}，已重建；原文件备份到 ${backupPath}`);
    log.error({ file, backupPath }, '观测数据文件损坏，已重建');
  }

  const source =
    typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const meta = defaultMeta();

  // models / stats / history 逐条解析：坏一条丢一条，不拖累其余
  let droppedModels = 0;
  const models = source['models'];
  if (isPlainObject(models)) {
    // 形态检测：v2 是「模型 → 观测记录」，v3 是「网关 → 模型 → 观测记录」。
    // 判据看**值的类型**而不是「有没有这个键」：v3 的顶层值是网关映射，它的
    // `pipeline` 键（模型 id 恰好叫 pipeline 时）装的是记录对象，不可能是字符串/null。
    // 用 some 而不是 every：v2 里坏掉一条不该把整份文件误判成 v3（那会把观测数据全丢掉）。
    const looksLikeRecord = (v: unknown): boolean => {
      if (!isPlainObject(v)) return false;
      const pipeline = v['pipeline'];
      if (pipeline === null || pipeline === 'planner' || pipeline === 'direct') return true;
      const probedAt = v['probedAt'];
      return 'probedAt' in v && (probedAt === null || typeof probedAt === 'number');
    };
    const entries = Object.values(models);
    const legacy = entries.length > 0 && entries.some(looksLikeRecord);
    const byGateway: Record<string, unknown> = legacy ? { main: models } : models;
    if (legacy) notes.push('观测数据升级：模型记录已迁入「main」网关');

    for (const [gatewayId, entries] of Object.entries(byGateway)) {
      if (!isPlainObject(entries)) {
        droppedModels += 1;
        continue;
      }
      const parsedMap: Record<string, ModelMeta> = {};
      for (const [id, entry] of Object.entries(entries)) {
        const parsed = parseModelMeta(entry);
        if (parsed && isMeaningfulModelMeta(parsed)) parsedMap[id] = parsed;
        else droppedModels += 1;
      }
      if (Object.keys(parsedMap).length) meta.models[gatewayId] = parsedMap;
    }
  } else if (models !== undefined) {
    droppedModels = -1; // 结构不是映射
  }
  if (droppedModels > 0) notes.push(`丢弃了 ${droppedModels} 个损坏或无信息量的模型观测记录`);
  else if (droppedModels < 0) notes.push('models 字段不是映射，已丢弃');

  let droppedHistory = 0;
  const history = source['history'];
  if (Array.isArray(history)) {
    for (const entry of history) {
      const parsed = parseHistoryEntry(entry);
      if (parsed && isMeaningfulHistory(parsed)) meta.history.push(parsed);
      else droppedHistory += 1;
    }
  }
  if (droppedHistory) notes.push(`丢弃了 ${droppedHistory} 条损坏的历史记录`);

  let droppedStats = 0;
  const stats = source['stats'];
  if (typeof stats === 'object' && stats !== null && !Array.isArray(stats)) {
    for (const [name, entry] of Object.entries(stats as Record<string, unknown>)) {
      const parsed = parseAccountStats(entry);
      if (parsed && isMeaningfulStats(parsed)) meta.stats[name] = parsed;
      else droppedStats += 1;
    }
  }
  if (droppedStats) notes.push(`丢弃了 ${droppedStats} 条损坏的账号统计`);

  let droppedClass = 0;
  const accountClass = source['accountClass'];
  if (typeof accountClass === 'object' && accountClass !== null && !Array.isArray(accountClass)) {
    for (const [name, entry] of Object.entries(accountClass as Record<string, unknown>)) {
      const parsed = parseAccountClass(entry);
      if (parsed && isMeaningfulAccountClass(parsed)) meta.accountClass[name] = parsed;
      else droppedClass += 1;
    }
  }
  if (droppedClass) notes.push(`丢弃了 ${droppedClass} 条损坏或无信息量的账号体检记录`);

  if (Array.isArray(source['catalog']))
    meta.catalog = (source['catalog'] as unknown[]).filter((x): x is string => typeof x === 'string');
  if (typeof source['catalogFetchedAt'] === 'number') meta.catalogFetchedAt = source['catalogFetchedAt'];

  if (Array.isArray(source['orModelList']))
    meta.orModelList = (source['orModelList'] as unknown[]).filter((x): x is string => typeof x === 'string');
  if (typeof source['orModelsFetchedAt'] === 'number') meta.orModelsFetchedAt = source['orModelsFetchedAt'];

  const official = parseOfficialModelsFetch(source['officialModelsFetch']);
  if (official) meta.officialModelsFetch = official;

  const store = new JsonStore<MetaFile>(file, meta, {
    debounceMs: 150,
    maxDelayMs: 1500,
    onError: (err) => log.error({ err, file }, '观测数据写盘失败'),
  });

  return { store, notes, backupPath };
}

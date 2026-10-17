/** 上游可观测数据与故障转移共用类型。 */

import type { AccountClassRecord } from '../accounts/types.ts';

/** 两条路由管道（实测结论，README 有证据）。 */
export type Pipeline = 'planner' | 'direct';

/**
 * 钉住参数是否被网关读取（探针判定，见 docs/pinning.md D1）。
 * 网关行为按账号风控而异且随时间变化，代码不得硬编码，必须逐模型探测：
 * - enforced：探针报错（参数被读取），注入有意义，可审计钉住结果
 * - ignored：探针 200（参数被整体丢弃），注入空转，校验结果是假绿
 * - unknown：探针失败或未探测过——保守处理：继续注入但不审计
 */
export type PinState = 'enforced' | 'ignored' | 'unknown';

/** 渠道校验后的状态。 */
export type UpstreamStatusKind = 'ok' | 'limited' | 'bad' | 'auth' | 'unknown';

export interface UpstreamDetail {
  /** 渠道显示名（来自 OpenRouter endpoints）。 */
  name?: string;
  /** 该渠道下的 endpoint 数量。 */
  endpoints?: number;
  /** 最大上下文长度。 */
  context?: number;
  /** 最近 30 分钟在线率。 */
  uptime?: number;
}

export interface UpstreamStatus {
  status: UpstreamStatusKind;
  note?: string;
  /** 最近一次校验该渠道的往返耗时（毫秒）；未校验过则缺省。 */
  ms?: number;
  checkedAt?: number;
}

/** 一次故障转移链里单次尝试的记录。 */
export interface TraceEntry {
  /** 钉住的上游；null 表示自动模式。 */
  upstream: string | null;
  status: number;
  ms: number;
  note: string;
}

export interface ModelMeta {
  pipeline: Pipeline | null;
  pinnable: boolean;
  /** 钉住参数是否被网关读取（探针判定）。 */
  pinState: PinState;
  pinProbeAt: number | null;
  /** pinState=ignored 时的原因说明（含探针实测到的实际路由）。 */
  pinDisabledReason: string | null;
  /** 探测到的可用渠道清单（planner 来自报错文本，direct 来自 OpenRouter 404 元数据）。 */
  availableProviders: string[];
  /** 合并后的已知渠道清单（探测 + 学习），用于排除换算白名单。 */
  upstreams: string[];
  upstreamDetail: Record<string, UpstreamDetail>;
  upstreamStatus: Record<string, UpstreamStatus>;
  /** 规划器 tier-0 竞胜者（来自 planningReasoning，仅参考）。 */
  tier0: string[];
  canonicalSlug: string | null;
  openrouterSlug: string | null;
  lastProvider: string | null;
  lastMs: number | null;
  probedAt: number | null;
  validatedAt: number | null;
}

export interface HistoryEntry {
  ts: number;
  model: string;
  provider: string | null;
  canonical: string | null;
  ms: number | null;
  stream: boolean;
  error: string | null;
  account: string | null;
  /** 旧版遗留字段：尝试序列（新记录用 trace）。 */
  attempts: string[];
  trace: TraceEntry[];
  /** strict 钉住但网关实际由别的渠道提供服务（流式只能标记，不能撤回）。 */
  pinMismatch: boolean;
}

export interface AccountStats {
  requests: number;
  lastUsed: number | null;
  lastError: string | null;
}

export interface OfficialModelsFetch {
  ts: number;
  sources: string[];
  found: number;
  added: string[];
  total: number;
}

export interface MetaFile {
  models: Record<string, ModelMeta>;
  history: HistoryEntry[];
  catalog: string[] | null;
  catalogFetchedAt: number;
  orModelList: string[] | null;
  orModelsFetchedAt: number;
  officialModelsFetch: OfficialModelsFetch | null;
  stats: Record<string, AccountStats>;
  /** 账号风控体检结论（按账号名）。观测值：会随时间翻转，见 accounts/types.ts。 */
  accountClass: Record<string, AccountClassRecord>;
}

export function defaultMeta(): MetaFile {
  return {
    models: {},
    history: [],
    catalog: null,
    catalogFetchedAt: 0,
    orModelList: null,
    orModelsFetchedAt: 0,
    officialModelsFetch: null,
    stats: {},
    accountClass: {},
  };
}

/** 没有任何观测记录时的空白模型元数据。 */
export function blankModelMeta(): ModelMeta {
  return {
    pipeline: null,
    pinnable: false,
    pinState: 'unknown',
    pinProbeAt: null,
    pinDisabledReason: null,
    availableProviders: [],
    upstreams: [],
    upstreamDetail: {},
    upstreamStatus: {},
    tier0: [],
    canonicalSlug: null,
    openrouterSlug: null,
    lastProvider: null,
    lastMs: null,
    probedAt: null,
    validatedAt: null,
  };
}

/** 上游错误的三分类，决定故障转移策略（见 errors.ts）。 */
export type UpstreamErrorKind = 'account' | 'channel' | 'request';

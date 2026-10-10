/** 与 server/src/http/routes 的响应形状一一对应。 */

export type Pipeline = 'planner' | 'direct';
/** 钉住参数是否被网关读取（探针判定，见 docs/pinning.md D1）。 */
export type PinState = 'enforced' | 'ignored' | 'unknown';
export type UpstreamStatusKind = 'ok' | 'limited' | 'bad' | 'auth' | 'unknown';
export type PinMode = 'strict' | 'preferred';
export type SortKey = 'cost' | 'ttft' | 'tps';
export type AccountMode = 'sticky' | 'single' | 'roundrobin';

export interface UpstreamStatus {
  status: UpstreamStatusKind;
  note?: string;
  checkedAt?: number;
}

export interface UpstreamDetail {
  name?: string;
  endpoints?: number;
  context?: number;
  uptime?: number;
}

export interface TraceEntry {
  upstream: string | null;
  status: number;
  ms: number;
  note: string;
}

export interface ModelMeta {
  pipeline: Pipeline | null;
  pinnable: boolean;
  pinState: PinState;
  pinProbeAt: number | null;
  pinDisabledReason: string | null;
  availableProviders: string[];
  upstreams: string[];
  upstreamDetail: Record<string, UpstreamDetail>;
  upstreamStatus: Record<string, UpstreamStatus>;
  tier0: string[];
  canonicalSlug: string | null;
  openrouterSlug: string | null;
  lastProvider: string | null;
  lastMs: number | null;
  probedAt: number | null;
  validatedAt: number | null;
}

export interface PerModelConfig {
  upstreams: string[];
  exclude: string[];
  pinMode: PinMode;
  sort: SortKey | null;
}

export interface SubscriptionRow {
  id: string;
  config: PerModelConfig | null;
  meta: ModelMeta | null;
}

export interface OfficialFetch {
  ts: number;
  sources: string[];
  found: number;
  added: string[];
  total: number;
}

export interface ModelsResponse {
  subscription: SubscriptionRow[];
  catalogCount: number;
  catalog: string[];
  proxyBase: string;
  officialFetch: OfficialFetch | null;
}

export interface AccountView {
  name: string;
  enabled: boolean;
  keyMasked: string;
  keyTail: string;
  hasKey: boolean;
}

export interface AccountStats {
  requests: number;
  lastUsed: number | null;
  lastError: string | null;
}

export interface AccountsResponse {
  accounts: AccountView[];
  mode: AccountMode;
  active: number;
  stats: Record<string, AccountStats>;
}

export interface SecurityResponse {
  hasProxyKey: boolean;
  publicBaseUrl: string;
  authRequired: boolean;
  exposeCatalog: boolean;
  corsOrigins: string[];
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
  attempts: string[];
  trace: TraceEntry[];
  /** strict 钉住但网关实际由别的渠道提供服务（流式只能标记，不能撤回）。 */
  pinMismatch: boolean;
}

export interface TestResult {
  ok: boolean;
  ms?: number;
  targets: string[];
  exclude: string[];
  actual?: string | null;
  actualName?: string | null;
  pipeline?: Pipeline | null;
  pinnable?: boolean;
  canonicalSlug?: string | null;
  content?: string;
  account?: string | null;
  trace?: TraceEntry[];
  error?: string;
  degraded?: boolean;
}

export interface ProbeResult extends ModelMeta {
  ok: boolean;
  ms: number;
  error?: string;
}

export interface ValidationResult {
  ok: boolean;
  summary: Record<string, number>;
  results: Record<string, { status: UpstreamStatusKind; ms: number; note: string }>;
  upstreams: string[];
}

export interface MetaInfo {
  version: string;
  authRequired: boolean;
  configured: boolean;
  proxyBase: string;
}

/** 上游状态 → 展示标签与颜色。 */
export const STATUS_TAG: Record<UpstreamStatusKind, { label: string; color: string }> = {
  ok: { label: '可用', color: 'green' },
  limited: { label: '限流', color: 'gold' },
  bad: { label: '不可钉', color: 'red' },
  auth: { label: 'key 错误', color: 'volcano' },
  unknown: { label: '未判定', color: 'default' },
};

/** 校验状态排序权重：可用优先、不可钉最后。 */
export const STATUS_RANK: Record<UpstreamStatusKind, number> = { ok: 0, limited: 1, unknown: 2, auth: 3, bad: 4 };

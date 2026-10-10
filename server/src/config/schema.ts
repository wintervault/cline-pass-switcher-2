import { z } from 'zod';

/** 当前配置格式版本。加载到更低版本会触发迁移，更高版本拒绝启动（避免新版写的配置被旧版改坏）。 */
export const CONFIG_VERSION = 2;

/** 上游网关默认地址（Cline 官方）。 */
export const DEFAULT_UPSTREAM_BASE = 'https://api.cline.bot/api/v1';

/**
 * 订阅模型默认清单。这是「初始值」而非「权威清单」——启动后可点「拉取官方最新模型」合并，
 * 以及任何经代理成功调用的 `cline-pass/*` 模型会自动收录。
 */
export const DEFAULT_KNOWN_MODELS = [
  'cline-pass/glm-5.3-flash',
  'cline-pass/kimi-k3',
  'cline-pass/deepseek-v4-flash',
  'cline-pass/deepseek-v4.1-flash',
  'cline-pass/qwen3.8-max',
  'cline-pass/minimax-m3',
  'cline-pass/glm-5.3',
  'cline-pass/glm-5.2',
  'cline-pass/deepseek-v4-pro',
  'cline-pass/mimo-v2.5-pro',
  'cline-pass/mimo-v2.5',
  'cline-pass/kimi-k2.6',
  'cline-pass/qwen3.7-plus',
  'cline-pass/kimi-k2.7-code',
  'cline-pass/qwen3.7-max',
];

export const AccountSchema = z.object({
  name: z.string().min(1).max(50).catch('账号'),
  key: z.string().min(1),
  enabled: z.boolean().catch(true),
});
export type Account = z.infer<typeof AccountSchema>;

export const PinModeSchema = z.enum(['strict', 'preferred']);
export type PinMode = z.infer<typeof PinModeSchema>;

export const SortSchema = z.enum(['cost', 'ttft', 'tps']);
export type Sort = z.infer<typeof SortSchema>;

export const AccountModeSchema = z.enum(['sticky', 'single', 'roundrobin']);
export type AccountMode = z.infer<typeof AccountModeSchema>;

export const PerModelSchema = z.object({
  /** 有序优先列表：按顺序逐个尝试。空 = 自动（交给网关）。 */
  upstreams: z.array(z.string().min(1)).max(10).catch([]).default([]),
  /** 排除列表，优先级高于 upstreams。 */
  exclude: z.array(z.string().min(1)).max(10).catch([]).default([]),
  pinMode: PinModeSchema.catch('strict').default('strict'),
  sort: SortSchema.nullable().catch(null).default(null),
});
export type PerModelConfig = z.infer<typeof PerModelSchema>;

/**
 * 故障转移参数。默认值取向是「agent 场景不超时」：
 * 单次尝试 60s、整条链 90s 封顶——多数 OpenAI 客户端 60~120s 就断了，再长只是白烧额度。
 */
export const FailoverSchema = z.object({
  /** 单次尝试上限（毫秒）。 */
  attemptTimeoutMs: z.number().int().min(1000).max(600000).catch(60000).default(60000),
  /** 整条故障转移链的总预算（毫秒）。预算耗尽立即返回最后错误，不再切换。 */
  budgetMs: z.number().int().min(1000).max(600000).catch(90000).default(90000),
  /** 渠道级错误时同渠道重试次数（不含首次）。 */
  retriesPerChannel: z.number().int().min(0).max(5).catch(1).default(1),
  /** 渠道进入冷却的时长（毫秒）。冷却期内排到候选末尾，不是剔除。 */
  cooldownMs: z.number().int().min(0).max(3600000).catch(300000).default(300000),
  /** 同渠道重试之间的退避基数（毫秒）。 */
  retryBackoffMs: z.number().int().min(0).max(10000).catch(500).default(500),
});
export type FailoverConfig = z.infer<typeof FailoverSchema>;

export const ConfigSchema = z.object({
  version: z.number().int().catch(CONFIG_VERSION).default(CONFIG_VERSION),

  // ---- 网络 ----
  port: z.number().int().min(1).max(65535).catch(3123).default(3123),
  bindHost: z.string().min(1).catch('127.0.0.1').default('127.0.0.1'),
  upstreamBase: z.string().url().catch(DEFAULT_UPSTREAM_BASE).default(DEFAULT_UPSTREAM_BASE),

  // ---- 下游访问 ----
  /** 下游代理密钥。为空 = 不鉴权；绑定非回环地址时为空会拒绝启动。 */
  proxyKey: z.string().catch('').default(''),
  /** 公网代理地址，仅用于控制台展示。 */
  publicBaseUrl: z.string().catch('').default(''),
  /** CORS 白名单。默认空 = 不发 Access-Control-Allow-Origin（同源访问足够）。 */
  corsOrigins: z.array(z.string()).catch([]).default([]),
  /** true 时 /v1/models 合并完整目录模型。 */
  exposeCatalog: z.boolean().catch(false).default(false),

  // ---- 账号池 ----
  accounts: z.array(z.unknown()).catch([]).default([]),
  accountMode: AccountModeSchema.catch('sticky').default('sticky'),
  activeAccount: z.number().int().min(0).catch(0).default(0),

  // ---- 模型 ----
  // 键缺失或值损坏 → 恢复默认清单；显式写 [] → 尊重用户清空，不复活
  knownModels: z
    .array(z.string())
    .catch(() => [...DEFAULT_KNOWN_MODELS])
    .default(() => [...DEFAULT_KNOWN_MODELS]),
  perModel: z.record(z.string(), z.unknown()).catch({}).default({}),

  // ---- 故障转移 ----
  // 注意：zod 4 的 .default({}) 不会 parse 默认值（会原样返回裸 {}，缺字段）；
  // .prefault({}) 会 parse，但遇到「存在且非法」的输入直接抛。两者组合才既能补全又能兜底。
  failover: FailoverSchema.catch(() => FailoverSchema.parse({})).prefault({}),

  // ---- 观测 ----
  historyLimit: z.number().int().min(1).max(10000).catch(500).default(500),
});

/** 校验并归一化后的配置类型。注意 accounts / perModel 在解析后已收敛为强类型。 */
export type Config = Omit<z.infer<typeof ConfigSchema>, 'accounts' | 'perModel'> & {
  accounts: Account[];
  perModel: Record<string, PerModelConfig>;
};

/** 全新安装时的默认配置。 */
export function defaultConfig(): Config {
  return {
    version: CONFIG_VERSION,
    port: 3123,
    bindHost: '127.0.0.1',
    upstreamBase: DEFAULT_UPSTREAM_BASE,
    proxyKey: '',
    publicBaseUrl: '',
    corsOrigins: [],
    exposeCatalog: false,
    accounts: [],
    accountMode: 'sticky',
    activeAccount: 0,
    knownModels: [...DEFAULT_KNOWN_MODELS],
    perModel: {},
    failover: FailoverSchema.parse({}),
    historyLimit: 500,
  };
}

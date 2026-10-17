import { z } from 'zod';

import { isIsoDate } from './date.ts';

/** 当前配置格式版本。加载到更低版本会触发迁移，更高版本拒绝启动（避免新版写的配置被旧版改坏）。 */
export const CONFIG_VERSION = 3;

/**
 * 账号风控体检用的默认判定模型。
 *
 * 为什么是 flash 型号：体检每次都要真实发请求，要快、要便宜；而且必须是
 * **planner 管线**的模型（`cline-pass/*`）——我们要看的正是它的默认路由。
 * direct 模型（OpenRouter 类）两类账号都能钉住，判不出风控（docs/pinning.md 第五节）。
 */
export const DEFAULT_CLASSIFY_MODEL = 'cline-pass/deepseek-v4.1-flash';

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
  /**
   * 用户声明的到期日期（本地日期 `YYYY-MM-DD`，可缺省）。
   * 非法日期按「未设置」处理而不是丢弃整个账号——手改配置写错一个数字，
   * 不该把密钥一起丢掉。**到期不自动停用账号**：可能只是没续期日期，
   * 停用是破坏性动作（ROADMAP §3）。
   */
  expiresAt: z.string().refine(isIsoDate, '日期格式应为 YYYY-MM-DD').optional().catch(undefined),
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
  /** 单次尝试上限（毫秒）。语义是「多久内要开始有响应」——拿到首块数据后交给下面的空闲超时。 */
  attemptTimeoutMs: z.number().int().min(1000).max(600000).catch(60000).default(60000),
  /** 流式/内部流式尝试的**空闲**超时（毫秒）：连续这么久没有新数据才判定卡死。
   *  长回答不再被「总时长」切断（详见 docs/timeouts.md）。 */
  idleTimeoutMs: z.number().int().min(1000).max(600000).catch(60000).default(60000),
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

/**
 * 网关标识：用短 slug 而不是自增数字——它出现在查询参数（`?gateway=`）与日志里，
 * 可读、可手写、可推断。改名会丢配置关联，所以 id 创建后不可改（UI 只让改显示名）。
 */
export const GatewayIdSchema = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[a-z0-9][a-z0-9-]*$/)
  .catch('main');

/** 网关数量上限：每个网关一个端口 + 一套运行时，数量失控只会让配置面变复杂。 */
export const MAX_GATEWAYS = 8;

/**
 * 网关 = 一个独立接入面。
 *
 * 设计要点（docs/ROADMAP-3.0.md §2、§9 第 1/8 条）：
 * - **账号池是全局的**，网关只引用账号名（子集），不复制密钥；
 * - 账号策略、失败转移、模型清单与路由配置都是**网关级**——不同网关可以走完全不同的策略；
 * - `upstreamBase` 保持全局（所有网关连同一个 Cline 网关）；
 * - 控制台只挂在 `console.gatewayId` 指向的那个网关上，其余网关只提供 `/v1`。
 */
export const GatewaySchema = z.object({
  id: GatewayIdSchema,
  /** 显示名（可改）。 */
  name: z.string().min(1).max(50).catch('网关'),
  port: z.number().int().min(1).max(65535).catch(3123),
  bindHost: z.string().min(1).catch('127.0.0.1'),
  /** 下游代理密钥。为空 = 不鉴权；绑定非回环地址时为空会拒绝启动（启动闸门按网关判定）。 */
  proxyKey: z.string().catch('').default(''),
  /** 公网代理地址，仅用于展示。 */
  publicBaseUrl: z.string().catch('').default(''),
  /** CORS 白名单。默认空 = 不发 Access-Control-Allow-Origin（同源访问足够）。 */
  corsOrigins: z.array(z.string()).catch([]).default([]),
  /** true 时 /v1/models 合并完整目录模型。 */
  exposeCatalog: z.boolean().catch(false).default(false),

  /**
   * 是否使用全部账号（默认）。为 false 时只看 `accounts` 列表。
   *
   * 为什么不拿「空数组 = 全部」当约定：账号被删除后子集会被剪空，
   * 那样网关会从「只用某一个号」悄悄变成「用全部号」——权限被放大且无声。
   * 显式布尔让两种情况永远可区分。
   */
  allAccounts: z.boolean().catch(true).default(true),
  /** 账号子集（全局账号池里的名字），仅在 `allAccounts=false` 时生效。 */
  accounts: z.array(z.string().min(1)).catch([]).default([]),
  accountMode: AccountModeSchema.catch('sticky').default('sticky'),
  /** single 模式使用的账号名（账号标识是 name，不再是下标）。 */
  activeAccount: z.string().catch('').default(''),

  // 键缺失或值损坏 → 恢复默认清单；显式写 [] → 尊重用户清空，不复活
  knownModels: z
    .array(z.string())
    .catch(() => [...DEFAULT_KNOWN_MODELS])
    .default(() => [...DEFAULT_KNOWN_MODELS]),
  perModel: z.record(z.string(), z.unknown()).catch({}).default({}),

  // 注意：zod 4 的 .default({}) 不会 parse 默认值（会原样返回裸 {}，缺字段）；
  // .prefault({}) 会 parse，但遇到「存在且非法」的输入直接抛。两者组合才既能补全又能兜底。
  failover: FailoverSchema.catch(() => FailoverSchema.parse({})).prefault({}),
});

/** 解析后的网关类型（perModel 收敛为强类型）。 */
export type Gateway = Omit<z.infer<typeof GatewaySchema>, 'perModel'> & {
  perModel: Record<string, PerModelConfig>;
};

/** 只过了 schema、尚未做 perModel 收敛的网关。 */
export type GatewayInput = z.infer<typeof GatewaySchema>;

export const ConfigSchema = z.object({
  version: z.number().int().catch(CONFIG_VERSION).default(CONFIG_VERSION),

  /** 上游网关地址（所有网关共用同一个 Cline 网关）。 */
  upstreamBase: z.string().url().catch(DEFAULT_UPSTREAM_BASE).default(DEFAULT_UPSTREAM_BASE),

  // ---- 账号池（全局） ----
  accounts: z.array(z.unknown()).catch([]).default([]),
  /** 账号风控体检的判定模型（见上方 DEFAULT_CLASSIFY_MODEL 的注释）。 */
  classifyModel: z.string().min(1).catch(DEFAULT_CLASSIFY_MODEL).default(DEFAULT_CLASSIFY_MODEL),

  // ---- 网关（接入面） ----
  gateways: z.array(z.unknown()).catch([]).default([]),
  /** 控制台挂在哪个网关上（该网关额外提供 /api 与静态页面）。 */
  console: z
    .object({ gatewayId: z.string().catch('main').default('main') })
    .catch(() => ({ gatewayId: 'main' }))
    .prefault({}),

  // ---- 观测 ----
  historyLimit: z.number().int().min(1).max(10000).catch(500).default(500),
});

/** 校验并归一化后的配置类型。accounts / gateways 在加载时已收敛为强类型。 */
export type Config = Omit<z.infer<typeof ConfigSchema>, 'accounts' | 'gateways'> & {
  accounts: Account[];
  gateways: Gateway[];
};

/** 默认网关（新安装 / 迁移目标）。 */
export function defaultGateway(overrides: Partial<Gateway> = {}): Gateway {
  return {
    id: 'main',
    name: '主网关',
    port: 3123,
    bindHost: '127.0.0.1',
    proxyKey: '',
    publicBaseUrl: '',
    corsOrigins: [],
    exposeCatalog: false,
    allAccounts: true,
    accounts: [],
    accountMode: 'sticky',
    activeAccount: '',
    knownModels: [...DEFAULT_KNOWN_MODELS],
    perModel: {},
    failover: FailoverSchema.parse({}),
    ...overrides,
  };
}

/** 全新安装时的默认配置。 */
export function defaultConfig(): Config {
  return {
    version: CONFIG_VERSION,
    upstreamBase: DEFAULT_UPSTREAM_BASE,
    accounts: [],
    classifyModel: DEFAULT_CLASSIFY_MODEL,
    gateways: [defaultGateway()],
    console: { gatewayId: 'main' },
    historyLimit: 500,
  };
}

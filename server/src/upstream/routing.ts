import type { Pipeline } from './types.ts';

export const SORT_KEYS = ['cost', 'ttft', 'tps'] as const;
export type SortKey = (typeof SORT_KEYS)[number];

/** 把渠道显示名转成 slug（GMICloud → gmicloud），与探测/钉住时使用的标识对齐。 */
export function slugify(s: string): string {
  return s.toLowerCase().replace(/\s+/g, '-');
}

// ---------- 响应元数据解析 ----------

export interface RoutingInfo {
  /** 首条消息内容（探测/测试时展示）。 */
  content: unknown;
  usage: Record<string, unknown> | null;
  pipeline: Pipeline | null;
  canonicalSlug: string | null;
  /** slug 形式的实际上游。 */
  finalProvider: string | null;
  /** 显示名形式的实际上游。 */
  finalProviderName: string | null;
  fallbacks: string[];
  /** 规划器的选择理由。 */
  plan: string;
}

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/**
 * 从上游响应中回读路由元数据。
 *
 * 两条管道的元数据位置不同（实测）：
 * - planner：`message.provider_metadata.gateway.routing`（或顶层同名）
 * - direct：顶层 `provider`（显示名）与 `model`（真实模型 ID）
 * 另外处理 Cline 的 `{"data": {...}}` 包装。
 */
export function parseRouting(json: unknown): RoutingInfo {
  const top = asRecord(json);
  const innerData = asRecord(top?.['data']);
  const d = innerData && Array.isArray(innerData['choices']) ? innerData : (top ?? {});

  const choices = Array.isArray(d['choices']) ? (d['choices'] as unknown[]) : [];
  const first = asRecord(choices[0]);
  const message = asRecord(first?.['message']);

  const msgRouting = asRecord(asRecord(message?.['provider_metadata'])?.['gateway'])?.['routing'];
  const topRouting = asRecord(asRecord(d['provider_metadata'])?.['gateway'])?.['routing'];
  const routing = asRecord(msgRouting) ?? asRecord(topRouting);

  const providerName = typeof d['provider'] === 'string' ? d['provider'] : null;
  const finalProviderRaw = typeof routing?.['finalProvider'] === 'string' ? routing['finalProvider'] : null;
  const modelField = typeof d['model'] === 'string' ? d['model'] : null;

  const fallbacks = Array.isArray(routing?.['fallbacksAvailable'])
    ? (routing['fallbacksAvailable'] as unknown[]).filter((x): x is string => typeof x === 'string')
    : [];

  return {
    content: message?.['content'] ?? null,
    usage: asRecord(d['usage']),
    pipeline: finalProviderRaw ? 'planner' : providerName ? 'direct' : null,
    canonicalSlug:
      typeof routing?.['canonicalSlug'] === 'string'
        ? routing['canonicalSlug']
        : modelField?.includes('/')
          ? modelField
          : null,
    finalProvider: finalProviderRaw ?? (providerName ? slugify(providerName) : null),
    finalProviderName: finalProviderRaw ?? providerName,
    fallbacks,
    plan: typeof routing?.['planningReasoning'] === 'string' ? routing['planningReasoning'] : '',
  };
}

/** 未获得任何路由信息时的占位值（上游完全失败、或响应不含元数据）。 */
export function emptyRouting(): RoutingInfo {
  return {
    content: null,
    usage: null,
    pipeline: null,
    canonicalSlug: null,
    finalProvider: null,
    finalProviderName: null,
    fallbacks: [],
    plan: '',
  };
}

// ---------- 钉住偏好注入 ----------

export interface UpstreamPrefs {
  /** 本次尝试要钉住的上游；null = 自动（交给网关）。 */
  upstream: string | null;
  /** preferred 模式下排在当前上游之后的网关侧回退序列。 */
  orderRest: readonly string[];
  /** 排除列表。网关不支持 exclude 字段（实测被静默忽略），统一换算成 only 白名单。 */
  excludeList: readonly string[];
  /** strict：只钉 upstream；preferred：order 首位 + 允许网关回退。 */
  strict: boolean;
  sort: SortKey | null;
}

export interface InjectContext {
  /** 管道类型决定注入位置；未知时两种形式都注入，各自取用、互不干扰。 */
  pipeline: Pipeline | null;
  /** 已知渠道清单，用于把排除换算成白名单。 */
  knownUpstreams: readonly string[];
}

export interface InjectResult {
  body: Record<string, unknown>;
  /**
   * true 表示「排除」无法生效：本地没有该模型的渠道清单（未探测过），
   * 或者把已知清单全排除了。旧版这里静默失效（实测确认的缺陷），现在显式标记。
   */
  degraded: boolean;
}

/** OpenRouter 的排序字段名与控制台选项不同。 */
export const OR_SORT: Record<SortKey, string> = { cost: 'price', ttft: 'latency', tps: 'throughput' };

/**
 * 按管道注入钉住偏好（实测结论）：
 * - planner（Vercel AI Gateway）：顶层 provider 简写里的 only/order 会被 Cline 吞掉，
 *   必须用 providerOptions.gateway.{only,order,sort}；流式同样生效。
 * - direct（OpenRouter）：顶层 provider.{only,order,sort} 生效；providerOptions 被忽略。
 * - 管道未知：两种形式同时注入。
 *
 * 纯函数：不读全局状态；请求体经 structuredClone 复制，不改入参。
 */
export function injectPrefs(body: Record<string, unknown>, ctx: InjectContext, prefs: UpstreamPrefs): InjectResult {
  const result = structuredClone(body) as Record<string, unknown>;

  const exclude = prefs.excludeList.filter((u) => u !== prefs.upstream);
  const allowList = exclude.length ? ctx.knownUpstreams.filter((u) => !exclude.includes(u)) : null;
  const degraded = exclude.length > 0 && (allowList === null || allowList.length === 0);

  const needsPrefs = prefs.upstream !== null || prefs.sort !== null || (allowList !== null && allowList.length > 0);
  if (!needsPrefs) return { body: result, degraded };

  const useVercel = ctx.pipeline === 'planner' || ctx.pipeline === null;
  const useOpenRouter = ctx.pipeline === 'direct' || ctx.pipeline === null;

  if (useVercel) {
    const gw: Record<string, unknown> = {};
    if (prefs.upstream) {
      if (prefs.strict) {
        gw['only'] = [prefs.upstream];
      } else {
        gw['order'] = [prefs.upstream, ...prefs.orderRest];
        if (allowList?.length) gw['only'] = allowList;
      }
    } else if (allowList?.length) {
      gw['only'] = allowList;
    }
    if (prefs.sort) gw['sort'] = prefs.sort;

    const existingOptions = asRecord(result['providerOptions']);
    const existingGateway = asRecord(existingOptions?.['gateway']);
    result['providerOptions'] = {
      ...(existingOptions ?? {}),
      gateway: { ...(existingGateway ?? {}), ...gw },
    };
  }

  if (useOpenRouter) {
    const provider: Record<string, unknown> = { ...(asRecord(result['provider']) ?? {}) };
    if (prefs.upstream) {
      if (prefs.strict) {
        provider['only'] = [prefs.upstream];
      } else {
        provider['order'] = [prefs.upstream, ...prefs.orderRest];
        if (allowList?.length) provider['only'] = allowList;
      }
    } else if (allowList?.length) {
      provider['only'] = allowList;
    }
    if (prefs.sort) provider['sort'] = OR_SORT[prefs.sort];
    result['provider'] = provider;
  }

  return { body: result, degraded };
}

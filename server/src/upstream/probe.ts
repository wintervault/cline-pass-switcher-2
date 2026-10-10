import type { AccountPool } from '../accounts/pool.ts';
import { fetchJSON } from './client.ts';
import { classifyChannelStatus } from './errors.ts';
import { parseRouting } from './routing.ts';
import type { ModelMeta, UpstreamStatusKind } from './types.ts';

/** 探测与校验共用的上游访问依赖。 */
export interface ProbeDeps {
  upstreamBase: string;
  pool: AccountPool;
  /** 读写模型观测记录。 */
  getMeta: (modelId: string) => ModelMeta | undefined;
  setMeta: (modelId: string, meta: ModelMeta) => void;
  /** OpenRouter endpoints 查询（直连管道参考）。 */
  orEndpoints?: (slug: string) => Promise<{
    slug: string;
    endpoints: Array<{ slug: string; name?: string; endpoints?: number; context?: number; uptime?: number }>;
  }>;
}

export interface ProbeResult extends ModelMeta {
  ok: boolean;
  ms: number;
  error?: string;
}

const CHAT = '/chat/completions';

/**
 * 零 token 探测：带一个不存在的 only，让网关在路由层报错并列出精确可用渠道。
 * - 直连管道（OpenRouter）：provider.only → 404 错误 JSON 里的 metadata.available_providers
 * - 规划器管道（Vercel AI Gateway）：providerOptions.gateway.only → 400 错误文本里的
 *   "Available providers are: ..."
 * 两条管道的清单不一致，必须分别取。
 */
async function harvestAvailableProviders(
  deps: ProbeDeps,
  modelId: string,
  pipeline: 'planner' | 'direct',
  key: string,
): Promise<string[] | null> {
  const base = { model: modelId, messages: [{ role: 'user', content: 'hi' }], max_tokens: 16 };
  const body =
    pipeline === 'planner'
      ? { ...base, providerOptions: { gateway: { only: ['__probe__'] } } }
      : { ...base, provider: { only: ['__probe__'] } };
  const { json } = await fetchJSON(
    `${deps.upstreamBase}${CHAT}`,
    { method: 'POST', headers: authHeaders(key), body: JSON.stringify(body) },
    60_000,
  );
  const err = (json as { error?: unknown } | null)?.error;
  if (typeof err !== 'string') return null;

  if (pipeline === 'planner') {
    const match = /Available providers are:\s*([^.]+)/.exec(err);
    if (!match?.[1]) return null;
    // 错误文本里可能混有 JSON 片段（如 ","type":"invalid_request_error"），必须按 slug 格式过滤
    const tokens = match[1]
      .split(/,\s*/)
      .map((s) => s.trim())
      .filter((t) => /^[a-z0-9][a-z0-9-]*$/.test(t));
    return tokens.length ? tokens : null;
  }

  const start = err.indexOf('{');
  if (start < 0) return null;
  try {
    const parsed = JSON.parse(err.slice(start)) as { error?: { metadata?: { available_providers?: string[] } } };
    return parsed.error?.metadata?.available_providers ?? null;
  } catch {
    return null;
  }
}

/** 规划器 tier-0 竞胜者（来自 planningReasoning，仅参考）。 */
function parseTier0(plan: string): string[] {
  const match = /([\w-]+) won tier 0 over ([^."]+)/.exec(plan ?? '');
  if (!match) return [];
  const winner = match[1] ?? '';
  const losers = (match[2] ?? '')
    .split(/,\s*|\s+and\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return [...new Set([winner, ...losers])];
}

const authHeaders = (key: string): Record<string, string> => ({
  'Content-Type': 'application/json',
  ...(key ? { Authorization: `Bearer ${key}` } : {}),
});

/** 合并合并-学习工具：把网关报错里附带的最新渠道清单并进已知列表。 */
export function mergeLearnedProviders(meta: ModelMeta, message: string): string[] {
  const match = /Available providers are:\s*([^.]+)/.exec(String(message || ''));
  if (!match?.[1]) return [];
  const tokens = match[1]
    .split(/,\s*/)
    .map((s) => s.trim())
    .filter((t) => /^[a-z0-9][a-z0-9-]*$/.test(t));
  const before = meta.upstreams.length;
  meta.upstreams = [...new Set([...meta.upstreams, ...tokens])];
  return meta.upstreams.length > before ? meta.upstreams : [];
}

export class ProbeService {
  readonly #deps: ProbeDeps;

  constructor(deps: ProbeDeps) {
    this.#deps = deps;
  }

  /** 探测单个模型：真实小请求回读管道类型，再零 token 拉渠道清单。 */
  async probeModel(modelId: string): Promise<ProbeResult> {
    const account = this.#deps.pool.pick();
    const started = Date.now();
    const body = { model: modelId, messages: [{ role: 'user', content: 'Reply with the word OK' }], max_tokens: 256 };
    const { json } = await fetchJSON(
      `${this.#deps.upstreamBase}${CHAT}`,
      { method: 'POST', headers: authHeaders(account?.key ?? ''), body: JSON.stringify(body) },
      180_000,
    );

    const shaped = json as { error?: unknown; data?: { error?: unknown } } | null;
    const topError = shaped && typeof shaped === 'object' ? shaped.error : undefined;
    const dataError =
      shaped && typeof shaped === 'object' ? shaped.data && (shaped.data as { error?: unknown }).error : undefined;
    if (topError && !shaped?.data) {
      return { ...this.#blank(modelId), ok: false, ms: Date.now() - started, error: String(topError).slice(0, 400) };
    }
    if (dataError) {
      return { ...this.#blank(modelId), ok: false, ms: Date.now() - started, error: String(dataError).slice(0, 400) };
    }

    const routing = parseRouting(json);
    let harvest: string[] | null = null;
    if (routing.pipeline)
      harvest = await harvestAvailableProviders(this.#deps, modelId, routing.pipeline, account?.key ?? '');

    let endpoints: Array<{ slug: string; name?: string; endpoints?: number; context?: number; uptime?: number }> = [];
    let orSlug: string | null = null;
    if (routing.pipeline !== 'planner' && routing.canonicalSlug && this.#deps.orEndpoints) {
      // 规划器管道的钉住发生在 Vercel 侧，OpenRouter 的 endpoint 明细仅对直连管道有参考意义
      try {
        const res = await this.#deps.orEndpoints(routing.canonicalSlug);
        endpoints = res.endpoints;
        orSlug = res.slug;
      } catch {
        /* 公开接口失败不影响探测结果 */
      }
    }

    const prev = this.#deps.getMeta(modelId);
    const detail: ModelMeta['upstreamDetail'] = { ...(prev?.upstreamDetail ?? {}) };
    for (const e of endpoints) detail[e.slug] = e;

    const upstreams =
      routing.pipeline === 'planner'
        ? [...new Set([...(harvest ?? []), ...routing.fallbacks, ...(prev?.upstreams ?? [])])]
        : [...new Set([...routing.fallbacks, ...(harvest ?? []), ...Object.keys(detail)])];

    const meta: ModelMeta = {
      pipeline: routing.pipeline,
      pinnable: routing.pipeline !== null,
      availableProviders: harvest ?? prev?.availableProviders ?? [],
      upstreams,
      upstreamDetail: detail,
      upstreamStatus: prev?.upstreamStatus ?? {},
      tier0: [...new Set([...(prev?.tier0 ?? []), ...parseTier0(routing.plan)])],
      canonicalSlug: routing.canonicalSlug,
      openrouterSlug: orSlug ?? prev?.openrouterSlug ?? null,
      lastProvider: routing.finalProvider ?? prev?.lastProvider ?? null,
      lastMs: Date.now() - started,
      probedAt: Date.now(),
      validatedAt: prev?.validatedAt ?? null,
    };
    this.#deps.setMeta(modelId, meta);
    return { ...meta, ok: true, ms: meta.lastMs ?? 0 };
  }

  /** 批量校验：每个渠道各钉一次最小请求，标出真实可用性（✔可用/⏳限流/✘不可钉/🔑key错）。 */
  async validateUpstreams(modelId: string): Promise<{
    results: Record<string, { status: UpstreamStatusKind; ms: number; note: string }>;
    upstreams: string[];
  }> {
    const meta = this.#deps.getMeta(modelId);
    const list = meta?.upstreams ?? [];
    const pipeline = meta?.pipeline;
    const account = this.#deps.pool.pick();
    const results: Record<string, { status: UpstreamStatusKind; ms: number; note: string }> = {};

    const batch = 5;
    for (let i = 0; i < list.length; i += batch) {
      await Promise.all(
        list.slice(i, i + batch).map(async (slug) => {
          const started = Date.now();
          const base = { model: modelId, messages: [{ role: 'user', content: 'hi' }], max_tokens: 16 };
          const body =
            pipeline === 'planner'
              ? { ...base, providerOptions: { gateway: { only: [slug] } } }
              : { ...base, provider: { only: [slug] } };
          let json: unknown = null;
          try {
            const res = await fetchJSON(
              `${this.#deps.upstreamBase}${CHAT}`,
              { method: 'POST', headers: authHeaders(account?.key ?? ''), body: JSON.stringify(body) },
              60_000,
            );
            json = res.json;
          } catch {
            json = { error: 'network error' };
          }

          let status: UpstreamStatusKind = 'unknown';
          let note = '';
          const shaped = json as { error?: unknown; data?: { choices?: unknown } } | null;
          if (shaped && typeof shaped === 'object' && shaped.error && !shaped.data?.choices) {
            const message = typeof shaped.error === 'string' ? shaped.error : JSON.stringify(shaped.error);
            status = classifyChannelStatus(message);
            note = message.slice(0, 160);
          } else if (shaped?.data?.choices) {
            status = 'ok';
          }
          results[slug] = { status, ms: Date.now() - started, note };
        }),
      );
    }

    const updated = this.#deps.getMeta(modelId);
    if (updated) {
      updated.upstreamStatus = { ...updated.upstreamStatus, ...results };
      updated.validatedAt = Date.now();
      this.#deps.setMeta(modelId, updated);
    }
    return { results, upstreams: list };
  }

  #blank(modelId: string): ModelMeta {
    const prev = this.#deps.getMeta(modelId);
    return (
      prev ?? {
        pipeline: null,
        pinnable: false,
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
      }
    );
  }
}

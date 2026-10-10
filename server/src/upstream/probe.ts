import type { AccountPool } from '../accounts/pool.ts';
import { fetchJSON } from './client.ts';
import { classifyChannelStatus } from './errors.ts';
import { parsePlannedChain, parseRouting } from './routing.ts';
import { blankModelMeta, type ModelMeta, type PinState, type UpstreamStatusKind } from './types.ts';

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
 * 探针渠道名。必须是**合法 slug 形状**的不存在名字——下划线形状（如 `__probe__`）
 * 会被网关静默丢弃，早在钉住功能还生效的时期就拿不到清单（docs/pinning.md 3.1）。
 */
const PROBE_SLUG = 'zzz-not-a-provider';

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

function parseSlugList(text: string): string[] {
  return text
    .split(/,\s*/)
    .map((s) =>
      s
        .trim()
        .replace(/^["']|["']$/g, '')
        .toLowerCase(),
    )
    .filter((t) => SLUG_RE.test(t));
}

interface PinProbeOutcome {
  pinState: PinState;
  /** 探针报错时网关附带的可用渠道清单（仅 enforced 且报错带清单时非空）。 */
  providers: string[] | null;
  /** pinState=ignored 时本次探针被实际路由到的渠道（风控特征，如 openai-compatible-private）。 */
  routedTo: string | null;
}

/**
 * 钉住探针：带一个「格式合法但不存在」的渠道名发请求（docs/pinning.md D1 / 3.1）。
 *
 * - **报错且是路由层拒绝**（`Available providers are:` / `No allowed providers`）
 *   → 参数仍被读取 → enforced，顺带拿到清单
 * - **200 正常返回，或报 `empty response content`**（说明请求穿过路由层、执行到了模型——
 *   推理模型在小 max_tokens 下把额度烧在思考上，网关回 HTTP 500，不是路由故障）
 *   → 参数被整体丢弃 → ignored
 * - **其他错误**（429 限流 / 网络失败）→ 无法判定 → unknown（保守：沿用既有状态）
 */
async function pinProbe(
  deps: ProbeDeps,
  modelId: string,
  pipeline: 'planner' | 'direct',
  key: string,
): Promise<PinProbeOutcome> {
  const base = { model: modelId, messages: [{ role: 'user', content: 'Reply with the word OK' }], max_tokens: 512 };
  const body =
    pipeline === 'planner'
      ? { ...base, providerOptions: { gateway: { only: [PROBE_SLUG] } } }
      : { ...base, provider: { only: [PROBE_SLUG] } };

  let json: unknown = null;
  try {
    const res = await fetchJSON(
      `${deps.upstreamBase}${CHAT}`,
      { method: 'POST', headers: authHeaders(key), body: JSON.stringify(body) },
      90_000,
    );
    json = res.json;
  } catch {
    return { pinState: 'unknown', providers: null, routedTo: null };
  }

  const shaped = json as { error?: unknown; data?: { error?: unknown; choices?: unknown } } | null;
  const message = extractErrorText(shaped);

  if (message !== null) {
    // 报错：先区分「路由层拒绝」与「执行到了模型」
    if (/Available providers are:|No allowed providers/i.test(message)) {
      const match = /Available providers are:\s*([^.]+)/i.exec(message);
      const providers = match?.[1] ? parseSlugList(match[1]) : null;
      return { pinState: 'enforced', providers: providers?.length ? providers : null, routedTo: null };
    }
    if (/empty response content/i.test(message)) {
      // 请求穿过了路由层并执行——钉住参数没有被拦下，即参数未被读取
      return { pinState: 'ignored', providers: null, routedTo: null };
    }
    // 其他错误（限流/鉴权波动等）：无法判定
    return { pinState: 'unknown', providers: null, routedTo: null };
  }

  // 200：探针本应被路由层拒绝，却正常完成了 → 参数被丢弃
  const routing = parseRouting(json);
  return { pinState: 'ignored', providers: null, routedTo: routing.finalProvider };
}

function extractErrorText(shaped: { error?: unknown; data?: { error?: unknown } } | null): string | null {
  if (!shaped || typeof shaped !== 'object') return null;
  if (typeof shaped.error === 'string' && shaped.error) return shaped.error;
  if (shaped.error && typeof shaped.error === 'object') return JSON.stringify(shaped.error);
  const inner = shaped.data?.error;
  if (typeof inner === 'string' && inner) return inner;
  if (inner && typeof inner === 'object') return JSON.stringify(inner);
  return null;
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

/** 合并-学习工具：把网关报错里附带的最新渠道清单并进已知列表。 */
export function mergeLearnedProviders(meta: ModelMeta, message: string): string[] {
  const match = /Available providers are:\s*([^.]+)/.exec(String(message || ''));
  if (!match?.[1]) return [];
  const tokens = parseSlugList(match[1]);
  const before = meta.upstreams.length;
  meta.upstreams = [...new Set([...meta.upstreams, ...tokens])];
  return meta.upstreams.length > before ? meta.upstreams : [];
}

export class ProbeService {
  readonly #deps: ProbeDeps;

  constructor(deps: ProbeDeps) {
    this.#deps = deps;
  }

  /**
   * 探测单个模型：真实小请求回读管道类型与执行链，再用钉住探针判定参数是否被读取。
   * 可钉性与账号风控相关（换个账号结果可能不同），结果只代表探测时刻、所用账号的状态。
   */
  async probeModel(modelId: string): Promise<ProbeResult> {
    const account = this.#deps.pool.pick();
    const started = Date.now();
    const body = { model: modelId, messages: [{ role: 'user', content: 'Reply with the word OK' }], max_tokens: 256 };
    const { json } = await fetchJSON(
      `${this.#deps.upstreamBase}${CHAT}`,
      { method: 'POST', headers: authHeaders(account?.key ?? ''), body: JSON.stringify(body) },
      180_000,
    );

    const shaped = json as { error?: unknown; data?: { error?: unknown; choices?: unknown } } | null;
    const probeError = extractErrorText(shaped);
    if (probeError !== null && !shaped?.data?.choices) {
      return { ...this.#blank(modelId), ok: false, ms: Date.now() - started, error: probeError.slice(0, 400) };
    }

    const routing = parseRouting(json);

    // 钉住探针（D1）：判定 providerOptions/provider 是否还被网关读取
    let probe: PinProbeOutcome = { pinState: 'unknown', providers: null, routedTo: null };
    if (routing.pipeline) {
      probe = await pinProbe(this.#deps, modelId, routing.pipeline, account?.key ?? '');
    }

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

    // 渠道清单（D2）：执行链（含链首）∪ 备选 ∪ 本次实际命中 ∪ 探针清单 ∪ 历史已知
    const plannedChain = parsePlannedChain(routing.plan);
    const upstreams = [
      ...new Set([
        ...plannedChain,
        ...routing.fallbacks,
        ...(routing.finalProvider ? [routing.finalProvider] : []),
        ...(probe.providers ?? []),
        ...(routing.pipeline === 'direct' ? Object.keys(detail) : []),
        ...(prev?.upstreams ?? []),
      ]),
    ];

    // pinState：探针给出确定性结论才更新；unknown 沿用旧值（保守）
    const pinState: PinState = probe.pinState !== 'unknown' ? probe.pinState : (prev?.pinState ?? 'unknown');
    const pinDisabledReason =
      probe.pinState === 'ignored'
        ? buildIgnoredReason(routing.finalProvider, probe.routedTo)
        : probe.pinState === 'enforced'
          ? null
          : (prev?.pinDisabledReason ?? null);

    const meta: ModelMeta = {
      pipeline: routing.pipeline,
      pinnable: routing.pipeline !== null,
      pinState: routing.pipeline === null ? 'unknown' : pinState,
      pinProbeAt: probe.pinState !== 'unknown' ? Date.now() : (prev?.pinProbeAt ?? null),
      pinDisabledReason,
      availableProviders: probe.providers ?? prev?.availableProviders ?? [],
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

  /**
   * 批量校验：每个渠道各钉一次最小请求，标出真实可用性（✔可用/⏳限流/✘不可钉/🔑key错）。
   *
   * 钉住参数被网关丢弃时（pinState=ignored）拒绝执行：此时每个渠道的请求都会成功并返回
   * `empty response content`（被判为 ok），输出全绿是误导（docs/pinning.md D5）。
   */
  async validateUpstreams(modelId: string): Promise<
    | { ok: false; reason: string; pinState: PinState }
    | {
        ok: true;
        results: Record<string, { status: UpstreamStatusKind; ms: number; note: string }>;
        upstreams: string[];
        pinState: PinState;
      }
  > {
    const meta = this.#deps.getMeta(modelId);
    const list = meta?.upstreams ?? [];
    const pipeline = meta?.pipeline;
    const pinState: PinState = meta?.pinState ?? 'unknown';

    if (pinState === 'ignored') {
      return {
        ok: false,
        pinState,
        reason:
          meta?.pinDisabledReason ??
          '网关忽略钉住参数（账号风控或策略变更）：每个渠道的请求都会“成功”，校验结果不可信。请先重新探测。',
      };
    }

    const account = this.#deps.pool.pick();
    const results: Record<string, { status: UpstreamStatusKind; ms: number; note: string }> = {};

    const batch = 5;
    for (let i = 0; i < list.length; i += batch) {
      await Promise.all(
        list.slice(i, i + batch).map(async (slug) => {
          const started = Date.now();
          const base = { model: modelId, messages: [{ role: 'user', content: 'hi' }], max_tokens: 512 };
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
    return { ok: true, results, upstreams: list, pinState };
  }

  #blank(modelId: string): ModelMeta {
    return this.#deps.getMeta(modelId) ?? blankModelMeta();
  }
}

/** ignored 的原因说明：点出风控特征（openai-compatible-private）比一句“失效了”有用得多。 */
function buildIgnoredReason(mainProvider: string | null, probeRoutedTo: string | null): string {
  const routed = probeRoutedTo ?? mainProvider;
  const base = '网关忽略钉住参数（账号风控或策略变更，详见 docs/pinning.md）：钉住/排除/排序均不生效，校验已停用。';
  if (routed) return `${base}探针实测被路由到 ${routed}。`;
  return base;
}

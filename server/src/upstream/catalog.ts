import type { AccountPool } from '../accounts/pool.ts';
import { fetchJSON } from './client.ts';
import type { MetaFile } from './types.ts';

const OR_API = 'https://openrouter.ai/api/v1';

export interface OrEndpointDetail {
  slug: string;
  name?: string;
  endpoints?: number;
  context?: number;
  uptime?: number;
}

export interface OfficialFetchResult {
  sources: string[];
  found: number;
  added: string[];
  knownModels: string[];
}

export interface CatalogDeps {
  upstreamBase: string;
  pool: AccountPool;
  meta: MetaFile;
  markDirty: () => void;
  knownModels: () => string[];
  addKnownModels: (ids: string[]) => void;
}

/** slug 归一化：连字符差异（zai/... vs z-ai/...）不影响匹配。 */
const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** 目录与官方模型清单的拉取与缓存（缓存写在 metadata，重启不丢）。 */
export class CatalogService {
  readonly #deps: CatalogDeps;

  constructor(deps: CatalogDeps) {
    this.#deps = deps;
  }

  /** Cline 公开目录（/models），1 小时缓存。 */
  async catalog(signal?: AbortSignal): Promise<string[]> {
    const { meta, markDirty } = this.#deps;
    if (meta.catalog && Date.now() - meta.catalogFetchedAt < 3_600_000) return meta.catalog;
    const account = this.#deps.pool.pick();
    try {
      const { json } = await fetchJSON(
        `${this.#deps.upstreamBase}/models`,
        { headers: account ? { Authorization: `Bearer ${account.key}` } : {}, signal },
        60_000,
      );
      const ids = (((json as { data?: unknown })?.data as unknown[] | undefined) ?? [])
        .map((m) => (typeof m === 'object' && m !== null ? (m as { id?: unknown }).id : null))
        .filter((id): id is string => typeof id === 'string');
      if (ids.length) {
        meta.catalog = ids;
        meta.catalogFetchedAt = Date.now();
        markDirty();
      }
    } catch {
      /* 拉取失败沿用旧缓存 */
    }
    return meta.catalog ?? [];
  }

  /** OpenRouter 目录 id 列表，6 小时缓存。 */
  async orModelList(signal?: AbortSignal): Promise<string[]> {
    const { meta, markDirty } = this.#deps;
    if (meta.orModelList && Date.now() - meta.orModelsFetchedAt < 6 * 3_600_000) return meta.orModelList;
    const { json } = await fetchJSON(`${OR_API}/models`, { signal }, 60_000);
    const ids = (((json as { data?: unknown })?.data as unknown[] | undefined) ?? [])
      .map((m) => (typeof m === 'object' && m !== null ? (m as { id?: unknown }).id : null))
      .filter((id): id is string => typeof id === 'string');
    if (ids.length) {
      meta.orModelList = ids;
      meta.orModelsFetchedAt = Date.now();
      markDirty();
    }
    return ids;
  }

  /** OpenRouter 各渠道的 endpoint 明细（上下文长度/在线率），直连管道有直接参考意义。 */
  async orEndpoints(slug: string, signal?: AbortSignal): Promise<{ slug: string; endpoints: OrEndpointDetail[] }> {
    const ids = await this.orModelList(signal);
    const real = ids.find((id) => id === slug) ?? ids.find((id) => norm(id) === norm(slug));
    if (!real) return { slug, endpoints: [] };
    const { json } = await fetchJSON(`${OR_API}/models/${real}/endpoints`, { signal }, 60_000);
    const eps = ((json as { data?: { endpoints?: unknown } })?.data?.endpoints as unknown[] | undefined) ?? [];
    const detail: Record<string, OrEndpointDetail> = {};
    for (const raw of eps) {
      const e = raw as { tag?: string; provider_name?: string; context_length?: number; uptime_last_30m?: number };
      const providerSlug =
        String(e.tag ?? '').split('/')[0] || (e.provider_name ?? '').toLowerCase().replace(/\s+/g, '-');
      if (!providerSlug) continue;
      const existing = detail[providerSlug];
      const d = existing ?? { slug: providerSlug, name: e.provider_name };
      detail[providerSlug] = d;
      d.endpoints = (d.endpoints ?? 0) + 1;
      d.context = Math.max(d.context ?? 0, e.context_length ?? 0);
      d.uptime = Math.max(d.uptime ?? 0, Math.round(e.uptime_last_30m ?? 0));
    }
    return { slug: real, endpoints: Object.values(detail) };
  }

  /**
   * 从官方接口、社区注册表与官方文档拉取最新订阅模型清单（只增不删）。
   * 多来源互相兜底：官方推荐接口权威且最快，models.dev 是社区注册表，文档表格最后兜底。
   */
  async fetchOfficialModels(signal?: AbortSignal): Promise<OfficialFetchResult> {
    const found = new Set<string>();
    const sources: string[] = [];
    const add = (value: unknown): void => {
      const id =
        typeof value === 'string'
          ? value
          : typeof value === 'object' && value !== null
            ? (value as { id?: unknown }).id
            : null;
      if (typeof id !== 'string') return;
      const normalized = id.trim().toLowerCase();
      if (normalized.startsWith('cline-pass/')) found.add(normalized);
    };

    // 官方推荐模型接口：Cline 自己用来列出订阅模型，权威且更新最快（无需鉴权）
    try {
      const { json } = await fetchJSON('https://api.cline.bot/api/v1/ai/cline/recommended-models', { signal }, 30_000);
      const shaped = json as { clinePass?: unknown; data?: { clinePass?: unknown } } | null;
      const list = shaped?.clinePass ?? shaped?.data?.clinePass;
      if (Array.isArray(list) && list.length) {
        list.forEach(add);
        sources.push('cline.api');
      }
    } catch {
      /* 来源不可用则跳过 */
    }

    // 社区注册表 models.dev：历史响应包在 providers 下，新响应直接以 provider id 为顶层键
    try {
      const { json } = await fetchJSON('https://models.dev/api.json', { signal }, 30_000);
      const shaped = json as Record<string, unknown> | null;
      const cp = (shaped?.providers as Record<string, unknown> | undefined)?.['cline-pass'] ?? shaped?.['cline-pass'];
      const models = (cp as { models?: unknown } | null)?.models;
      if (models && typeof models === 'object') {
        for (const id of Object.keys(models as Record<string, unknown>)) {
          add(id.startsWith('cline-pass/') ? id : `cline-pass/${id}`);
        }
        sources.push('models.dev');
      }
    } catch {
      /* 来源不可用则跳过 */
    }

    // 官方文档表格兜底
    try {
      const docSignal = AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]);
      const res = await fetch('https://docs.cline.bot/getting-started/clinepass', {
        signal: docSignal,
      });
      const text = await res.text();
      const ids = text.match(/cline-pass\/[a-z0-9._-]+/gi) ?? [];
      if (ids.length) {
        for (const id of ids) found.add(id.toLowerCase());
        sources.push('docs.cline.bot');
      }
    } catch {
      /* 来源不可用则跳过 */
    }

    const valid = [...found].filter((id) => /^cline-pass\/[a-z0-9._-]+$/.test(id));
    const known = new Set(this.#deps.knownModels());
    const added = valid.filter((id) => !known.has(id));
    if (added.length) this.#deps.addKnownModels(added);

    this.#deps.meta.officialModelsFetch = {
      ts: Date.now(),
      sources,
      found: valid.length,
      added,
      total: this.#deps.knownModels().length,
    };
    this.#deps.markDirty();

    return { sources, found: valid.length, added, knownModels: this.#deps.knownModels() };
  }
}

import type { Account } from '../config/schema.ts';
import { fetchJSON } from '../upstream/client.ts';
import { errText, unwrap } from '../upstream/response.ts';
import type { AccountClassKind, AccountClassRecord } from './types.ts';

/**
 * 账号风控体检。
 *
 * 做的事只有一件：用该账号的密钥、**不带任何钉住参数**发一次最小请求，看网关
 * 默认把这个请求路由到哪。事实依据（docs/pinning.md 第五节，本机 20 小时 500 条历史）：
 *
 * - 正常账号的默认路由落在真实渠道（`deepseek` 等）
 * - 风控账号的默认路由恒为 `openai-compatible-private`，请求怎么发都出不去
 *
 * 两条边界必须守住：
 * - **这是观测值，不是账号的静态属性**：结论会随时间翻转，所以只带 `checkedAt`，
 *   绝不写进路由逻辑（路由逻辑永远按实际请求的结果走）。
 * - **失败时保留上一次的结论**：网络失败 / 额度用尽 / 网关没返回路由信息，
 *   都只更新解释（note），不把已知结论改成「未判定」——否则一次抖动就抹掉事实。
 */

/** 风控号的默认路由标记。 */
export const PRIVATE_PROVIDER = 'openai-compatible-private';

/** 单次体检的上限。这是小请求（几十 token），45s 足够；超时按「未判定」处理。 */
const CLASSIFY_TIMEOUT_MS = 45_000;

/**
 * `max_tokens` 用 256 而不是更小：推理模型在小预算下会把额度烧在思考上，
 * 网关回 HTTP 500 `empty response content`——那会被误判成「未判定」，
 * 一次误判就要用户重来一遍。多花的几十个输出 token 比误判便宜。
 */
const CLASSIFY_MAX_TOKENS = 256;

/** 纯函数：默认路由 → 分类。空值等于没看到事实，返回 unknown（不猜）。 */
export function classifyFromProvider(finalProvider: string | null | undefined): AccountClassKind {
  const p = (finalProvider ?? '').trim().toLowerCase();
  if (!p) return 'unknown';
  return p === PRIVATE_PROVIDER ? 'private' : 'normal';
}

export interface ClassifyDeps {
  upstreamBase: string;
  /** 判定模型（配置项 `classifyModel`）。 */
  classifyModel: string;
  /** 读已有结论——失败时要用它保留上一次的事实。 */
  get: (name: string) => AccountClassRecord | undefined;
  set: (name: string, record: AccountClassRecord) => void;
}

export interface ClassifyResult extends AccountClassRecord {
  name: string;
  /** 本结果是否为本次新得出结论（false = 保留旧结论，note 是失败原因）。 */
  fresh: boolean;
}

export interface ClassifySummary {
  normal: number;
  private: number;
  unknown: number;
  /** 本次没能得出结论的账号数（结论沿用旧值或仍是 unknown）。 */
  failed: number;
}

export interface ClassifyBatchResult {
  results: ClassifyResult[];
  summary: ClassifySummary;
  /** 客户端中途离开：批量提前结束，未体检的账号保持原样。 */
  cancelled: boolean;
}

function withNote(record: AccountClassRecord, note: string): AccountClassRecord {
  return { ...record, note: note.slice(0, 200) };
}

export class ClassifyService {
  readonly #deps: () => ClassifyDeps;
  #running = false;

  /** deps 用函数注入：配置与 metadata 都是就地更新的，每次体检都要读最新值。 */
  constructor(deps: () => ClassifyDeps) {
    this.#deps = deps;
  }

  /** 正在体检时拒绝第二次批量（防止连点按钮把额度翻倍消耗）。 */
  isRunning(): boolean {
    return this.#running;
  }

  /** 体检单个账号并落盘结论。失败（非取消）不抛错，返回保留旧结论的记录。 */
  async classify(account: Account, signal?: AbortSignal): Promise<ClassifyResult> {
    const deps = this.#deps();
    const prior = deps.get(account.name);

    let verdict: { kind: AccountClassKind; note?: string };
    try {
      const res = await fetchJSON(
        `${deps.upstreamBase}/chat/completions`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${account.key}` },
          // 关键：请求体里**没有任何**钉住字段——判定的是网关的默认路由，
          // 不是「参数是否被读取」（那是探针的事，见 docs/pinning.md D1）。
          body: JSON.stringify({
            model: deps.classifyModel,
            messages: [{ role: 'user', content: 'ping' }],
            max_tokens: CLASSIFY_MAX_TOKENS,
            stream: false,
          }),
          signal,
        },
        CLASSIFY_TIMEOUT_MS,
      );
      if (res.status >= 400) {
        verdict = { kind: 'unknown', note: `上游返回 HTTP ${res.status}` };
      } else if (res.json === null) {
        verdict = { kind: 'unknown', note: '上游响应不是 JSON' };
      } else {
        const u = unwrap(res.json);
        if (u.error) {
          verdict = { kind: 'unknown', note: u.error };
        } else {
          const kind = classifyFromProvider(u.routing.finalProvider);
          verdict = kind === 'unknown' ? { kind, note: '网关没有返回路由信息（finalProvider 为空）' } : { kind };
        }
      }
    } catch (err) {
      // 客户端离开不是「体检失败」：不写任何结论，交给批量循环收尾
      if (signal?.aborted) throw err;
      verdict = { kind: 'unknown', note: errText(err) };
    }

    let record: AccountClassRecord;
    let fresh: boolean;
    if (verdict.kind === 'unknown') {
      const base: AccountClassRecord = prior ?? { class: 'unknown', checkedAt: null };
      record = verdict.note ? withNote(base, verdict.note) : base;
      fresh = false;
    } else {
      record = { class: verdict.kind, checkedAt: Date.now() };
      fresh = true;
    }
    deps.set(account.name, record);
    return { name: account.name, ...record, fresh };
  }

  /** 逐个串行体检（串行是为了不把上游速率限制打满，也让进度可解释）。 */
  async classifyMany(accounts: readonly Account[], signal?: AbortSignal): Promise<ClassifyBatchResult> {
    this.#running = true;
    const results: ClassifyResult[] = [];
    let cancelled = false;
    try {
      for (const account of accounts) {
        if (signal?.aborted) {
          cancelled = true;
          break;
        }
        try {
          results.push(await this.classify(account, signal));
        } catch (err) {
          if (signal?.aborted) {
            cancelled = true;
            break;
          }
          throw err;
        }
      }
    } finally {
      this.#running = false;
    }

    const summary: ClassifySummary = { normal: 0, private: 0, unknown: 0, failed: 0 };
    for (const r of results) {
      summary[r.class] += 1;
      if (!r.fresh) summary.failed += 1;
    }
    return { results, summary, cancelled };
  }
}

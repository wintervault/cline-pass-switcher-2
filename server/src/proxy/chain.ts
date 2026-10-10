import type { AccountPool, AccountRotateInfo } from '../accounts/pool.ts';
import type { Account, FailoverConfig, PerModelConfig } from '../config/schema.ts';
import { fetchJSON } from '../upstream/client.ts';
import { classifyErrorKind } from '../upstream/errors.ts';
import { unwrap } from '../upstream/response.ts';
import { emptyRouting, injectPrefs, type RoutingInfo } from '../upstream/routing.ts';
import type { ModelMeta, PinState, TraceEntry, UpstreamErrorKind } from '../upstream/types.ts';
import { buildCandidates } from './candidates.ts';
import type { ChannelHealth } from './health.ts';

const CHAT_PATH = '/chat/completions';
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface ChainDeps {
  /** Cline 网关地址（不含路径）。 */
  upstreamBase: string;
  failover: FailoverConfig;
  pool: AccountPool;
  health: ChannelHealth;
}

export interface ChainInput {
  modelId: string;
  body: Record<string, unknown>;
  cfg?: PerModelConfig;
  meta?: ModelMeta;
  stream: boolean;
  /** 客户端断开信号——断开后整条链立即停止，不再尝试后续候选。 */
  clientSignal?: AbortSignal;
}

export interface ChainCommon {
  account: Account | null;
  trace: TraceEntry[];
  /** 排除列表无法生效（本地无渠道清单）。 */
  degraded: boolean;
  accountRotations: AccountRotateInfo[];
  /** 总预算耗尽被迫停止切换。 */
  budgetExhausted: boolean;
  totalMs: number;
}

export interface ChainSuccess extends ChainCommon {
  outcome: 'success';
  status: 200;
  body: Record<string, unknown>;
  routing: RoutingInfo;
}

export interface ChainStream extends ChainCommon {
  outcome: 'stream';
  status: 200;
  /** 上游流式响应，由调用方透传给客户端。 */
  response: Response;
  /** 已从上游消费的首块（探测 SSE 合法性时读掉的），透传时必须先写回。 */
  head: Buffer;
  /** 流式钉住审计所需信息：元数据在流末尾才出现，由调用方在流结束后比对（D3）。 */
  pinAudit: { enforced: boolean; strict: boolean; target: string | null };
}

export interface ChainFailure extends ChainCommon {
  outcome: 'failure';
  status: number;
  body: Record<string, unknown>;
  routing: RoutingInfo;
  message: string;
  kind: UpstreamErrorKind | null;
}

export type ChainResult = ChainSuccess | ChainStream | ChainFailure;

interface AttemptBase {
  ms: number;
}
interface AttemptSuccess extends AttemptBase {
  verdict: 'success';
  body: Record<string, unknown>;
  routing: RoutingInfo;
}
interface AttemptStream extends AttemptBase {
  verdict: 'stream';
  response: Response;
  head: Buffer;
}
interface AttemptError extends AttemptBase {
  verdict: 'error';
  status: number | null;
  message: string;
  kind: UpstreamErrorKind;
}
type AttemptOutcome = AttemptSuccess | AttemptStream | AttemptError;

const errorBody = (message: string): Record<string, unknown> => ({ error: { message, type: 'upstream_error' } });

/** slug 等价比较：显示名差异（GMICloud/gmicloud、z-ai/zai）不应造成审计误判。 */
export function sameSlug(a: string, b: string): boolean {
  if (a === b) return true;
  return a.toLowerCase().replace(/[^a-z0-9]/g, '') === b.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * strict 钉住的结果审计（docs/pinning.md D3）。
 * 返回 null = 通过或不适用；否则返回违规说明（作为该次尝试的失败理由）。
 *
 * - 只在「探针确认参数被读取（enforced）」时审计——ignored 时不注入也不审计，
 *   unknown（未探测）保守放行，避免把能用的请求错杀成失败；
 * - 响应不带元数据（finalProvider 为空，部分模型如此）时无法审计，放行；
 * - preferred 的最后候选与自动模式本来就让网关自由回退，不审计。
 */
function pinMismatchNote(
  target: string | null,
  strict: boolean,
  pinState: PinState,
  actual: string | null,
): string | null {
  if (target === null || !strict || pinState !== 'enforced') return null;
  if (actual === null) return null;
  if (sameSlug(actual, target)) return null;
  return `钉住未生效：目标 ${target}，网关实际由 ${actual} 提供服务`;
}

/**
 * 聊天请求的故障转移执行器。
 *
 * 策略（用户确认的设计，prompt cache 是一等约束——默认稳定，按需快速切换）：
 * - 候选顺序来自 buildCandidates（用户勾选顺序 + 冷却沉底）；
 * - 账号一次请求固定一个（保缓存）；只有**账号级错误**才 rotate 换账号重试同一渠道，
 *   轮转次数以启用账号数为上限，全部账号失败即放弃；
 * - **渠道级错误**（429/5xx/网络/超时）：同渠道退避重试 ≤ retriesPerChannel 次，
 *   仍失败则标记冷却并切换下一个候选；
 * - **请求级错误**（4xx）：同渠道重试一次即切换（不猜 invalid_request 的双重含义，
 *   用「重试是否复现」区分，代价一次请求，换来 agent 永不卡死）；
 * - 全局预算 budgetMs 封顶：每次尝试超时 = min(单次上限, 剩余预算)，耗尽立即返回最后错误。
 */
export class ChatChain {
  readonly #deps: ChainDeps;
  #onChannelFailure: ((modelId: string, upstream: string | null, message: string) => void) | null = null;

  constructor(deps: ChainDeps) {
    this.#deps = deps;
  }

  /** 渠道失败回调（调用方用于把状态学习进 metadata）。传 null 取消。 */
  onChannelFailure(listener: ((modelId: string, upstream: string | null, message: string) => void) | null): this {
    this.#onChannelFailure = listener;
    return this;
  }

  async run(input: ChainInput): Promise<ChainResult> {
    const { modelId } = input;
    const plan = buildCandidates({ modelId, cfg: input.cfg, meta: input.meta, health: this.#deps.health });
    const known = input.meta?.upstreams ?? [];
    const pipeline = input.meta?.pipeline ?? null;

    const startedAt = Date.now();
    const deadline = startedAt + this.#deps.failover.budgetMs;

    const trace: TraceEntry[] = [];
    const rotations: AccountRotateInfo[] = [];
    const failedEarlier: string[] = [];
    const maxRotations = this.#deps.pool.enabled().length;

    let account = this.#deps.pool.pick();
    let degraded = plan.degraded;
    let budgetExhausted = false;
    let lastError: { status: number; message: string; kind: UpstreamErrorKind | null } | null = null;

    // 自动模式 = 单个 null 候选；显式模式 = 渠道序列
    const candidates: (string | null)[] = plan.channels.length ? [...plan.channels] : [null];

    outer: for (let i = 0; i < candidates.length; i++) {
      const upstream = candidates[i] ?? null;
      const isLast = i === candidates.length - 1;
      let requestRetried = false;
      const maxTries = 1 + (upstream !== null ? this.#deps.failover.retriesPerChannel : 0);

      for (let tryIndex = 0; tryIndex < maxTries; tryIndex++) {
        if (input.clientSignal?.aborted) break outer;

        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          budgetExhausted = true;
          break outer;
        }
        if (tryIndex > 0) {
          const backoff = Math.min(this.#deps.failover.retryBackoffMs * tryIndex, remaining);
          if (backoff > 0) await sleep(backoff);
          if (input.clientSignal?.aborted) break outer;
        }

        // preferred 的最后一个候选放开网关回退（「本地说了算」），白名单 =
        // 已知渠道 - 用户排除 - 本次已失败的候选（避免网关回退到刚失败的渠道）
        const relax = upstream !== null && plan.pinMode === 'preferred' && isLast;
        const attemptExclude = relax
          ? [...plan.excludeList, ...failedEarlier.filter((u) => u !== upstream)]
          : [...plan.excludeList];

        const injected = injectPrefs(
          input.body,
          { pipeline, knownUpstreams: known },
          { upstream, orderRest: [], excludeList: attemptExclude, strict: !relax, sort: plan.sort },
        );
        if (injected.degraded) degraded = true;

        const timeoutMs = Math.min(this.#deps.failover.attemptTimeoutMs, remaining);
        const outcome = await this.#attempt(input, injected.body, account, timeoutMs);

        if (outcome.verdict === 'success') {
          // 钉住结果审计（docs/pinning.md D3）：strict 钉住且探针确认参数被读取时，
          // 网关自报的 finalProvider 必须等于目标渠道。不符视为该渠道确定性失败
          // （重试同渠道无意义），直接进入下一个候选。
          const mismatchNote = pinMismatchNote(
            upstream,
            !relax,
            input.meta?.pinState ?? 'unknown',
            outcome.routing.finalProvider,
          );
          if (mismatchNote !== null) {
            trace.push({ upstream, status: 200, ms: outcome.ms, note: mismatchNote });
            lastError = { status: 502, message: mismatchNote, kind: 'channel' };
            if (upstream) {
              this.#deps.health.markFailed(modelId, upstream, this.#deps.failover.cooldownMs);
              if (!failedEarlier.includes(upstream)) failedEarlier.push(upstream);
              this.#onChannelFailure?.(modelId, upstream, mismatchNote);
            }
            break; // 下一个候选
          }

          if (upstream) this.#deps.health.markSuccess(modelId, upstream);
          trace.push({ upstream, status: 200, ms: outcome.ms, note: 'ok' });
          return {
            outcome: 'success',
            status: 200,
            body: outcome.body,
            routing: outcome.routing,
            account,
            trace,
            degraded,
            accountRotations: rotations,
            budgetExhausted,
            totalMs: Date.now() - startedAt,
          };
        }

        if (outcome.verdict === 'stream') {
          if (upstream) this.#deps.health.markSuccess(modelId, upstream);
          trace.push({ upstream, status: 200, ms: outcome.ms, note: 'stream' });
          // 流式的钉住审计只能在流结束后做（元数据在最后一帧），标记随结果带出，
          // 由调用方写入历史——不撤回（docs/pinning.md D3 的诚实限制）
          return {
            outcome: 'stream',
            status: 200,
            response: outcome.response,
            head: outcome.head,
            account,
            trace,
            degraded,
            accountRotations: rotations,
            budgetExhausted,
            totalMs: Date.now() - startedAt,
            pinAudit: {
              enforced: (input.meta?.pinState ?? 'unknown') === 'enforced',
              strict: !relax,
              target: upstream,
            },
          };
        }

        // ---- 失败分支 ----
        trace.push({ upstream, status: outcome.status ?? 502, ms: outcome.ms, note: outcome.message.slice(0, 160) });
        lastError = { status: outcome.status ?? 502, message: outcome.message, kind: outcome.kind };

        if (outcome.kind === 'account') {
          // 账号级：立即换账号、同一渠道重试（换渠道没有意义）。
          // 账号尝试总数（1 + 已轮转次数）不超过启用账号数，全部失败即放弃
          if (!account || 1 + rotations.length >= maxRotations) break outer;
          const next = this.#deps.pool.rotate(account, outcome.message.slice(0, 80));
          if (!next) break outer;
          const info: AccountRotateInfo = { from: account.name, to: next.name, reason: outcome.message.slice(0, 80) };
          rotations.push(info);
          account = next;
          tryIndex -= 1; // 同渠道新账号，不消耗渠道重试次数（轮转次数由 maxRotations 封顶）
          continue;
        }

        if (upstream) {
          this.#deps.health.markFailed(modelId, upstream, this.#deps.failover.cooldownMs);
          if (!failedEarlier.includes(upstream)) failedEarlier.push(upstream);
        }
        // 自动模式（upstream=null）也回调：报错里附带的最新渠道清单会被学习合并
        this.#onChannelFailure?.(modelId, upstream, outcome.message);

        if (outcome.kind === 'request') {
          // 请求级：同渠道只多给一次机会，避免对参数错误打满所有候选
          if (requestRetried) continue outer;
          requestRetried = true;
        }
        // 渠道级：继续消耗重试次数，重试耗尽自然进入下一个候选
      }
    }

    return {
      outcome: 'failure',
      status: lastError?.status ?? 502,
      body: errorBody(
        lastError?.message ?? (budgetExhausted ? 'failover budget exhausted' : 'no upstream attempt was made'),
      ),
      routing: emptyRouting(),
      message: lastError?.message ?? (budgetExhausted ? 'failover budget exhausted' : 'no upstream attempt was made'),
      kind: lastError?.kind ?? null,
      account,
      trace,
      degraded,
      accountRotations: rotations,
      budgetExhausted,
      totalMs: Date.now() - startedAt,
    };
  }

  /** 单次向上游发起请求。任何失败都不抛出，归一成 AttemptError 由调用方决定重试还是切换。 */
  async #attempt(
    input: ChainInput,
    sendBody: Record<string, unknown>,
    account: Account | null,
    timeoutMs: number,
  ): Promise<AttemptOutcome> {
    const started = Date.now();
    const ms = () => Date.now() - started;
    const controller = new AbortController();
    // 单次尝试超时；客户端断开时立即中止（比 AbortSignal.timeout 省一个悬挂定时器）
    const timer = setTimeout(() => controller.abort(new Error(`attempt timeout (${timeoutMs}ms)`)), timeoutMs);
    timer.unref?.();
    const onClientAbort = () => controller.abort(new Error('client disconnected'));
    input.clientSignal?.addEventListener('abort', onClientAbort, { once: true });

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(account ? { Authorization: `Bearer ${account.key}` } : {}),
    };

    try {
      if (input.stream) return await this.#attemptStream(sendBody, headers, controller.signal, ms);
      return await this.#attemptJson(sendBody, headers, ms);
    } finally {
      clearTimeout(timer);
      input.clientSignal?.removeEventListener('abort', onClientAbort);
    }
  }

  async #attemptJson(
    sendBody: Record<string, unknown>,
    headers: Record<string, string>,
    ms: () => number,
  ): Promise<AttemptOutcome> {
    const url = `${this.#deps.upstreamBase}${CHAT_PATH}`;
    try {
      const {
        status: httpStatus,
        json,
        text,
      } = await fetchJSON(url, { method: 'POST', headers, body: JSON.stringify(sendBody) });
      if (!json) {
        return {
          verdict: 'error',
          status: httpStatus,
          ms: ms(),
          message: `upstream returned non-JSON: ${text.slice(0, 120)}`,
          kind: 'channel',
        };
      }
      const unwrapped = unwrap(json);
      if (unwrapped.status !== 200) {
        const message = unwrapped.error ?? 'upstream error';
        // HTTP 状态码比 unwrap 推导的更可靠（429/5xx 直接驱动分类）；
        // 网关把错误包在 200 响应体里时才用 unwrap 推导的状态
        const status = httpStatus >= 400 ? httpStatus : unwrapped.status;
        return { verdict: 'error', status, ms: ms(), message, kind: classifyErrorKind({ status, message }) };
      }
      return { verdict: 'success', body: unwrapped.body, routing: unwrapped.routing, ms: ms() };
    } catch (err) {
      return {
        verdict: 'error',
        status: null,
        ms: ms(),
        message: err instanceof Error ? err.message : String(err),
        kind: 'channel',
      };
    }
  }

  /**
   * 流式尝试：网关对流式错误可能返回 200 + text/event-stream，body 却是 {"error":...}，
   * 所以必须读首个数据块探测——真正的 SSE 首行是 "data: {...}" 且不是纯错误对象。
   * SSE 一旦开始就无法重试（首块已消费，必须原样透传）。
   */
  async #attemptStream(
    sendBody: Record<string, unknown>,
    headers: Record<string, string>,
    signal: AbortSignal,
    ms: () => number,
  ): Promise<AttemptOutcome> {
    const url = `${this.#deps.upstreamBase}${CHAT_PATH}`;
    let response: Response | null = null;
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

    try {
      response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(sendBody), signal });

      const ctype = response.headers.get('content-type') ?? '';
      let isSSE = response.status === 200 && ctype.includes('event-stream') && !!response.body;
      let head: Buffer | null = null;

      if (isSSE && response.body) {
        reader = response.body.getReader();
        const { value, done } = await reader.read();
        if (done) {
          isSSE = false;
          head = Buffer.alloc(0);
        } else {
          head = Buffer.from(value);
          const text = head.toString('utf8').trimStart();
          if (!text.startsWith('data:')) {
            isSSE = false;
          } else if (
            text
              .replace(/^data:\s*/, '')
              .slice(0, 160)
              .startsWith('{"error"')
          ) {
            // 200 + SSE 包错误体：读完整文本用于分类与学习。
            // 注意：getReader() 之后 body 已进入「已读」状态，必须继续用 reader 读，
            // 再调 response.text() 会抛 "Body is unusable"（fetch 规范行为）
            const rest = await readAll(reader);
            const full = head.toString('utf8') + rest.toString('utf8');
            const message = extractStreamError(full) ?? 'stream error';
            reader = null;
            await response.body.cancel().catch(() => {});
            return {
              verdict: 'error',
              status: 502,
              ms: ms(),
              message,
              kind: classifyErrorKind({ status: 200, message }),
            };
          }
        }
      }

      if (!isSSE) {
        let text: string;
        if (reader) {
          // 首块已消费（head），剩余部分继续用 reader 读
          const rest = await readAll(reader);
          reader = null;
          text = (head?.toString('utf8') ?? '') + rest.toString('utf8');
        } else {
          text = await response.text().catch(() => '');
        }
        let json: unknown = null;
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
        const unwrapped = json ? unwrap(json) : null;
        const message = unwrapped?.error ?? (text ? text.slice(0, 160) : 'empty stream');
        return {
          verdict: 'error',
          status: unwrapped?.status ?? response.status,
          ms: ms(),
          message,
          kind: classifyErrorKind({ status: response.status, message }),
        };
      }

      if (!head)
        return { verdict: 'error', status: response.status, ms: ms(), message: 'empty stream', kind: 'channel' };

      // 释放读锁，把流连同已消费的首块交还给调用方透传
      try {
        reader?.releaseLock();
      } catch {
        /* 已取消 */
      }
      return { verdict: 'stream', response, head, ms: ms() };
    } catch (err) {
      // 失败时要确保上游连接被关闭，不能泄漏
      try {
        reader?.releaseLock();
      } catch {
        /* 忽略 */
      }
      try {
        await response?.body?.cancel();
      } catch {
        /* 忽略 */
      }
      return {
        verdict: 'error',
        status: null,
        ms: ms(),
        message: err instanceof Error ? err.message : String(err),
        kind: 'channel',
      };
    }
  }
}

/** 用 reader 把剩余的流读完整（getReader 之后再调 response.text() 会抛 "Body is unusable"）。 */
async function readAll(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<Buffer> {
  const parts: Buffer[] = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      parts.push(Buffer.from(value));
    }
  } catch {
    /* 中断（客户端断开 / 超时） */
  }
  return Buffer.concat(parts);
}

/** 从 SSE 错误体里提取可读消息。 */
function extractStreamError(text: string): string | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  try {
    const parsed = JSON.parse(text.slice(start)) as { error?: unknown };
    if (typeof parsed.error === 'string') return parsed.error;
    if (parsed.error && typeof parsed.error === 'object') {
      const msg = (parsed.error as { message?: unknown }).message;
      if (typeof msg === 'string') return msg;
    }
    return null;
  } catch {
    return null;
  }
}

import type { UpstreamErrorKind, UpstreamStatusKind } from './types.ts';

export interface UpstreamErrorInfo {
  /** HTTP 状态码；网络失败 / 超时 / 中止时为 null。 */
  status: number | null;
  /** 归一化后的错误文本。 */
  message: string;
}

// ---------- 渠道状态五分类（探测/校验用，驱动 UI 徽章） ----------

/**
 * 渠道被单独钉住时的真实状态。
 *
 * 注意 `empty response content` 归为 ok：请求已到达模型，只是推理模型把 max_tokens
 * 全花在思考上、还没输出正文。这是探测用小请求的正常现象，不是渠道故障。
 */
export function classifyChannelStatus(message: string): UpstreamStatusKind {
  const m = String(message || '');
  if (/empty response content/i.test(m)) return 'ok';
  if (/429|rate[\s_-]?limit(ed)?|temporarily rate/i.test(m)) return 'limited';
  if (/invalid_request|modelid|no allowed providers|no available providers|not found|unsupported/i.test(m))
    return 'bad';
  if (/unauthorized|re-authenticate|401/i.test(m)) return 'auth';
  return 'unknown';
}

// ---------- 故障转移三分类（决定重试还是切换） ----------

/** 限流语言的辨识度最高（避免 "rate limit ... quota" 被误判成账号级）。 */
const RATE_LIMIT_MSG = /429|rate[\s_-]?limit|too many requests|temporarily rate|overloaded/i;
/** 账号/额度问题：换渠道毫无意义，必须换账号。 */
const ACCOUNT_MSG =
  /unauthorized|re-?authenticate|invalid\s*api[_\s-]?key|api\s*key|insufficient|billing|payment|quota/i;
/** 钉住相关的路由失败：换渠道有意义。 */
const PROVIDER_MSG = /no allowed providers|no available providers|available providers are:|modelid/i;
const TIMEOUT_MSG = /\btimeout\b|timed?\s*out/i;

export const KIND_LABEL: Record<UpstreamErrorKind, string> = {
  account: '账号级',
  channel: '渠道级',
  request: '请求级',
};

/**
 * 把上游错误分成三类，各自的处理策略不同（用户确认的设计）：
 *
 * - `account`：**立即换账号**，不重试。key 失效、额度用完时换渠道毫无意义。
 * - `channel`：**同渠道先退避重试，仍失败才切换**。429 / 5xx / 网络失败 / 超时。
 * - `request`：同渠道重试一次，仍失败则切换。
 *
 * 难点：`invalid_request_error` 在本项目有两种相反含义——钉住某渠道时该渠道映射不了
 * 模型 ID 会报它（渠道级），客户端参数错误也报它（请求级）。从错误文本无法可靠区分，
 * 所以不猜：两者都归入「先重试再切」，用「重试是否复现」这个行为来区分，
 * 代价只是多一次请求，换来 agent 永远不会被卡死（用户明确的优先级）。
 *
 * 判定顺序有讲究：网关可能把账号错误包在 200/502 响应体里，所以**文本检测先于状态码**；
 * 而限流语言又必须先于配额语言（"rate limit ... quota" 两种关键词同时出现时，限流优先）。
 */
export function classifyErrorKind(err: UpstreamErrorInfo): UpstreamErrorKind {
  // ① 无响应：网络失败 / 超时 / 中止。此时没有上游消息可分类。
  if (err.status === null) return 'channel';

  const m = String(err.message || '');

  // ② 文本检测（先于状态码，理由见函数注释）
  if (RATE_LIMIT_MSG.test(m)) return 'channel';
  if (ACCOUNT_MSG.test(m)) return 'account';
  if (PROVIDER_MSG.test(m)) return 'channel';
  if (TIMEOUT_MSG.test(m)) return 'channel';

  // ③ 状态码检测
  if (err.status === 401 || err.status === 402 || err.status === 403) return 'account';
  if (err.status === 429 || err.status >= 500) return 'channel';

  // ④ 其余 4xx：参数错误 / 模型不存在等，重试与换渠道都不会有不同结果
  if (err.status >= 400 && err.status < 500) return 'request';

  // ⑤ 200 却带未知错误体等意外情况：按渠道级处理（宁切换勿卡死）
  return 'channel';
}

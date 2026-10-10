/** 上游 HTTP 客户端：超时、错误归一。零依赖，直接用全局 fetch。 */

export class UpstreamTimeoutError extends Error {
  readonly url: string;
  readonly timeoutMs: number;
  constructor(url: string, timeoutMs: number) {
    super(`请求超时（${timeoutMs}ms）：${url}`);
    this.name = 'UpstreamTimeoutError';
    this.url = url;
    this.timeoutMs = timeoutMs;
  }
}

export interface FetchJsonResult {
  status: number;
  json: unknown;
  /** 原始响应文本。上游返回非 JSON（如 HTML 错误页）时仍可用于报错。 */
  text: string;
}

/**
 * 发请求并解析 JSON 响应。
 *
 * 与旧版的差异：超时不再让调用方拿到裸 AbortError，而是抛带上下文的
 * UpstreamTimeoutError；非 JSON 响应不再伪装成 `{raw: text}`（那会让调用方误判为成功），
 * 而是保留 text 并把 json 置为 null。
 */
export async function fetchJSON(url: string, options: RequestInit = {}, timeoutMs = 60_000): Promise<FetchJsonResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: res.status, json, text };
  } catch (err) {
    if (ctrl.signal.aborted) throw new UpstreamTimeoutError(url, timeoutMs);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

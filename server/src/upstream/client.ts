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
 * - `options.signal`：外部中止信号（客户端断开等）。与内部超时信号**合并**而不是被覆盖——
 *   `{...options, signal}` 的写法会让外部 signal 被内部 signal 静默顶掉（实测踩过）。
 * - 超时抛带上下文的 UpstreamTimeoutError，而不是裸 AbortError。
 * - 非 JSON 响应保留 text、json 置 null，让调用方决定如何归类。
 */
export async function fetchJSON(url: string, options: RequestInit = {}, timeoutMs = 60_000): Promise<FetchJsonResult> {
  const ctrl = new AbortController();
  const external = options.signal;
  const onExternalAbort = () => ctrl.abort(external instanceof AbortSignal ? external.reason : undefined);
  if (external) {
    if (external.aborted) ctrl.abort(external.reason);
    else external.addEventListener('abort', onExternalAbort, { once: true });
  }
  const timer = setTimeout(() => ctrl.abort(new Error(`upstream timeout (${timeoutMs}ms)`)), timeoutMs);
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
    if (ctrl.signal.aborted) {
      const reason = ctrl.signal.reason;
      if (reason instanceof Error && /upstream timeout/.test(reason.message))
        throw new UpstreamTimeoutError(url, timeoutMs);
      if (external?.aborted) throw err instanceof Error ? err : new Error(String(err));
      throw new UpstreamTimeoutError(url, timeoutMs);
    }
    throw err;
  } finally {
    clearTimeout(timer);
    external?.removeEventListener('abort', onExternalAbort);
  }
}

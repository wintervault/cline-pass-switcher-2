import { parseRouting, type RoutingInfo } from './routing.ts';

/** 把任意形态的上游错误归一成短字符串（用于分类、学习与尝试日志）。 */
export function errText(e: unknown): string {
  if (e == null) return '';
  if (typeof e === 'string') return e;
  if (e instanceof Error) return e.message;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

export interface Unwrapped {
  status: number;
  body: Record<string, unknown>;
  routing: RoutingInfo;
  /** 归一化后的错误文本；成功时为 null。 */
  error: string | null;
}

/**
 * 解包上游响应：
 * - 剥掉 Cline 的 `{"data": {...}}` 包装，得到标准 OpenAI 形状；
 * - 错误统一成 `{"error":{"message":...}}`——「model not found」映射 404，其余映射 502；
 * - 同时解析路由元数据（实际上游、背后模型），供响应头与历史记录使用。
 *
 * 纯函数，不改入参。
 */
export function unwrap(json: unknown): Unwrapped {
  const top =
    json !== null && typeof json === 'object' && !Array.isArray(json) ? (json as Record<string, unknown>) : {};
  const innerData = top['data'];
  // data 包装的两种形态都取内层：{"data":{choices:[...]}} 成功体、{"data":{error:...}} 错误体
  const d =
    innerData !== null &&
    typeof innerData === 'object' &&
    !Array.isArray(innerData) &&
    (Array.isArray((innerData as Record<string, unknown>)['choices']) ||
      'error' in (innerData as Record<string, unknown>))
      ? (innerData as Record<string, unknown>)
      : top;

  const hasChoices = Array.isArray(d['choices']);
  const err = d['error'];

  if (err && !hasChoices) {
    const msg = errText(err);
    const status = /model not found/i.test(msg) ? 404 : 502;
    return {
      status,
      body: { error: { message: msg, type: 'upstream_error' } },
      routing: parseRouting(d),
      error: msg,
    };
  }

  return { status: 200, body: d, routing: parseRouting(d), error: null };
}

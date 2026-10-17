const KEY_STORAGE = 'cps_key';

let authKey = localStorage.getItem(KEY_STORAGE) ?? '';

export function getAuthKey(): string {
  return authKey;
}

export function setAuthKey(key: string): void {
  authKey = key;
  if (key) localStorage.setItem(KEY_STORAGE, key);
  else localStorage.removeItem(KEY_STORAGE);
}

export class UnauthorizedError extends Error {
  constructor() {
    super('unauthorized');
    this.name = 'UnauthorizedError';
  }
}

/**
 * 服务端错误。控制台能看到的错误自带稳定 `code + params`，
 * 由 `feedback` 统一按当前语言翻译（未知 code 用原 message 兜底）。
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly params?: Record<string, string | number>;

  constructor(message: string, status: number, code?: string, params?: Record<string, string | number>) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.params = params;
  }
}

export interface ApiOptions {
  json?: unknown;
  method?: 'GET' | 'POST';
  /** 查询参数（多网关的 `?gateway=` 都走这里，别各自拼字符串）。 */
  query?: Record<string, string | number | boolean | undefined>;
}

function withQuery(path: string, query: ApiOptions['query']): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const qs = params.toString();
  if (!qs) return path;
  return `${path}${path.includes('?') ? '&' : '?'}${qs}`;
}

/** 控制台 API 客户端：自动附带 X-Admin-Key；401 抛 UnauthorizedError 由全局登录框处理。 */
export async function api<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (authKey) headers['X-Admin-Key'] = authKey;
  let body: string | undefined;
  if (options.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.json);
  }
  const res = await fetch(withQuery(path, options.query), {
    method: options.method ?? (body !== undefined ? 'POST' : 'GET'),
    headers,
    body,
  });
  if (res.status === 401) throw new UnauthorizedError();
  if (!res.ok) {
    // 服务端错误体形状不一：{error:{message}} / {error:"..."} / {error:...} / 纯文本——都归一成人话
    const raw = await res.text().catch(() => '');
    let detail = raw.slice(0, 300);
    let code: string | undefined;
    let params: Record<string, string | number> | undefined;
    try {
      const parsed = JSON.parse(raw) as { error?: unknown; message?: unknown };
      if (typeof parsed.error === 'string') detail = parsed.error;
      else if (parsed.error && typeof parsed.error === 'object') {
        const e = parsed.error as { message?: unknown; code?: unknown; params?: unknown };
        if (typeof e.message === 'string') detail = e.message;
        if (typeof e.code === 'string') code = e.code;
        if (e.params && typeof e.params === 'object') params = e.params as Record<string, string | number>;
      } else if (typeof parsed.message === 'string') detail = parsed.message;
    } catch {
      /* 非 JSON 错误体，用原文 */
    }
    throw new ApiError(detail || `${res.status} ${res.statusText}`, res.status, code, params);
  }
  return (await res.json()) as T;
}

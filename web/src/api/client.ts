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

export interface ApiOptions {
  json?: unknown;
  method?: 'GET' | 'POST';
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
  const res = await fetch(path, { method: options.method ?? (body !== undefined ? 'POST' : 'GET'), headers, body });
  if (res.status === 401) throw new UnauthorizedError();
  if (!res.ok) {
    // 服务端错误体形状不一：{error:{message}} / {error:"..."} / {error:...} / 纯文本——都归一成人话
    const raw = await res.text().catch(() => '');
    let detail = raw.slice(0, 300);
    try {
      const parsed = JSON.parse(raw) as { error?: unknown; message?: unknown };
      if (typeof parsed.error === 'string') detail = parsed.error;
      else if (parsed.error && typeof parsed.error === 'object') {
        const m = (parsed.error as { message?: unknown }).message;
        if (typeof m === 'string') detail = m;
      } else if (typeof parsed.message === 'string') detail = parsed.message;
    } catch {
      /* 非 JSON 错误体，用原文 */
    }
    throw new Error(detail || `${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

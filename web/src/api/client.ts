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
  if (!res.ok) throw new Error(`${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  return (await res.json()) as T;
}

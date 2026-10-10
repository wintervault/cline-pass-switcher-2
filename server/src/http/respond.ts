import type http from 'node:http';

/**
 * 所有响应统一带上的安全头。
 * 前端是 React 构建产物、没有内联脚本，所以 CSP 可以直接收紧到只允许同源资源。
 */
const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
};

export function applySecurityHeaders(res: http.ServerResponse): void {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
    if (!res.hasHeader(k)) res.setHeader(k, v);
  }
}

export function sendJSON(res: http.ServerResponse, status: number, body: unknown): void {
  applySecurityHeaders(res);
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

/** 统一的错误响应形状，与 OpenAI 兼容客户端期望的 `{error:{message}}` 一致。 */
export function sendError(
  res: http.ServerResponse,
  status: number,
  message: string,
  type = 'invalid_request_error',
): void {
  sendJSON(res, status, { error: { message, type } });
}

export function sendText(
  res: http.ServerResponse,
  status: number,
  body: string,
  contentType = 'text/plain; charset=utf-8',
): void {
  applySecurityHeaders(res);
  res.writeHead(status, { 'Content-Type': contentType, 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

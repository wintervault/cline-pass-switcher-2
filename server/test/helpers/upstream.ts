import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface ScriptedResponse {
  status?: number;
  /** JSON 响应体。 */
  body?: unknown;
  /** 原始响应体（优先于 body）。 */
  raw?: string;
  /** SSE 流：逐块写出的文本片段（自动带 text/event-stream）。 */
  sse?: string[];
  delayMs?: number;
  contentType?: string;
  headers?: Record<string, string>;
}

export interface CapturedRequest {
  path: string;
  auth: string | null;
  body: Record<string, unknown>;
}

/** 可编排响应序列的假上游：script() 按次序吐出响应，requests 记录每次请求。 */
export class FakeUpstream {
  readonly server = http.createServer((req, res) => {
    void this.#handle(req, res);
  });
  readonly requests: CapturedRequest[] = [];
  #script: ScriptedResponse[] = [];
  #closed = false;

  /** 后续请求按此序列响应；序列耗尽后默认返回成功响应。 */
  script(responses: ScriptedResponse[]): void {
    this.#script = [...responses];
  }

  /** 已收到的请求数。 */
  get count(): number {
    return this.requests.length;
  }

  reset(): void {
    this.requests.length = 0;
    this.#script = [];
  }

  async listen(): Promise<string> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    const address = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}`;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  async #handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let raw = '';
    req.on('data', (c: Buffer) => {
      raw += c.toString('utf8');
    });
    req.on('end', () => {
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        /* 非 JSON 请求体 */
      }
      this.requests.push({
        path: req.url ?? '',
        auth: (req.headers.authorization as string | undefined) ?? null,
        body,
      });

      const next: ScriptedResponse = this.#script.shift() ?? {
        status: 200,
        body: { choices: [{ message: { content: 'ok' } }] },
      };
      const respond = () => {
        if (res.destroyed) return;
        const sseChunks = next.sse;
        if (sseChunks) {
          res.writeHead(next.status ?? 200, { 'Content-Type': 'text/event-stream', ...(next.headers ?? {}) });
          let i = 0;
          const timer = setInterval(() => {
            if (i >= sseChunks.length) {
              clearInterval(timer);
              res.end();
              return;
            }
            res.write(sseChunks[i]);
            i += 1;
          }, 5);
          res.on('close', () => clearInterval(timer));
          return;
        }
        const payload = next.raw ?? JSON.stringify(next.body ?? {});
        res.writeHead(next.status ?? 200, {
          'Content-Type': next.contentType ?? 'application/json',
          ...(next.headers ?? {}),
        });
        res.end(payload);
      };
      if (next.delayMs) setTimeout(respond, next.delayMs);
      else respond();
    });
  }
}

import { Transform, type TransformCallback } from 'node:stream';

import { slugify } from '../upstream/routing.ts';

export interface RoutingTapResult {
  provider: string | null;
  canonical: string | null;
}

/**
 * 流式响应的元数据抽头：原样透传每个 chunk，同时增量解析「本次实际命中的上游」。
 *
 * 旧版把整个响应体缓存进数组、等 flush 时再正则捞 finalProvider —— 长回答内存暴涨，
 * 恰好抵消了流式的意义。这里只保留**尾部滑动窗口**：两类元数据都出现在流的末尾
 * （planner 的 routing 在最后一个 chunk，direct 的 provider 在最后的数据块），
 * 16KB 窗口绰绰有余，内存占用恒定。
 *
 * 窗口可能把最老的一行截断，导致该行 JSON 解析失败——只影响 direct 管道的
 * 「最后 10 行」扫描里最旧的一行，而目标行（最后一个数据块）总是完整的。
 */
export class RoutingTap extends Transform {
  #window: Buffer = Buffer.alloc(0);
  #windowSize: number;
  provider: string | null = null;
  canonical: string | null = null;

  constructor(windowSize = 16 * 1024) {
    super();
    this.#windowSize = windowSize;
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    const merged = this.#window.length === 0 ? chunk : Buffer.concat([this.#window, chunk]);
    this.#window = merged.length > this.#windowSize ? merged.subarray(merged.length - this.#windowSize) : merged;
    callback(null, chunk);
  }

  override _flush(callback: TransformCallback): void {
    const text = this.#window.toString('utf8');

    // planner 管道：final chunk 的 provider_metadata.gateway.routing
    const fp = /"finalProvider":"([^"]+)"/.exec(text);
    const cs = /"canonicalSlug":"([^"]+)"/.exec(text);
    if (fp?.[1]) this.provider = fp[1];
    if (cs?.[1]) this.canonical = cs[1];

    // direct 管道：最后一个数据块顶层带 provider（显示名）与 model（真实 ID）
    if (!this.provider) {
      const lines = text.split('\n');
      const start = Math.max(0, lines.length - 10);
      for (let i = lines.length - 1; i >= start && !this.provider; i--) {
        const line = lines[i] ?? '';
        if (!line.startsWith('data:') || line.includes('[DONE]')) continue;
        try {
          const chunk = JSON.parse(line.replace(/^data:\s*/, '')) as { provider?: unknown; model?: unknown };
          if (typeof chunk.provider === 'string') {
            this.provider = slugify(chunk.provider);
            this.canonical = typeof chunk.model === 'string' ? chunk.model : this.canonical;
          }
        } catch {
          /* 窗口边缘的不完整行，跳过 */
        }
      }
    }

    callback();
  }

  /** 流结束后的解析结果。 */
  result(): RoutingTapResult {
    return { provider: this.provider, canonical: this.canonical };
  }
}

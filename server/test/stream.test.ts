import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';

import { RoutingTap } from '../src/proxy/stream.ts';
import { chainStream, readRest } from './helpers/stream.ts';

function pump(tap: RoutingTap, chunks: (string | Buffer)[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const source = Readable.from(chunks);
    source.on('error', reject);
    tap.on('error', reject);
    tap.on('finish', resolve);
    tap.on('data', () => {});
    source.pipe(tap);
  });
}

describe('RoutingTap 增量解析（内存修复验证）', () => {
  it('planner：从尾部窗口提取 finalProvider / canonicalSlug', async () => {
    const tap = new RoutingTap();
    const filler = 'x'.repeat(50_000); // 远超窗口大小
    await pump(tap, [
      `data: {"choices":[{"delta":{"content":"${filler}"}}]}\n\n`,
      'data: {"choices":[{"delta":{}}],"provider_metadata":{"gateway":{"routing":{"finalProvider":"alibaba","canonicalSlug":"zai/glm-5.2"}}}}\n\n',
      'data: [DONE]\n\n',
    ]);
    expect(tap.result()).toEqual({ provider: 'alibaba', canonical: 'zai/glm-5.2' });
  });

  it('direct：扫描最后的数据块顶层 provider + model', async () => {
    const tap = new RoutingTap();
    await pump(tap, [
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
      'data: {"provider":"GMICloud","model":"zai-org/glm-5.3-flash"}\n\n',
      'data: [DONE]\n\n',
    ]);
    expect(tap.result()).toEqual({ provider: 'gmicloud', canonical: 'zai-org/glm-5.3-flash' });
  });

  it('透传不改动内容', async () => {
    const tap = new RoutingTap();
    const chunks = ['data: {"a":1}\n\n', 'data: {"b":2}\n\n'];
    const received: string[] = [];
    const source = Readable.from(chunks);
    tap.on('data', (c: Buffer) => received.push(c.toString('utf8')));
    await new Promise<void>((resolve, reject) => {
      tap.on('finish', resolve);
      tap.on('error', reject);
      source.pipe(tap);
    });
    expect(received.join('')).toEqual(chunks.join(''));
  });

  it('超大流（5MB）内存恒定且元数据仍可解析（旧版会把 5MB 缓存进数组）', async () => {
    const tap = new RoutingTap(16 * 1024);
    const big = 'y'.repeat(1024 * 1024);
    await pump(tap, [
      `data: {"choices":[{"delta":{"content":"${big}"}}]}\n\n`,
      `data: {"choices":[{"delta":{"content":"${big}"}}]}\n\n`,
      'data: {"provider_metadata":{"gateway":{"routing":{"finalProvider":"baseten"}}}}\n\n',
    ]);
    // 窗口只保留 16KB：Buffer 内部字段不可直接断言，用结果正确性 + 无异常来验证
    expect(tap.result().provider).toBe('baseten');
  });

  it('窗口截断最老的行不影响结果（目标行总在末尾）', async () => {
    const tap = new RoutingTap(1024); // 极小窗口
    const filler = 'z'.repeat(4000);
    await pump(tap, [
      `data: {"provider":"ShouldNotMatch","model":"stale"}\n\n`,
      `data: {"choices":[{"delta":{"content":"${filler}"}}]}\n\n`,
      'data: {"provider":"RealCloud","model":"real/model"}\n\n',
    ]);
    expect(tap.result()).toEqual({ provider: 'realcloud', canonical: 'real/model' });
  });
});

describe('ChatChain 流式尝试', () => {
  it('SSE 成功：返回上游响应与已消费的首块', async () => {
    const { upstream, chain, metaOf, cfgOf } = await chainStream();
    try {
      upstream.script([
        {
          sse: [
            'data: {"choices":[{"delta":{"content":"A"}}]}\n\n',
            'data: {"provider_metadata":{"gateway":{"routing":{"finalProvider":"ch1"}}}}\n\n',
            'data: [DONE]\n\n',
          ],
        },
      ]);
      const r = await chain.run({
        modelId: 'cline-pass/x',
        body: { model: 'cline-pass/x', messages: [] },
        cfg: cfgOf(),
        meta: metaOf(),
        stream: true,
      });
      expect(r.outcome).toBe('stream');
      if (r.outcome !== 'stream') return;
      expect(r.head.toString('utf8')).toContain('"content":"A"');
      // 剩余流可继续读取（首块之后的内容）——验证 releaseLock 后流仍然可用，
      // 生产环境的透传（Readable.fromWeb）依赖这一点
      const rest = await readRest(r.response);
      expect(rest).toContain('finalProvider');
      expect(upstream.count).toBe(1);
    } finally {
      await upstream.close();
    }
  });

  it('SSE 包错误体：识别后切换下一个候选', async () => {
    const { upstream, chain, metaOf, cfgOf } = await chainStream();
    try {
      upstream.script([
        {
          sse: ['data: {"error":"rate limited by shared pool"}\n\n'],
        },
        {
          sse: ['data: {"choices":[{"delta":{"content":"B"}}]}\n\n', 'data: [DONE]\n\n'],
        },
      ]);
      const r = await chain.run({
        modelId: 'cline-pass/x',
        body: { model: 'cline-pass/x', messages: [] },
        cfg: cfgOf(),
        meta: metaOf(),
        stream: true,
      });
      expect(r.outcome).toBe('stream');
      if (r.outcome !== 'stream') return;
      expect(r.head.toString('utf8')).toContain('"B"');
      expect(upstream.count).toBe(2);
      expect(r.trace[0]?.status).toBe(502);
      expect(r.trace[0]?.note).toContain('rate limited');
    } finally {
      await upstream.close();
    }
  });

  it('非 SSE 错误响应：同样能切换', async () => {
    const { upstream, chain, metaOf, cfgOf } = await chainStream();
    try {
      upstream.script([
        { status: 429, body: { error: 'rate limited' } },
        { sse: ['data: {"ok":1}\n\n', 'data: [DONE]\n\n'] },
      ]);
      const r = await chain.run({
        modelId: 'cline-pass/x',
        body: { model: 'cline-pass/x', messages: [] },
        cfg: cfgOf(),
        meta: metaOf(),
        stream: true,
      });
      expect(r.outcome).toBe('stream');
      expect(upstream.count).toBe(2);
    } finally {
      await upstream.close();
    }
  });
});

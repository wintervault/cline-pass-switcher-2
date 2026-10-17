import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AccountPool } from '../src/accounts/pool.ts';
import { defaultConfig } from '../src/config/schema.ts';
import { buildCandidates, type CoolingCheck } from '../src/proxy/candidates.ts';
import { type ChainFailure, type ChainResult, type ChainSuccess, ChatChain } from '../src/proxy/chain.ts';
import { ChannelHealth } from '../src/proxy/health.ts';
import type { ModelMeta } from '../src/upstream/types.ts';
import { FakeUpstream } from './helpers/upstream.ts';

function asSuccess(r: ChainResult): ChainSuccess {
  if (r.outcome !== 'success') throw new Error(`期望 success，实际 ${r.outcome}：${JSON.stringify(r.trace)}`);
  return r;
}
function asFailure(r: ChainResult): ChainFailure {
  if (r.outcome !== 'failure') throw new Error(`期望 failure，实际 ${r.outcome}`);
  return r;
}

let upstream: FakeUpstream;
let base: string;
let health: ChannelHealth;
let pool: AccountPool;
let config = defaultConfig();

/** 主网关（3.0 起 failover / 账号策略都是网关级的）。 */
const gw = () => {
  const gateway = config.gateways[0];
  if (!gateway) throw new Error('缺少主网关');
  return gateway;
};
const makePool = (): AccountPool =>
  new AccountPool(() => ({
    accounts: config.accounts,
    accountMode: gw().accountMode,
    activeAccount: gw().activeAccount,
  }));

beforeEach(async () => {
  upstream = new FakeUpstream();
  base = await upstream.listen();
  health = new ChannelHealth();
  config = defaultConfig();
  config.accounts = [
    { name: 'A', key: 'sk_a', enabled: true },
    { name: 'B', key: 'sk_b', enabled: true },
  ];
  pool = makePool();
});

afterEach(async () => {
  await upstream.close();
});

const makeChain = (): ChatChain =>
  new ChatChain({
    upstreamBase: base,
    failover: gw().failover,
    pool,
    health,
  });

const metaOf = (over: Partial<ModelMeta> = {}): ModelMeta => ({
  pipeline: 'planner',
  pinnable: true,
  pinState: 'enforced',
  pinProbeAt: null,
  pinDisabledReason: null,
  availableProviders: [],
  upstreams: ['ch1', 'ch2', 'ch3'],
  upstreamDetail: {},
  upstreamStatus: {},
  tier0: [],
  canonicalSlug: null,
  openrouterSlug: null,
  lastProvider: null,
  lastMs: null,
  probedAt: null,
  validatedAt: null,
  ...over,
});

const cfgOf = (over: Record<string, unknown> = {}) => ({
  upstreams: ['ch1', 'ch2'],
  exclude: [],
  pinMode: 'strict' as const,
  sort: null,
  ...over,
});

const bodyOf = () => ({ model: 'cline-pass/x', messages: [{ role: 'user', content: 'hi' }] });

const okBody = (provider = 'ch1') => ({
  data: {
    choices: [{ message: { content: 'ok' } }],
    provider_metadata: { gateway: { routing: { finalProvider: provider } } },
  },
});

const err = (message: string) => ({ error: message });

describe('ChatChain 故障转移', () => {
  it('首个候选成功：一次请求，不重试', async () => {
    upstream.script([{ status: 200, body: okBody('ch1') }]);
    const chain = makeChain();
    const r: ChainResult = await chain.run({
      modelId: 'cline-pass/x',
      body: bodyOf(),
      cfg: cfgOf(),
      meta: metaOf(),
      stream: false,
    });
    const ok = asSuccess(r);
    expect(upstream.count).toBe(1);
    expect(ok.trace).toHaveLength(1);
    expect(ok.routing.finalProvider).toBe('ch1');
  });

  it('渠道级失败：同渠道重试后切换下一个候选', async () => {
    upstream.script([
      { status: 429, body: err('rate limited') },
      { status: 429, body: err('rate limited') }, // ch1 的重试（retriesPerChannel=1）
      { status: 200, body: okBody('ch2') },
    ]);
    const chain = makeChain();
    const r = await chain.run({ modelId: 'cline-pass/x', body: bodyOf(), cfg: cfgOf(), meta: metaOf(), stream: false });
    expect(r.outcome).toBe('success');
    expect(upstream.count).toBe(3);
    expect(r.trace.map((t) => t.upstream)).toEqual(['ch1', 'ch1', 'ch2']);
    // 失败渠道进入冷却
    expect(health.isCooling('cline-pass/x', 'ch1')).toBe(true);
    expect(health.isCooling('cline-pass/x', 'ch2')).toBe(false);
  });

  it('重试成功则不切换渠道，也不进冷却', async () => {
    upstream.script([
      { status: 502, body: err('bad gateway') },
      { status: 200, body: okBody('ch1') },
    ]);
    const chain = makeChain();
    const r = await chain.run({ modelId: 'cline-pass/x', body: bodyOf(), cfg: cfgOf(), meta: metaOf(), stream: false });
    expect(r.outcome).toBe('success');
    expect(upstream.count).toBe(2);
    expect(r.trace.map((t) => t.upstream)).toEqual(['ch1', 'ch1']);
    expect(health.isCooling('cline-pass/x', 'ch1')).toBe(false);
  });

  it('账号级失败：立即换账号、同一渠道重试，且不消耗渠道切换', async () => {
    upstream.script([
      { status: 401, body: err('Unauthorized') },
      { status: 200, body: okBody('ch1') },
    ]);
    const chain = makeChain();
    const r = await chain.run({ modelId: 'cline-pass/x', body: bodyOf(), cfg: cfgOf(), meta: metaOf(), stream: false });
    expect(r.outcome).toBe('success');
    expect(upstream.count).toBe(2);
    // 同一渠道：两次请求都钉住 ch1，只有 Authorization 变了
    expect(upstream.requests[0]?.auth).toBe('Bearer sk_a');
    expect(upstream.requests[1]?.auth).toBe('Bearer sk_b');
    expect(upstream.requests[1]?.body['providerOptions']).toEqual({ gateway: { only: ['ch1'] } });
    expect(r.accountRotations).toHaveLength(1);
    expect(r.accountRotations[0]).toMatchObject({ from: 'A', to: 'B' });
  });

  it('账号级失败但只有一个账号：直接把错误给客户端，不打后续候选', async () => {
    config.accounts = [{ name: 'A', key: 'sk_a', enabled: true }];
    pool = makePool();
    upstream.script([{ status: 401, body: err('Unauthorized') }]);
    const chain = makeChain();
    const r = asFailure(
      await chain.run({ modelId: 'cline-pass/x', body: bodyOf(), cfg: cfgOf(), meta: metaOf(), stream: false }),
    );
    expect(upstream.count).toBe(1); // 没有尝试 ch2
    expect(r.trace).toHaveLength(1);
  });

  it('全部账号都账号级失败：轮转一轮后放弃', async () => {
    upstream.script([
      { status: 401, body: err('Unauthorized') },
      { status: 401, body: err('Unauthorized') },
    ]);
    const chain = makeChain();
    const r = asFailure(
      await chain.run({ modelId: 'cline-pass/x', body: bodyOf(), cfg: cfgOf(), meta: metaOf(), stream: false }),
    );
    expect(upstream.count).toBe(2);
    expect(r.accountRotations).toHaveLength(1);
    expect(r.trace.map((t) => t.upstream)).toEqual(['ch1', 'ch1']); // 没有切渠道
  });

  it('请求级失败（400）：同渠道重试一次后切换', async () => {
    upstream.script([
      { status: 400, body: err('messages must be an array') },
      { status: 400, body: err('messages must be an array') },
      { status: 200, body: okBody('ch2') },
    ]);
    const chain = makeChain();
    const r = await chain.run({ modelId: 'cline-pass/x', body: bodyOf(), cfg: cfgOf(), meta: metaOf(), stream: false });
    expect(r.outcome).toBe('success');
    expect(upstream.count).toBe(3);
    expect(r.trace.map((t) => t.upstream)).toEqual(['ch1', 'ch1', 'ch2']);
  });

  it('客户端断开：整条链立即停止，不再打后续候选（旧版缺陷）', async () => {
    const controller = new AbortController();
    upstream.script([
      { status: 429, body: err('rate limited'), delayMs: 10 },
      { status: 200, body: okBody('ch2') },
    ]);
    const chain = makeChain();
    const pending = chain.run({
      modelId: 'cline-pass/x',
      body: bodyOf(),
      cfg: cfgOf(),
      meta: metaOf(),
      stream: false,
      clientSignal: controller.signal,
    });
    // 等第一次尝试发出后立刻断开
    await new Promise((r) => setTimeout(r, 30));
    controller.abort();
    // 客户端走了：不是上游失败，如实标成「取消」（不记历史、不写响应）
    expect((await pending).outcome).toBe('cancelled');
    expect(upstream.count).toBeLessThan(2); // 客户端走了就不再花钱
  });

  it('断连导致的在飞请求失败不算渠道故障：不冷却、不进 trace', async () => {
    const controller = new AbortController();
    upstream.script([{ status: 200, body: okBody('ch1'), delayMs: 300 }]);
    const chain = makeChain();
    const pending = chain.run({
      modelId: 'cline-pass/x',
      body: bodyOf(),
      cfg: cfgOf(),
      meta: metaOf(),
      stream: false,
      clientSignal: controller.signal,
    });
    await new Promise((r) => setTimeout(r, 30));
    controller.abort();
    const r = await pending;
    expect(r.outcome).toBe('cancelled');
    // 用户取消（agent 里按 Esc 很常见）不应把渠道打入冷却 5 分钟
    expect(health.isCooling('cline-pass/x', 'ch1')).toBe(false);
    expect(r.trace).toHaveLength(0);
  });

  it('全局预算耗尽：立即返回最后错误，不再切换', async () => {
    gw().failover.budgetMs = 120;
    gw().failover.attemptTimeoutMs = 500;
    gw().failover.retriesPerChannel = 0;
    pool = makePool();
    upstream.script([
      { status: 429, body: err('rate limited'), delayMs: 100 },
      { status: 429, body: err('rate limited'), delayMs: 100 },
      { status: 429, body: err('rate limited'), delayMs: 100 },
    ]);
    const chain = makeChain();
    const started = Date.now();
    const r = asFailure(
      await chain.run({
        modelId: 'cline-pass/x',
        body: bodyOf(),
        cfg: cfgOf({ upstreams: ['ch1', 'ch2', 'ch3'] }),
        meta: metaOf({ upstreams: ['ch1', 'ch2', 'ch3'] }),
        stream: false,
      }),
    );
    expect(r.budgetExhausted).toBe(true);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(upstream.count).toBeLessThan(3); // 预算撑不起三次尝试
  });

  it('全部候选失败：返回最后的错误与完整 trace', async () => {
    gw().failover.retriesPerChannel = 0;
    pool = makePool();
    upstream.script([
      { status: 429, body: err('rate limited ch1') },
      { status: 500, body: err('boom ch2') },
    ]);
    const chain = makeChain();
    const r = asFailure(
      await chain.run({ modelId: 'cline-pass/x', body: bodyOf(), cfg: cfgOf(), meta: metaOf(), stream: false }),
    );
    expect(r.status).toBe(500); // HTTP 状态码被保留（旧版 unwrap 会丢成 502）
    expect(r.message).toContain('boom ch2');
    expect(r.trace.map((t) => t.upstream)).toEqual(['ch1', 'ch2']);
    expect(r.degraded).toBe(false);
  });
});

describe('ChatChain 钉住语义（本地说了算）', () => {
  it('strict 模式：每个候选只钉自己', async () => {
    gw().failover.retriesPerChannel = 0;
    pool = makePool();
    upstream.script([
      { status: 429, body: err('rate limited') },
      { status: 200, body: okBody('ch2') },
    ]);
    const chain = makeChain();
    await chain.run({ modelId: 'cline-pass/x', body: bodyOf(), cfg: cfgOf(), meta: metaOf(), stream: false });
    expect(upstream.requests[0]?.body['providerOptions']).toEqual({ gateway: { only: ['ch1'] } });
    expect(upstream.requests[1]?.body['providerOptions']).toEqual({ gateway: { only: ['ch2'] } });
  });

  it('preferred 模式：前面的候选 strict，只给最后一个放开网关回退', async () => {
    gw().failover.retriesPerChannel = 0;
    pool = makePool();
    upstream.script([
      { status: 429, body: err('rate limited') },
      { status: 200, body: okBody('ch2') },
    ]);
    const chain = makeChain();
    await chain.run({
      modelId: 'cline-pass/x',
      body: bodyOf(),
      cfg: cfgOf({ pinMode: 'preferred', upstreams: ['ch1', 'ch2'] }),
      meta: metaOf({ upstreams: ['ch1', 'ch2', 'ch3'] }),
      stream: false,
    });
    // 第一个候选：strict
    expect(upstream.requests[0]?.body['providerOptions']).toEqual({ gateway: { only: ['ch1'] } });
    // 最后一个候选：order 首位 + 白名单（排除已失败的 ch1）
    expect(upstream.requests[1]?.body['providerOptions']).toEqual({
      gateway: { order: ['ch2'], only: ['ch2', 'ch3'] },
    });
  });

  it('自动模式：不钉住，排除换算成白名单', async () => {
    upstream.script([{ status: 200, body: okBody('ch2') }]);
    const chain = makeChain();
    await chain.run({
      modelId: 'cline-pass/x',
      body: bodyOf(),
      cfg: cfgOf({ upstreams: [], exclude: ['ch1'] }),
      meta: metaOf({ upstreams: ['ch1', 'ch2', 'ch3'] }),
      stream: false,
    });
    expect(upstream.requests[0]?.body['providerOptions']).toEqual({ gateway: { only: ['ch2', 'ch3'] } });
  });

  it('自动模式 + 排除但未探测过 → degraded=true 且不注入空白名单', async () => {
    upstream.script([{ status: 200, body: okBody('x') }]);
    const chain = makeChain();
    const r = asSuccess(
      await chain.run({
        modelId: 'cline-pass/x',
        body: bodyOf(),
        cfg: cfgOf({ upstreams: [], exclude: ['ch1'] }),
        meta: metaOf({ upstreams: [] }),
        stream: false,
      }),
    );
    expect(r.degraded).toBe(true);
    expect(upstream.requests[0]?.body['providerOptions']).toBeUndefined();
  });

  it('direct 管道注入顶层 provider，planner 注入 providerOptions（互不干扰）', async () => {
    upstream.script([{ status: 200, body: okBody('ch1') }]);
    const chain = makeChain();
    await chain.run({
      modelId: 'cline-pass/x',
      body: bodyOf(),
      cfg: cfgOf(),
      meta: metaOf({ pipeline: 'direct' }),
      stream: false,
    });
    expect(upstream.requests[0]?.body['provider']).toEqual({ only: ['ch1'] });
    expect(upstream.requests[0]?.body['providerOptions']).toBeUndefined();
  });

  it('排序偏好透传给 planner 管道', async () => {
    upstream.script([{ status: 200, body: okBody('ch1') }]);
    const chain = makeChain();
    await chain.run({
      modelId: 'cline-pass/x',
      body: bodyOf(),
      cfg: cfgOf({ sort: 'cost' }),
      meta: metaOf(),
      stream: false,
    });
    expect(upstream.requests[0]?.body['providerOptions']).toEqual({ gateway: { only: ['ch1'], sort: 'cost' } });
  });
});

describe('buildCandidates 候选生成', () => {
  const noCooling: CoolingCheck = { isCooling: () => false };

  it('用户勾选顺序是首要依据', () => {
    const plan = buildCandidates({
      modelId: 'm',
      cfg: cfgOf({ upstreams: ['b', 'a'] }),
      meta: metaOf({ upstreams: ['a', 'b'] }),
      health: noCooling,
    });
    expect(plan.channels).toEqual(['b', 'a']);
  });

  it('排除的渠道不进候选', () => {
    const plan = buildCandidates({
      modelId: 'm',
      cfg: cfgOf({ upstreams: ['a', 'b'], exclude: ['b'] }),
      meta: metaOf(),
      health: noCooling,
    });
    expect(plan.channels).toEqual(['a']);
  });

  it('冷却中的渠道沉底（稳定排序，不打乱其余相对顺序）', () => {
    const health2 = new ChannelHealth();
    health2.markFailed('m', 'b', 60000);
    const plan = buildCandidates({
      modelId: 'm',
      cfg: cfgOf({ upstreams: ['a', 'b', 'c'] }),
      meta: metaOf(),
      health: health2,
    });
    expect(plan.channels).toEqual(['a', 'c', 'b']);
  });

  it('全部冷却时保持原顺序（不剔除）', () => {
    const health2 = new ChannelHealth();
    for (const c of ['a', 'b']) health2.markFailed('m', c, 60000);
    const plan = buildCandidates({
      modelId: 'm',
      cfg: cfgOf({ upstreams: ['a', 'b'] }),
      meta: metaOf(),
      health: health2,
    });
    expect(plan.channels).toEqual(['a', 'b']);
  });

  it('自动模式：channels 为空', () => {
    const plan = buildCandidates({ modelId: 'm', cfg: cfgOf({ upstreams: [] }), meta: metaOf(), health: noCooling });
    expect(plan.channels).toEqual([]);
  });

  it('degraded 标记：有排除项但本地无渠道清单', () => {
    const plan = buildCandidates({
      modelId: 'm',
      cfg: cfgOf({ exclude: ['x'] }),
      meta: metaOf({ upstreams: [] }),
      health: noCooling,
    });
    expect(plan.degraded).toBe(true);
    expect(plan.notes.join()).toContain('探测');
  });
});

describe('ChatChain 钉住结果审计（docs/pinning.md D3）', () => {
  it('strict + enforced + finalProvider 不符 → 该候选按失败处理，切下一个', async () => {
    gw().failover.retriesPerChannel = 0;
    pool = makePool();
    upstream.script([
      { status: 200, body: okBody('chX') }, // 网关不听话：目标 ch1，实际 chX
      { status: 200, body: okBody('ch2') },
    ]);
    const chain = makeChain();
    const ok = asSuccess(
      await chain.run({ modelId: 'cline-pass/x', body: bodyOf(), cfg: cfgOf(), meta: metaOf(), stream: false }),
    );
    expect(upstream.count).toBe(2);
    expect(ok.trace[0]?.note).toContain('钉住未生效');
    expect(ok.trace[0]?.note).toContain('chX');
    expect(ok.routing.finalProvider).toBe('ch2');
    expect(health.isCooling('cline-pass/x', 'ch1')).toBe(true);
  });

  it('全部候选都不听话 → 失败，错误信息说明钉住未生效', async () => {
    gw().failover.retriesPerChannel = 0;
    pool = makePool();
    upstream.script([
      { status: 200, body: okBody('chX') },
      { status: 200, body: okBody('chY') },
    ]);
    const chain = makeChain();
    const r = await chain.run({ modelId: 'cline-pass/x', body: bodyOf(), cfg: cfgOf(), meta: metaOf(), stream: false });
    expect(r.outcome).toBe('failure');
    if (r.outcome === 'failure') expect(r.message).toContain('钉住未生效');
  });

  it('pinState=ignored（网关丢弃参数）→ 不审计，照常成功', async () => {
    upstream.script([{ status: 200, body: okBody('chX') }]);
    const chain = makeChain();
    const r = await chain.run({
      modelId: 'cline-pass/x',
      body: bodyOf(),
      cfg: cfgOf(),
      meta: metaOf({ pinState: 'ignored' }),
      stream: false,
    });
    expect(r.outcome).toBe('success');
    expect(upstream.count).toBe(1);
  });

  it('pinState=unknown（未探测）→ 保守放行，不错杀', async () => {
    upstream.script([{ status: 200, body: okBody('chX') }]);
    const chain = makeChain();
    const r = await chain.run({
      modelId: 'cline-pass/x',
      body: bodyOf(),
      cfg: cfgOf(),
      meta: metaOf({ pinState: 'unknown' }),
      stream: false,
    });
    expect(r.outcome).toBe('success');
  });

  it('preferred 的最后一个候选放开回退 → 不审计', async () => {
    upstream.script([{ status: 200, body: okBody('chX') }]);
    const chain = makeChain();
    const r = await chain.run({
      modelId: 'cline-pass/x',
      body: bodyOf(),
      cfg: cfgOf({ pinMode: 'preferred', upstreams: ['ch1'] }),
      meta: metaOf(),
      stream: false,
    });
    expect(r.outcome).toBe('success');
  });

  it('响应无元数据（finalProvider 为空）→ 无法审计，放行', async () => {
    upstream.script([{ status: 200, body: { choices: [{ message: { content: 'OK' } }] } }]);
    const chain = makeChain();
    const r = await chain.run({ modelId: 'cline-pass/x', body: bodyOf(), cfg: cfgOf(), meta: metaOf(), stream: false });
    expect(r.outcome).toBe('success');
  });

  it('slug 等价（GMICloud vs gmicloud）不误判', async () => {
    upstream.script([{ status: 200, body: okBody('Gmi Cloud') }]);
    const chain = makeChain();
    const r = await chain.run({
      modelId: 'cline-pass/x',
      body: bodyOf(),
      cfg: cfgOf({ upstreams: ['gmicloud'] }),
      meta: metaOf({ upstreams: ['gmicloud'] }),
      stream: false,
    });
    expect(r.outcome).toBe('success');
  });
});

describe('ChatChain 非流式的超时与断连（回归：signal 未接线）', () => {
  it('客户端断开会中止在飞的非流式请求，不再让它后台跑完（旧缺陷）', async () => {
    const controller = new AbortController();
    upstream.script([{ status: 200, body: okBody('ch1'), delayMs: 5000 }]);
    const chain = makeChain();
    const started = Date.now();
    const pending = chain.run({
      modelId: 'cline-pass/x',
      body: bodyOf(),
      cfg: cfgOf({ upstreams: ['ch1'] }),
      meta: metaOf(),
      stream: false,
      clientSignal: controller.signal,
    });
    await new Promise((r) => setTimeout(r, 100));
    controller.abort();
    expect((await pending).outcome).toBe('cancelled');
    // 若 signal 没接到 fetch 上，这里要等满 5s 才返回
    expect(Date.now() - started).toBeLessThan(2000);
    expect(upstream.count).toBe(1);
  });

  it('非流式单次尝试超时生效（不再退化为 fetchJSON 内部默认 60s）', async () => {
    gw().failover.attemptTimeoutMs = 300;
    gw().failover.retriesPerChannel = 0; // 超时后的重试会吃掉假上游的默认成功响应，干扰断言
    pool = makePool();
    upstream.script([{ status: 200, body: okBody('ch1'), delayMs: 5000 }]);
    const chain = makeChain();
    const started = Date.now();
    const r = asFailure(
      await chain.run({
        modelId: 'cline-pass/x',
        body: bodyOf(),
        cfg: cfgOf({ upstreams: ['ch1'] }),
        meta: metaOf(),
        stream: false,
      }),
    );
    expect(Date.now() - started).toBeLessThan(2000);
    expect(r.message).toMatch(/timeout/i);
    expect(r.trace[0]?.status).toBe(502);
  });
});

describe('非流式请求内部走流式（docs/timeouts.md）', () => {
  const sseLine = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`;

  it('上游拿到的确实是流式请求，客户端拿到的仍是非流式 JSON', async () => {
    upstream.script([
      {
        sse: [
          sseLine({
            id: 'g1',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'x/y',
            choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' } }],
          }),
          sseLine({
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            provider_metadata: { gateway: { routing: { finalProvider: 'ch1' } } },
            usage: { completion_tokens: 1 },
          }),
          'data: [DONE]\n\n',
        ],
      },
    ]);
    const chain = makeChain();
    const r = asSuccess(
      await chain.run({ modelId: 'cline-pass/x', body: bodyOf(), cfg: cfgOf(), meta: metaOf(), stream: false }),
    );

    const sent = upstream.requests[0]?.body as Record<string, unknown>;
    expect(sent['stream']).toBe(true);
    expect((sent['stream_options'] as Record<string, unknown>)['include_usage']).toBe(true);

    const choice = (r.body['choices'] as Record<string, unknown>[])[0];
    expect(choice?.['message']).toEqual({ role: 'assistant', content: 'ok' });
    expect(r.routing.finalProvider).toBe('ch1');
    expect(upstream.count).toBe(1);
  });

  it('上游无视 stream、直接回完整 JSON：等价于非流式成功', async () => {
    upstream.script([{ status: 200, body: okBody('ch1') }]);
    const chain = makeChain();
    const r = asSuccess(
      await chain.run({
        modelId: 'cline-pass/x',
        body: bodyOf(),
        cfg: cfgOf({ upstreams: ['ch1'] }),
        meta: metaOf(),
        stream: false,
      }),
    );
    expect((r.body['choices'] as Record<string, unknown>[])[0]?.['message']).toEqual({ content: 'ok' });
    expect(upstream.count).toBe(1);
  });

  it('上游不认 stream（4xx）→ 回落真正的非流式请求', async () => {
    upstream.script([
      { status: 400, body: err('stream is not supported') },
      { status: 200, body: okBody('ch1') },
    ]);
    const chain = makeChain();
    const r = asSuccess(
      await chain.run({
        modelId: 'cline-pass/x',
        body: bodyOf(),
        cfg: cfgOf({ upstreams: ['ch1'] }),
        meta: metaOf(),
        stream: false,
      }),
    );
    expect(upstream.count).toBe(2);
    // 第二次请求没有 stream:true —— 回落到真正的非流式
    const second = upstream.requests[1]?.body as Record<string, unknown>;
    expect(second['stream']).not.toBe(true);
    expect((r.body['choices'] as Record<string, unknown>[])[0]?.['message']).toEqual({ content: 'ok' });
  });

  it('429 不触发回落（与是否流式无关，回落只是白打一发）', async () => {
    gw().failover.retriesPerChannel = 0;
    pool = makePool();
    upstream.script([
      { status: 429, body: err('rate limited') },
      { status: 200, body: okBody('ch1') },
    ]);
    const chain = makeChain();
    const r = asFailure(
      await chain.run({
        modelId: 'cline-pass/x',
        body: bodyOf(),
        cfg: cfgOf({ upstreams: ['ch1'] }),
        meta: metaOf(),
        stream: false,
      }),
    );
    expect(upstream.count).toBe(1);
    const sent = upstream.requests[0]?.body as Record<string, unknown>;
    expect(sent['stream']).toBe(true);
    expect(r.message).toMatch(/rate limited/i);
  });

  it('客户端提前断开 → cancelled（不是上游失败）', async () => {
    upstream.script([{ delayMs: 5000, body: okBody('ch1') }]);
    const chain = makeChain();
    const abort = new AbortController();
    const pending = chain.run({
      modelId: 'cline-pass/x',
      body: bodyOf(),
      cfg: cfgOf({ upstreams: ['ch1'] }),
      meta: metaOf(),
      stream: false,
      clientSignal: abort.signal,
    });
    setTimeout(() => abort.abort(), 50);
    const r = await pending;
    expect(r.outcome).toBe('cancelled');
  });
});

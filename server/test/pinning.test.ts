import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AccountPool } from '../src/accounts/pool.ts';
import { defaultConfig } from '../src/config/schema.ts';
import { ProbeService } from '../src/upstream/probe.ts';
import { blankModelMeta, type ModelMeta } from '../src/upstream/types.ts';
import { FakeUpstream } from './helpers/upstream.ts';

/** planningReasoning 形状（dsh 文档 2026-09-30 实测）。 */
const PLAN_TEXT =
  'System credentials planned for: deepseek, alibaba, baseten, fireworks. Total execution order: deepseek(system) → alibaba(system) → baseten(system) → fireworks(system)';

const routedBody = (provider: string, plan = PLAN_TEXT) => ({
  data: {
    choices: [{ message: { content: 'OK' } }],
    provider_metadata: { gateway: { routing: { finalProvider: provider, planningReasoning: plan } } },
  },
});

let upstream: FakeUpstream;
let base: string;

beforeEach(async () => {
  upstream = new FakeUpstream();
  base = await upstream.listen();
});

afterEach(async () => {
  await upstream.close();
});

function makeService() {
  const store = new Map<string, ModelMeta>();
  const config = defaultConfig();
  config.accounts = [{ name: 'A', key: 'sk_a', enabled: true }];
  const probe = new ProbeService({
    upstreamBase: base,
    pool: new AccountPool(() => ({ accounts: config.accounts, accountMode: 'sticky', activeAccount: '' })),
    getMeta: (id) => store.get(id),
    setMeta: (id, m) => void store.set(id, m),
  });
  return { probe, store };
}

describe('probeModel 钉住探针（docs/pinning.md D1）', () => {
  it('探针报路由层拒绝（带清单）→ enforced，清单并入渠道列表', async () => {
    upstream.script([
      { status: 200, body: routedBody('deepseek') },
      // 探针：合法形状的不存在 slug → 路由层拒绝并附清单
      { status: 400, body: { error: 'invalid_request_error: Available providers are: deepseek, alibaba, baseten. ' } },
    ]);
    const { probe, store } = makeService();
    const r = await probe.probeModel('cline-pass/x');
    expect(r.ok).toBe(true);
    expect(r.pinState).toBe('enforced');
    expect(r.availableProviders).toEqual(['deepseek', 'alibaba', 'baseten']);
    // D2：执行链（含链首 deepseek）全部进清单
    expect(r.upstreams).toEqual(expect.arrayContaining(['deepseek', 'alibaba', 'baseten', 'fireworks']));
    expect(r.pinDisabledReason).toBeNull();
    expect(store.get('cline-pass/x')?.pinProbeAt).not.toBeNull();
  });

  it('探针返回 200 → ignored（参数被丢弃），原因说明带实测路由', async () => {
    upstream.script([
      { status: 200, body: routedBody('deepseek') },
      // 探针本应被拒绝，却正常完成 → 参数被忽略
      { status: 200, body: routedBody('openai-compatible-private') },
    ]);
    const { probe } = makeService();
    const r = await probe.probeModel('cline-pass/x');
    expect(r.pinState).toBe('ignored');
    expect(r.pinDisabledReason).toContain('网关忽略钉住参数');
    expect(r.pinDisabledReason).toContain('openai-compatible-private');
  });

  it('探针报 empty response content → ignored（请求穿过路由层执行到了模型）', async () => {
    upstream.script([
      { status: 200, body: routedBody('deepseek') },
      // max_tokens 太小时推理模型会回这个错——不是路由拒绝
      { status: 500, body: { error: 'empty response content' } },
    ]);
    const { probe } = makeService();
    const r = await probe.probeModel('cline-pass/x');
    expect(r.pinState).toBe('ignored');
  });

  it('探针遇瞬时限流 → unknown，沿用既有状态', async () => {
    upstream.script([
      { status: 200, body: routedBody('deepseek') },
      { status: 429, body: { error: 'rate limited' } },
    ]);
    const { probe, store } = makeService();
    store.set('cline-pass/x', { ...blankModelMeta(), pinState: 'enforced', pinProbeAt: 111 });
    const r = await probe.probeModel('cline-pass/x');
    expect(r.pinState).toBe('enforced');
    expect(r.pinProbeAt).toBe(111); // 未确认就不刷新探测时间
  });

  it('管道未知（无元数据）→ 不发探针，pinState 保持 unknown', async () => {
    upstream.script([{ status: 200, body: { choices: [{ message: { content: 'OK' } }] } }]);
    const { probe } = makeService();
    const r = await probe.probeModel('cline-pass/x');
    expect(r.pipeline).toBeNull();
    expect(r.pinState).toBe('unknown');
    expect(upstream.count).toBe(1);
  });
});

describe('validateUpstreams 防假绿闸（D5）', () => {
  it('pinState=ignored 时拒绝执行，不发任何请求', async () => {
    const { probe, store } = makeService();
    store.set('cline-pass/x', {
      ...blankModelMeta(),
      pipeline: 'planner',
      pinState: 'ignored',
      pinDisabledReason: '网关忽略钉住参数',
      upstreams: ['deepseek', 'alibaba'],
    });
    const r = await probe.validateUpstreams('cline-pass/x');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain('网关忽略钉住参数');
      expect(r.pinState).toBe('ignored');
    }
    expect(upstream.count).toBe(0);
  });

  it('pinState=enforced 时正常校验', async () => {
    upstream.script([{ status: 200, body: routedBody('deepseek') }]);
    const { probe, store } = makeService();
    store.set('cline-pass/x', {
      ...blankModelMeta(),
      pipeline: 'planner',
      pinState: 'enforced',
      upstreams: ['deepseek'],
    });
    const r = await probe.validateUpstreams('cline-pass/x');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.results['deepseek']?.status).toBe('ok');
  });
});

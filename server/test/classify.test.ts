import { afterEach, describe, expect, it } from 'vitest';

import { ClassifyService, classifyFromProvider } from '../src/accounts/classify.ts';
import { ensureUniqueAccountNames } from '../src/accounts/naming.ts';
import type { AccountClassRecord } from '../src/accounts/types.ts';
import type { Account } from '../src/config/schema.ts';
import { FakeUpstream, type ScriptedResponse } from './helpers/upstream.ts';

const account = (name: string, key = `sk_${name}`): Account => ({ name, key, enabled: true });

/** planner 管线的成功响应：路由信息在 message.provider_metadata.gateway.routing。 */
const plannerBody = (finalProvider: string) => ({
  choices: [
    {
      message: {
        content: 'pong',
        provider_metadata: { gateway: { routing: { finalProvider } } },
      },
    },
  ],
});

async function setup(script: ScriptedResponse[] = []) {
  const upstream = new FakeUpstream();
  const base = await upstream.listen();
  upstream.script(script);
  const store = new Map<string, AccountClassRecord>();
  const service = new ClassifyService(() => ({
    upstreamBase: base,
    classifyModel: 'cline-pass/deepseek-v4.1-flash',
    get: (n) => store.get(n),
    set: (n, r) => void store.set(n, r),
  }));
  return { upstream, service, store };
}

let open: FakeUpstream | null = null;
afterEach(async () => {
  await open?.close();
  open = null;
});

describe('classifyFromProvider（纯函数）', () => {
  it('openai-compatible-private → 风控；其它非空 → 正常', () => {
    expect(classifyFromProvider('openai-compatible-private')).toBe('private');
    expect(classifyFromProvider('deepseek')).toBe('normal');
    expect(classifyFromProvider('OpenAI-Compatible-Private')).toBe('private');
  });

  it('空值等于没有事实 → unknown（不用二分法把失败当正常）', () => {
    expect(classifyFromProvider(null)).toBe('unknown');
    expect(classifyFromProvider(undefined)).toBe('unknown');
    expect(classifyFromProvider('')).toBe('unknown');
    expect(classifyFromProvider('   ')).toBe('unknown');
  });
});

describe('ClassifyService.classify', () => {
  it('请求体不带任何钉住字段（判定的是网关默认路由）', async () => {
    const { upstream, service } = await setup([{ body: plannerBody('deepseek') }]);
    open = upstream;
    await service.classify(account('a'));

    const req = upstream.requests[0];
    expect(req?.path).toBe('/chat/completions');
    expect(req?.auth).toBe('Bearer sk_a');
    expect(req?.body['model']).toBe('cline-pass/deepseek-v4.1-flash');
    expect(req?.body['stream']).toBe(false);
    expect(req?.body['providerOptions']).toBeUndefined();
    expect(req?.body['provider']).toBeUndefined();
  });

  it('planner 默认路由是真实渠道 → normal，记录 checkedAt', async () => {
    const { upstream, service, store } = await setup([{ body: plannerBody('deepseek') }]);
    open = upstream;
    const r = await service.classify(account('a'));
    expect(r.class).toBe('normal');
    expect(r.fresh).toBe(true);
    expect(r.checkedAt).toBeGreaterThan(0);
    expect(store.get('a')?.class).toBe('normal');
  });

  it('恒为 openai-compatible-private → private', async () => {
    const { upstream, service } = await setup([{ body: plannerBody('openai-compatible-private') }]);
    open = upstream;
    const r = await service.classify(account('a'));
    expect(r.class).toBe('private');
  });

  it('direct 管线的 provider 显示名 → normal', async () => {
    const { upstream, service } = await setup([
      { body: { choices: [{ message: { content: 'pong' } }], provider: 'DeepSeek' } },
    ]);
    open = upstream;
    expect((await service.classify(account('a'))).class).toBe('normal');
  });

  it('429 → unknown，且保留上一次的结论与时间', async () => {
    const { upstream, service, store } = await setup([{ status: 429, body: { error: { message: 'rate limited' } } }]);
    open = upstream;
    store.set('a', { class: 'normal', checkedAt: 12345 });
    const r = await service.classify(account('a'));
    expect(r.class).toBe('normal');
    expect(r.checkedAt).toBe(12345);
    expect(r.fresh).toBe(false);
    expect(r.note).toContain('429');
  });

  it('此前没有结论时失败 → unknown + 失败原因，checkedAt 保持 null', async () => {
    const { upstream, service } = await setup([{ status: 500, body: { error: { message: 'boom' } } }]);
    open = upstream;
    const r = await service.classify(account('a'));
    expect(r.class).toBe('unknown');
    expect(r.checkedAt).toBeNull();
    expect(r.note).toContain('500');
  });

  it('响应里没有路由信息 → unknown（不猜）', async () => {
    const { upstream, service } = await setup([{ body: { choices: [{ message: { content: 'ok' } }] } }]);
    open = upstream;
    const r = await service.classify(account('a'));
    expect(r.class).toBe('unknown');
    expect(r.note).toContain('finalProvider');
  });

  it('上游返回非 JSON → unknown', async () => {
    const { upstream, service } = await setup([{ raw: '<html>bad gateway</html>', contentType: 'text/html' }]);
    open = upstream;
    expect((await service.classify(account('a'))).class).toBe('unknown');
  });
});

describe('ClassifyService.classifyMany', () => {
  it('逐个串行，汇总各分类数量', async () => {
    const { upstream, service } = await setup([
      { body: plannerBody('deepseek') },
      { body: plannerBody('openai-compatible-private') },
      { status: 429, body: { error: { message: 'limited' } } },
    ]);
    open = upstream;
    const batch = await service.classifyMany([account('a'), account('b'), account('c')]);
    expect(batch.cancelled).toBe(false);
    expect(batch.results.map((r) => r.name)).toEqual(['a', 'b', 'c']);
    expect(batch.summary).toEqual({ normal: 1, private: 1, unknown: 1, failed: 1 });
    expect(upstream.requests.map((r) => r.auth)).toEqual(['Bearer sk_a', 'Bearer sk_b', 'Bearer sk_c']);
  });

  it('客户端已离开：一个请求都不发', async () => {
    const { upstream, service } = await setup();
    open = upstream;
    const ctrl = new AbortController();
    ctrl.abort();
    const batch = await service.classifyMany([account('a'), account('b')], ctrl.signal);
    expect(batch.cancelled).toBe(true);
    expect(batch.results).toEqual([]);
    expect(upstream.count).toBe(0);
  });

  it('体检进行中时 isRunning 为真，结束后复位', async () => {
    const { upstream, service } = await setup([{ body: plannerBody('deepseek'), delayMs: 30 }]);
    open = upstream;
    expect(service.isRunning()).toBe(false);
    const pending = service.classifyMany([account('a')]);
    expect(service.isRunning()).toBe(true);
    await pending;
    expect(service.isRunning()).toBe(false);
  });
});

describe('ensureUniqueAccountNames', () => {
  it('重名按出现顺序改名，密钥与其它字段不丢', () => {
    const input: Account[] = [
      { name: '主力', key: 'k1', enabled: true, expiresAt: '2026-12-01' },
      { name: '主力', key: 'k2', enabled: false },
      { name: '主力', key: 'k3', enabled: true },
    ];
    const { accounts, renamed } = ensureUniqueAccountNames(input);
    expect(accounts.map((a) => a.name)).toEqual(['主力', '主力-2', '主力-3']);
    expect(accounts[0]?.expiresAt).toBe('2026-12-01');
    expect(accounts[1]?.key).toBe('k2');
    expect(renamed).toEqual([
      { from: '主力', to: '主力-2' },
      { from: '主力', to: '主力-3' },
    ]);
  });

  it('长名字加后缀不会超出 50 字符上限，也不会陷入死循环', () => {
    const long = 'x'.repeat(50);
    const { accounts } = ensureUniqueAccountNames([
      { name: long, key: 'k1', enabled: true },
      { name: long, key: 'k2', enabled: true },
      { name: long, key: 'k3', enabled: true },
    ]);
    expect(new Set(accounts.map((a) => a.name)).size).toBe(3);
    for (const a of accounts) expect(a.name.length).toBeLessThanOrEqual(50);
  });

  it('无重名时原样返回（同一批对象引用）', () => {
    const input: Account[] = [
      { name: 'a', key: 'k1', enabled: true },
      { name: 'b', key: 'k2', enabled: true },
    ];
    const { accounts, renamed } = ensureUniqueAccountNames(input);
    expect(renamed).toEqual([]);
    expect(accounts[0]).toBe(input[0]);
  });
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ClassifyService } from '../src/accounts/classify.ts';
import { AccountPool } from '../src/accounts/pool.ts';
import type { AppContext } from '../src/appContext.ts';
import { type Account, defaultConfig } from '../src/config/schema.ts';
import { sendError } from '../src/http/respond.ts';
import { type Ctx, Router } from '../src/http/router.ts';
import { registerApiRoutes } from '../src/http/routes/api.ts';
import { createHttpServer } from '../src/http/server.ts';
import { ChannelHealth } from '../src/proxy/health.ts';
import { JsonStore } from '../src/store/jsonStore.ts';
import { defaultMeta, type MetaFile } from '../src/upstream/types.ts';
import { listen, request } from './helpers/http.ts';
import { FakeUpstream, type ScriptedResponse } from './helpers/upstream.ts';

let dir: string;
const closers: Array<() => Promise<void>> = [];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cps-accounts-api-'));
});

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  await fs.promises.rm(dir, { recursive: true, force: true });
});

interface Harness {
  port: number;
  configStore: JsonStore<ReturnType<typeof defaultConfig>>;
  metaStore: JsonStore<MetaFile>;
  upstream: FakeUpstream;
}

/**
 * 起一个只挂 `/api` 路由的真实 HTTP 服务（含真实的 config/meta store），
 * 上游是本地假网关——不触网、不扣额度。
 */
async function harness(
  accounts: Account[],
  options: { meta?: (m: MetaFile) => void; script?: ScriptedResponse[] } = {},
): Promise<Harness> {
  const upstream = new FakeUpstream();
  const upstreamBase = await upstream.listen();
  upstream.script(options.script ?? []);
  closers.push(() => upstream.close());

  const config = defaultConfig();
  config.accounts = accounts;
  const configStore = new JsonStore(path.join(dir, 'config.json'), config, { debounceMs: 1 });
  const meta = defaultMeta();
  options.meta?.(meta);
  const metaStore = new JsonStore<MetaFile>(path.join(dir, 'metadata.json'), meta, { debounceMs: 1 });
  closers.push(async () => {
    configStore.close();
    metaStore.close();
    await Promise.all([configStore.flush(), metaStore.flush()]);
  });

  const classify = new ClassifyService(() => ({
    upstreamBase,
    classifyModel: configStore.value.classifyModel,
    get: (name) => metaStore.value.accountClass[name],
    set: (name, record) =>
      metaStore.update((m) => {
        m.accountClass[name] = record;
      }),
  }));

  const ctx: AppContext = {
    version: 'test',
    startedAt: Date.now(),
    configStore,
    metaStore,
    pool: new AccountPool(configStore.value),
    health: new ChannelHealth(),
    chain: {} as AppContext['chain'],
    probe: {} as AppContext['probe'],
    classify,
    catalog: {} as AppContext['catalog'],
  };

  const router = new Router();
  registerApiRoutes(ctx, router);
  const server = createHttpServer({
    handler: (c: Ctx) => {
      const route = router.resolve(c.method, c.path);
      if (!route) {
        sendError(c.res, 404, 'no route', 'not_found');
        return;
      }
      return route(c);
    },
  });
  const { port, close } = await listen(server);
  closers.push(close);
  return { port, configStore, metaStore, upstream };
}

const acc = (name: string, extra: Partial<Account> = {}): Account => ({
  name,
  key: `sk_${name}`,
  enabled: true,
  ...extra,
});

const planner = (finalProvider: string) => ({
  choices: [{ message: { content: 'pong', provider_metadata: { gateway: { routing: { finalProvider } } } } }],
});

describe('GET /api/accounts', () => {
  it('返回到期状态、体检结论与判定模型（到期状态由服务端计算）', async () => {
    const today = new Date();
    const iso = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const soon = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 3);
    const { port } = await harness([acc('a', { expiresAt: iso(soon) }), acc('b')], {
      meta: (m) => {
        m.accountClass['a'] = { class: 'private', checkedAt: 123 };
      },
    });

    const res = await request(port, '/api/accounts');
    const body = res.json<{
      accounts: Array<{
        name: string;
        expiresAt: string | null;
        expiry: { kind: string; days: number | null };
        classify: { class: string; checkedAt: number | null } | null;
      }>;
      classifyModel: string;
    }>();
    expect(body.accounts[0]?.expiresAt).toBe(iso(soon));
    expect(body.accounts[0]?.expiry).toEqual({ kind: 'soon', days: 3 });
    expect(body.accounts[0]?.classify).toEqual({ class: 'private', checkedAt: 123 });
    expect(body.accounts[1]?.expiresAt).toBeNull();
    expect(body.accounts[1]?.expiry).toEqual({ kind: 'none', days: null });
    expect(body.accounts[1]?.classify).toBeNull();
    expect(body.classifyModel).toBe('cline-pass/deepseek-v4.1-flash');
  });
});

describe('POST /api/accounts', () => {
  it('expiresAt 三态：缺省保持、null 清空、合法日期设置', async () => {
    const { port, configStore } = await harness([acc('a', { expiresAt: '2026-12-01' })]);

    // 缺省 → 保持
    await request(port, '/api/accounts', {
      method: 'POST',
      body: { accounts: [{ name: 'a', enabled: true, existingIndex: 0 }], mode: 'sticky', active: 0 },
    });
    expect(configStore.value.accounts[0]?.expiresAt).toBe('2026-12-01');

    // null → 清空
    await request(port, '/api/accounts', {
      method: 'POST',
      body: { accounts: [{ name: 'a', enabled: true, existingIndex: 0, expiresAt: null }] },
    });
    expect(configStore.value.accounts[0]?.expiresAt).toBeUndefined();

    // 合法日期 → 设置
    await request(port, '/api/accounts', {
      method: 'POST',
      body: { accounts: [{ name: 'a', enabled: true, existingIndex: 0, expiresAt: '2027-01-31' }] },
    });
    expect(configStore.value.accounts[0]?.expiresAt).toBe('2027-01-31');
  });

  it('改名把用量统计与体检结论迁到新名字（不静默丢观测数据）', async () => {
    const { port, metaStore } = await harness([acc('旧名'), acc('另一个')], {
      meta: (m) => {
        m.stats['旧名'] = { requests: 7, lastUsed: 1000, lastError: null };
        m.accountClass['旧名'] = { class: 'normal', checkedAt: 2000 };
      },
    });

    const res = await request(port, '/api/accounts', {
      method: 'POST',
      body: {
        accounts: [
          { name: '新名', enabled: true, existingIndex: 0 },
          { name: '另一个', enabled: true, existingIndex: 1 },
        ],
        mode: 'sticky',
        active: 0,
      },
    });
    expect(res.status).toBe(200);
    expect(metaStore.value.stats['新名']?.requests).toBe(7);
    expect(metaStore.value.accountClass['新名']?.class).toBe('normal');
    expect(metaStore.value.stats['旧名']).toBeUndefined();
    expect(metaStore.value.accountClass['旧名']).toBeUndefined();
  });

  it('改名成环（B→A 且 A→A-2）时观测数据不互相覆盖', async () => {
    const { port, metaStore } = await harness([acc('A'), acc('B')], {
      meta: (m) => {
        m.stats['A'] = { requests: 1, lastUsed: 1, lastError: null };
        m.stats['B'] = { requests: 2, lastUsed: 2, lastError: null };
      },
    });
    // 两行同名：第一行（原 B）占住 A，第二行（原 A）被迫改成 A-2
    const res = await request(port, '/api/accounts', {
      method: 'POST',
      body: {
        accounts: [
          { name: 'A', enabled: true, existingIndex: 1 },
          { name: 'A', enabled: true, existingIndex: 0 },
        ],
      },
    });
    const renamed = res.json<{ renamed: Array<{ from: string; to: string }> }>().renamed;
    expect(renamed).toEqual([
      { from: 'B', to: 'A' },
      { from: 'A', to: 'A-2' },
    ]);
    // 逐条搬会先被 B→A 覆盖、再把 B 的数据搬去 A-2；两段式才对
    expect(metaStore.value.stats['A']?.requests).toBe(2);
    expect(metaStore.value.stats['A-2']?.requests).toBe(1);
    expect(metaStore.value.stats['B']).toBeUndefined();
  });

  it('删除账号时清掉其观测数据（历史记录保留）', async () => {
    const { port, metaStore } = await harness([acc('a'), acc('b')], {
      meta: (m) => {
        m.stats['a'] = { requests: 3, lastUsed: 1, lastError: null };
        m.stats['b'] = { requests: 4, lastUsed: 1, lastError: null };
        m.history.push({
          ts: 1,
          model: 'cline-pass/x',
          provider: null,
          canonical: null,
          ms: null,
          stream: false,
          error: null,
          account: 'a',
          attempts: [],
          trace: [],
          pinMismatch: false,
        });
      },
    });
    await request(port, '/api/accounts', {
      method: 'POST',
      body: { accounts: [{ name: 'b', enabled: true, existingIndex: 1 }] },
    });
    expect(metaStore.value.stats['a']).toBeUndefined();
    expect(metaStore.value.stats['b']?.requests).toBe(4);
    expect(metaStore.value.history[0]?.account).toBe('a');
  });

  it('可以保存判定模型', async () => {
    const { port, configStore } = await harness([acc('a')]);
    await request(port, '/api/accounts', {
      method: 'POST',
      body: {
        accounts: [{ name: 'a', enabled: true, existingIndex: 0 }],
        classifyModel: 'cline-pass/glm-5.3-flash',
      },
    });
    expect(configStore.value.classifyModel).toBe('cline-pass/glm-5.3-flash');
  });
});

describe('POST /api/accounts/classify', () => {
  it('默认体检全部启用账号，结论写入 metadata', async () => {
    const { port, metaStore } = await harness([acc('a'), acc('off', { enabled: false })], {
      script: [{ body: planner('deepseek') }],
    });
    const res = await request(port, '/api/accounts/classify', { method: 'POST', body: {} });
    expect(res.status).toBe(200);
    const body = res.json<{ results: Array<{ name: string; class: string }>; summary: Record<string, number> }>();
    expect(body.results.map((r) => r.name)).toEqual(['a']);
    expect(body.summary['normal']).toBe(1);
    expect(metaStore.value.accountClass['a']?.class).toBe('normal');
  });

  it('显式点名时允许体检停用账号', async () => {
    const { port } = await harness([acc('a'), acc('off', { enabled: false })], {
      script: [{ body: planner('openai-compatible-private') }],
    });
    const res = await request(port, '/api/accounts/classify', {
      method: 'POST',
      body: { names: ['off'] },
    });
    const body = res.json<{ results: Array<{ name: string; class: string }> }>();
    expect(body.results).toEqual([expect.objectContaining({ name: 'off', class: 'private' })]);
  });

  it('没有可体检的账号 → 400', async () => {
    const { port } = await harness([acc('off', { enabled: false })]);
    const res = await request(port, '/api/accounts/classify', { method: 'POST', body: {} });
    expect(res.status).toBe(400);
  });
});

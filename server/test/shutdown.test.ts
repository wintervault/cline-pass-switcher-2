import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppContext } from '../src/appContext.ts';
import { defaultConfig } from '../src/config/schema.ts';
import { sendError, sendJSON } from '../src/http/respond.ts';
import { type Ctx, Router } from '../src/http/router.ts';
import { registerApiRoutes } from '../src/http/routes/api.ts';
import { createHttpServer } from '../src/http/server.ts';
import { JsonStore } from '../src/store/jsonStore.ts';
import { defaultMeta, type MetaFile } from '../src/upstream/types.ts';
import { listen, request } from './helpers/http.ts';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cps-shutdown-'));
});

afterEach(async () => {
  await fs.promises.rm(dir, { recursive: true, force: true });
});

function makeCtx(onShutdown?: (reason: string) => void): AppContext {
  const config = defaultConfig();
  const meta = defaultMeta();
  return {
    version: 'test',
    startedAt: Date.now(),
    configStore: new JsonStore(path.join(dir, 'config.json'), config, { debounceMs: 1 }),
    metaStore: new JsonStore<MetaFile>(path.join(dir, 'metadata.json'), meta, { debounceMs: 1 }),
    // 关停测试只关心 /api/shutdown：网关运行时用最小桩（它不参与该路径）
    gateways: {
      get: () => null,
      list: () => [],
      statuses: () => [],
      reconcile: async () => {},
      closeAll: async () => {},
    } as unknown as AppContext['gateways'],
    classify: {} as AppContext['classify'],
    catalog: {} as AppContext['catalog'],
    onShutdown,
  };
}

function makeServer(ctx: AppContext) {
  const router = new Router();
  router.get('/healthz', (c: Ctx) => sendJSON(c.res, 200, { ok: true }));
  registerApiRoutes(ctx, router);
  return createHttpServer({
    gatewayId: 'main',
    handler: (c: Ctx) => {
      const route = router.resolve(c.method, c.path);
      if (!route) {
        sendError(c.res, 404, 'no route', 'not_found');
        return;
      }
      return route(c);
    },
  });
}

describe('POST /api/shutdown（桌面壳启停通道）', () => {
  it('回环 + 无 Origin → 200 并触发优雅关停回调', async () => {
    const onShutdown = vi.fn();
    const server = makeServer(makeCtx(onShutdown));
    const { port, close } = await listen(server);
    const res = await request(port, '/api/shutdown', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(res.json<{ ok: boolean }>().ok).toBe(true);
    // 响应先回，关停 50ms 后触发
    await new Promise((r) => setTimeout(r, 200));
    expect(onShutdown).toHaveBeenCalledTimes(1);
    await close();
  });

  it('带 Origin（浏览器跨源）→ 404，不触发关停', async () => {
    const onShutdown = vi.fn();
    const server = makeServer(makeCtx(onShutdown));
    const { port, close } = await listen(server);
    const res = await request(port, '/api/shutdown', { method: 'POST', headers: { origin: 'http://evil.example' } });
    expect(res.status).toBe(404);
    await new Promise((r) => setTimeout(r, 120));
    expect(onShutdown).not.toHaveBeenCalled();
    await close();
  });

  it('带 Referer（浏览器同源表单）→ 404，不触发关停', async () => {
    const onShutdown = vi.fn();
    const server = makeServer(makeCtx(onShutdown));
    const { port, close } = await listen(server);
    const res = await request(port, '/api/shutdown', { method: 'POST', headers: { referer: 'http://127.0.0.1/x' } });
    expect(res.status).toBe(404);
    await new Promise((r) => setTimeout(r, 120));
    expect(onShutdown).not.toHaveBeenCalled();
    await close();
  });

  it('未装配 onShutdown（如测试环境）→ 404', async () => {
    const server = makeServer(makeCtx(undefined));
    const { port, close } = await listen(server);
    const res = await request(port, '/api/shutdown', { method: 'POST' });
    expect(res.status).toBe(404);
    await close();
  });

  it('无需 proxyKey 鉴权（壳不依赖下游密钥配置）', async () => {
    const ctx = makeCtx(vi.fn());
    ctx.configStore.update((c) => {
      const gateway = c.gateways[0];
      if (gateway) gateway.proxyKey = 'sk_downstream';
    });
    const server = makeServer(ctx);
    const { port, close } = await listen(server);
    const res = await request(port, '/api/shutdown', { method: 'POST' });
    expect(res.status).toBe(200);
    await close();
  });
});

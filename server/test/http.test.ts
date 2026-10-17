import { describe, expect, it } from 'vitest';
import { sendError, sendJSON, sendText } from '../src/http/respond.ts';
import { type Ctx, compose, type Middleware, Router } from '../src/http/router.ts';
import { createHttpServer, shutdownServer } from '../src/http/server.ts';
import { deferred, delay, listen, request } from './helpers/http.ts';

/** 按生产环境的方式装配一个服务：路由表 + 404 兜底。 */
function makeServer(routes: (router: Router) => void) {
  const router = new Router();
  routes(router);
  return createHttpServer({
    gatewayId: 'main',
    handler: handlerFor(router),
  });
}

function handlerFor(router: Router) {
  return (ctx: Ctx) => {
    const route = router.resolve(ctx.method, ctx.path);
    if (!route) {
      sendError(ctx.res, 404, `no route: ${ctx.method} ${ctx.path}`, 'not_found');
      return;
    }
    return route(ctx);
  };
}

describe('Router', () => {
  it('按方法与路径精确匹配', () => {
    const router = new Router();
    const handler = (): void => {};
    router.get('/a', handler);
    router.post('/a', handler);
    expect(router.resolve('GET', '/a')).toBe(handler);
    expect(router.resolve('get', '/a')).toBe(handler); // 方法大小写不敏感
    expect(router.resolve('POST', '/a')).toBe(handler);
    expect(router.resolve('GET', '/b')).toBeNull();
    expect(router.resolve('DELETE', '/a')).toBeNull();
  });

  it('未匹配时回落到 fallback', () => {
    const router = new Router();
    const fallback = (): void => {};
    router.setFallback(fallback);
    expect(router.resolve('GET', '/anything')).toBe(fallback);
  });
});

describe('compose 中间件链', () => {
  const makeCtx = (): Ctx =>
    ({ req: {}, res: {}, url: new URL('http://x/'), method: 'GET', path: '/' }) as unknown as Ctx;

  it('按注册顺序进入、逆序退出', async () => {
    const order: string[] = [];
    const mw =
      (name: string): Middleware =>
      async (_ctx, next) => {
        order.push(`${name}:in`);
        await next();
        order.push(`${name}:out`);
      };
    const handler = compose([mw('a'), mw('b')], () => {
      order.push('handler');
    });
    await handler(makeCtx());
    expect(order).toEqual(['a:in', 'b:in', 'handler', 'b:out', 'a:out']);
  });

  it('中间件不调用 next() 即拦截后续', async () => {
    const order: string[] = [];
    const blocker: Middleware = async () => {
      order.push('blocked');
    };
    const handler = compose([blocker], () => {
      order.push('handler');
    });
    await handler(makeCtx());
    expect(order).toEqual(['blocked']);
  });

  it('重复调用 next() 会抛错（防止中间件写出两次响应）', async () => {
    const bad: Middleware = async (_ctx, next) => {
      await next();
      await next();
    };
    const handler = compose([bad], () => {});
    await expect(handler(makeCtx())).rejects.toThrow('next() 被重复调用');
  });
});

describe('HTTP 服务', () => {
  it('JSON 响应带安全头与正确的 Content-Type', async () => {
    const server = makeServer((r) => {
      r.get('/x', (ctx) => sendJSON(ctx.res, 200, { ok: true }));
    });
    const { port, close } = await listen(server);
    const res = await request(port, '/x');
    expect(res.status).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['content-type']).toContain('application/json');
    await close();
  });

  it('未匹配路由返回 404 与 OpenAI 风格的错误体', async () => {
    const server = makeServer(() => {});
    const { port, close } = await listen(server);
    const res = await request(port, '/nope');
    expect(res.status).toBe(404);
    expect(res.json<{ error: { type: string } }>().error.type).toBe('not_found');
    await close();
  });

  it('处理器抛错返回 500 而不是崩溃进程', async () => {
    const server = makeServer((r) => {
      r.get('/boom', () => {
        throw new Error('炸了');
      });
    });
    const { port, close } = await listen(server);
    const res = await request(port, '/boom');
    expect(res.status).toBe(500);
    expect(res.json<{ error: { message: string } }>().error.message).toBe('炸了');
    await close();
  });

  it('中间件可拦截请求（鉴权场景）', async () => {
    const router = new Router();
    router.get('/secret', (ctx) => sendJSON(ctx.res, 200, { secret: true }));
    const auth: Middleware = async (ctx, next) => {
      if (ctx.req.headers['x-admin-key'] !== 'good') {
        sendError(ctx.res, 401, 'unauthorized', 'auth_error');
        return;
      }
      await next();
    };
    const server = createHttpServer({
      gatewayId: 'main',
      handler: handlerFor(router),
      middleware: [auth],
    });
    const { port, close } = await listen(server);

    expect((await request(port, '/secret')).status).toBe(401);
    expect((await request(port, '/secret', { headers: { 'x-admin-key': 'bad' } })).status).toBe(401);
    expect((await request(port, '/secret', { headers: { 'x-admin-key': 'good' } })).status).toBe(200);
    await close();
  });

  it('sendText 设置文本类型', async () => {
    const server = makeServer((r) => {
      r.get('/t', (ctx) => sendText(ctx.res, 200, 'hi'));
    });
    const { port, close } = await listen(server);
    const res = await request(port, '/t');
    expect(res.body).toBe('hi');
    expect(res.headers['content-type']).toContain('text/plain');
    await close();
  });
});

describe('shutdownServer 优雅退出', () => {
  it('停止接受新连接，但在途请求正常完成，随后执行 onClose', async () => {
    const gate = deferred();
    let inFlightStarted = false;

    const router = new Router();
    router.get('/slow', async (ctx) => {
      inFlightStarted = true;
      await gate.promise;
      sendJSON(ctx.res, 200, { ok: true });
    });
    const server = createHttpServer({
      gatewayId: 'main',
      handler: handlerFor(router),
    });
    const { port } = await listen(server);

    const pending = request(port, '/slow');
    await delay(50);
    expect(inFlightStarted).toBe(true);

    let onCloseRan = false;
    const shutdown = shutdownServer(server, {
      graceMs: 5000,
      onClose: () => {
        onCloseRan = true;
      },
    });

    // 在途请求还没结束，onClose 不该提前跑
    await delay(100);
    expect(onCloseRan).toBe(false);

    gate.resolve();
    expect((await pending).json()).toEqual({ ok: true });
    await shutdown;
    expect(onCloseRan).toBe(true);

    // 关闭完成后端口确实不再接受连接
    await expect(request(port, '/slow')).rejects.toThrow();
  });

  it('超过宽限期则强制断开剩余连接并照常收尾', async () => {
    const router = new Router();
    // 永远不返回的请求
    router.get('/hang', async () => {
      await new Promise(() => {});
    });
    const server = createHttpServer({
      gatewayId: 'main',
      handler: handlerFor(router),
    });
    const { port } = await listen(server);

    const pending = request(port, '/hang').catch(() => null); // 会被强制断开
    await delay(50);

    let onCloseRan = false;
    const started = Date.now();
    await shutdownServer(server, {
      graceMs: 100,
      onClose: () => {
        onCloseRan = true;
      },
    });
    expect(onCloseRan).toBe(true);
    expect(Date.now() - started).toBeLessThan(3000); // 没有一直等下去
    await pending;
  });
});

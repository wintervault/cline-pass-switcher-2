import type http from 'node:http';

/** 单次请求的上下文。后续阶段会往里挂鉴权结果、配置引用等。 */
export interface Ctx {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  method: string;
  path: string;
}

export type Handler = (ctx: Ctx) => Promise<void> | void;
export type Next = () => Promise<void>;
export type Middleware = (ctx: Ctx, next: Next) => Promise<void>;

/**
 * 极简路由表：`METHOD + 路径` 精确匹配。
 *
 * 本项目只有十几条路由、没有路径参数，所以不做模式匹配——把复杂度留给真正需要的地方
 * （流式透传、故障转移），而不是路由解析。
 */
export class Router {
  readonly #table = new Map<string, Handler>();
  #fallback: Handler | null = null;

  route(method: string, path: string, handler: Handler): this {
    this.#table.set(`${method.toUpperCase()} ${path}`, handler);
    return this;
  }

  get(path: string, handler: Handler): this {
    return this.route('GET', path, handler);
  }

  post(path: string, handler: Handler): this {
    return this.route('POST', path, handler);
  }

  /** 未匹配任何路由时的处理器（404 或静态资源兜底）。 */
  setFallback(handler: Handler): this {
    this.#fallback = handler;
    return this;
  }

  resolve(method: string, path: string): Handler | null {
    return this.#table.get(`${method.toUpperCase()} ${path}`) ?? this.#fallback;
  }

  /** 已注册的路由数量，用于启动日志。 */
  get size(): number {
    return this.#table.size;
  }
}

/**
 * 把中间件链与最终处理器组合成一个函数（koa 风格）。
 * 中间件只需在需要放行时 `await next()`；不调用即拦截。
 *
 * 返回类型收窄为 `Promise<void>`（而非 Handler 的联合类型），调用方才能安全地 `.catch()`。
 */
export function compose(middleware: readonly Middleware[], final: Handler): (ctx: Ctx) => Promise<void> {
  return async (ctx: Ctx): Promise<void> => {
    let lastIndex = -1;
    const dispatch = async (index: number): Promise<void> => {
      if (index <= lastIndex) throw new Error('next() 被重复调用');
      lastIndex = index;
      const mw = middleware[index];
      if (!mw) return final(ctx);
      await mw(ctx, () => dispatch(index + 1));
    };
    await dispatch(0);
  };
}

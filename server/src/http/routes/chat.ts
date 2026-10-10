import { Readable } from 'node:stream';

import type { AppContext } from '../../appContext.ts';
import { type ChainStream, sameSlug } from '../../proxy/chain.ts';
import { RoutingTap } from '../../proxy/stream.ts';
import { emptyRouting } from '../../upstream/routing.ts';
import { sendError } from '../respond.ts';
import type { Ctx, Handler } from '../router.ts';
import { readJsonBody, recordHistory } from './api.ts';

const CHAT_PATHS = new Set(['/chat/completions', '/v1/chat/completions', '/api/v1/chat/completions']);
const MODELS_PATHS = new Set(['/v1/models', '/api/v1/models', '/models']);

/** OpenAI 兼容端点的路径。 */
export const isChatPath = (path: string): boolean => CHAT_PATHS.has(path);
export const isModelsPath = (path: string): boolean => MODELS_PATHS.has(path);

/** HTTP 响应头只允许 Latin-1：账号名里的中文等字符需要清洗（历史/统计仍用原名）。 */
function headerSafe(s: string | undefined): string {
  const cleaned = String(s ?? '')
    .replace(/[^\x20-\x7E]/g, '')
    .trim()
    .slice(0, 80);
  return cleaned || '-';
}

/** `/v1/models`：默认只暴露订阅模型（避免目录模型淹没客户端选择器），exposeCatalog 时合并完整目录。 */
export function modelsHandler(ctx: AppContext): Handler {
  return async (c: Ctx) => {
    const config = ctx.configStore.value;
    const ids = config.exposeCatalog
      ? [...new Set([...config.knownModels, ...(await ctx.catalog.catalog())])]
      : [...new Set([...config.knownModels, ...Object.keys(config.perModel)])];
    sendList(c, ids);
  };
}

function sendList(c: Ctx, ids: string[]): void {
  const payload = JSON.stringify({ object: 'list', data: ids.map((id) => ({ id, object: 'model' })) });
  c.res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  c.res.end(payload);
}

/** `/chat/completions`：OpenAI 兼容代理主入口，全部故障转移逻辑在 ChatChain。 */
export function chatHandler(ctx: AppContext): Handler {
  return async (c: Ctx) => {
    const body = await readJsonBody(c.req);
    if (!body.ok) {
      return sendError(
        c.res,
        body.reason === 'too-large' ? 413 : 400,
        body.reason === 'too-large' ? 'body too large' : 'invalid JSON body',
      );
    }
    const payload = (body.value ?? {}) as { model?: unknown; stream?: unknown };
    const modelId = typeof payload.model === 'string' ? payload.model : '';
    if (!modelId) return sendError(c.res, 400, 'model is required');

    const config = ctx.configStore.value;
    const meta = ctx.metaStore.value.models[modelId];
    const isStream = payload.stream === true;

    const result = await ctx.chain.run({
      modelId,
      body: payload as Record<string, unknown>,
      cfg: config.perModel[modelId],
      meta,
      stream: isStream,
      clientSignal: c.abortSignal,
    });

    const targets = (config.perModel[modelId]?.upstreams ?? []).filter(Boolean);

    // 客户端实际使用成功的新订阅模型自动收录进清单（只增不删）
    if (result.outcome === 'success' && /^cline-pass\//.test(modelId) && !config.knownModels.includes(modelId)) {
      ctx.configStore.update((cfg) => {
        cfg.knownModels.push(modelId);
      });
    }

    if (isStream && result.outcome === 'stream') {
      return respondStream(ctx, c, modelId, result, targets);
    }
    if (result.outcome === 'stream') {
      return sendError(c.res, 502, 'unexpected stream outcome');
    }

    recordHistory(ctx, modelId, result, { stream: false });

    if (result.degraded) c.res.setHeader('X-Cline-Degraded', '1');
    c.res.writeHead(result.status, {
      'Content-Type': 'application/json',
      'X-Cline-Target-Upstream': targets.length ? targets.join('>') : 'auto',
      'X-Cline-Actual-Upstream': result.routing.finalProvider ?? 'unknown',
      'X-Cline-Canonical-Model': result.routing.canonicalSlug ?? '',
      'X-Cline-Attempts': String(result.trace.length),
      'X-Cline-Account': headerSafe(result.account?.name),
    });
    c.res.end(JSON.stringify(result.body));
  };
}

/**
 * 流式透传。
 *
 * 诚实限制：HTTP 响应头必须先于 body 发送，而流式的「实际上游」在 SSE 开始时还不知道，
 * 所以流式响应没有 X-Cline-Actual-Upstream——它只会记录在请求历史里（流结束时从尾部
 * 元数据解析出来）。不用 HTTP Trailer：浏览器 fetch 读不到。
 */
function respondStream(ctx: AppContext, c: Ctx, modelId: string, result: ChainStream, targets: string[]): void {
  const upstream = result.response;
  const ctype = upstream.headers.get('content-type') ?? 'text/event-stream';

  c.res.writeHead(200, {
    'Content-Type': ctype,
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Cline-Target-Upstream': targets.length ? targets.join('>') : 'auto',
    'X-Cline-Attempts': String(result.trace.length),
    'X-Cline-Account': headerSafe(result.account?.name),
    ...(result.degraded ? { 'X-Cline-Degraded': '1' } : {}),
  });

  // 客户端中途断开：取消上游流，别让它继续烧 token
  c.res.on('close', () => {
    if (!c.res.writableEnded) void upstream.body?.cancel().catch(() => {});
  });

  const tap = new RoutingTap();
  c.res.on('finish', () => {
    // RoutingTap._flush 在流结束时解析元数据，'finish' 时结果已就绪
    const { provider, canonical } = tap.result();
    const routing = emptyRouting();
    routing.finalProvider = provider;
    routing.canonicalSlug = canonical;
    // 流式钉住审计：只能标记不能撤回（内容已流出）——写入历史供 UI 红标（D3）
    const { enforced, strict, target } = result.pinAudit;
    const pinMismatch = enforced && strict && target !== null && provider !== null && !sameSlug(provider, target);
    recordHistory(ctx, modelId, { ...result, routing, outcome: result.outcome }, { stream: true, pinMismatch });
  });

  if (result.head.length) c.res.write(result.head);
  if (!upstream.body) {
    c.res.end();
    return;
  }
  Readable.fromWeb(upstream.body as import('node:stream/web').ReadableStream)
    .pipe(tap)
    .pipe(c.res);
}

import type { IncomingMessage } from 'node:http';

import { type AppContext, updateConfig } from '../../appContext.ts';
import { isConfigured, publicProxyBase } from '../../config/derive.ts';
import type { Account, Config, PerModelConfig } from '../../config/schema.ts';
import type { ChainResult } from '../../proxy/chain.ts';
import { maskSecret } from '../../security/compare.ts';
import { fetchJSON } from '../../upstream/client.ts';
import type { RoutingInfo } from '../../upstream/routing.ts';
import { sendError, sendJSON } from '../respond.ts';
import type { Ctx, Handler } from '../router.ts';

const MAX_BODY = 50 * 1024 * 1024;

/** 读请求体并解析 JSON；超大或畸形返回 null（调用方回 400/413）。 */
export function readJsonBody(
  req: IncomingMessage,
  limit = MAX_BODY,
): Promise<{ ok: true; value: unknown } | { ok: false; reason: 'too-large' | 'bad-json' }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        req.destroy();
        resolve({ ok: false, reason: 'too-large' });
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve({ ok: true, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
      } catch {
        resolve({ ok: false, reason: 'bad-json' });
      }
    });
    req.on('error', () => resolve({ ok: false, reason: 'bad-json' }));
  });
}

/** perModel 归一化：去重、限长、exclude 优先于 upstreams。 */
export function normalizePerModel(raw: unknown): PerModelConfig {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const toList = (v: unknown): string[] =>
    [...new Set((Array.isArray(v) ? v : []).map((s) => String(s ?? '').trim()).filter(Boolean))].slice(0, 10);

  let upstreams = toList(source['upstreams']);
  const exclude = toList(source['exclude']);
  const excl = new Set(exclude);
  upstreams = upstreams.filter((u) => !excl.has(u));

  return {
    upstreams,
    exclude,
    pinMode: source['pinMode'] === 'preferred' ? 'preferred' : 'strict',
    sort: source['sort'] === 'cost' || source['sort'] === 'ttft' || source['sort'] === 'tps' ? source['sort'] : null,
  };
}

/**
 * 账号列表合并（前端编辑结果 → 服务端账号池）。
 *
 * key 的归属由每行的 `existingIndex`（编辑开始时在旧列表里的下标）显式指定，
 * **绝不能按当前行号对位**：删除一行会让后面的行错位继承别人的密钥（数据破坏）。
 * 前端拿不到明文，留空 = 用 existingIndex 指向的旧 key；掩码串原样传回也当作「未修改」。
 */
export function mergeAccounts(existing: Account[], incoming: unknown): Account[] {
  const rows = Array.isArray(incoming) ? incoming : [];
  return rows
    .map((raw, i) => {
      const a = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
      const name = String(a['name'] ?? `账号${i + 1}`).slice(0, 50);
      const key = String(a['key'] ?? '').trim();
      const safeKey = /^[•*]+$/.test(key.slice(0, -4)) || key.includes('•') ? '' : key;
      const keepIdx = a['existingIndex'];
      const kept =
        typeof keepIdx === 'number' && Number.isInteger(keepIdx) && keepIdx >= 0 ? (existing[keepIdx]?.key ?? '') : '';
      return { name, key: safeKey || kept, enabled: a['enabled'] !== false };
    })
    .filter((a) => a.key);
}

/** 订阅模型 + 配置 + 观测数据（控制台主表数据源）。 */
function subscriptionView(ctx: AppContext) {
  const config = ctx.configStore.value;
  const meta = ctx.metaStore.value;
  return config.knownModels.map((id) => ({
    id,
    config: config.perModel[id] ?? null,
    meta: meta.models[id] ?? null,
  }));
}

/**
 * 把 /api/security 的补丁合并进配置（纯函数）。
 *
 * proxyKey 是三态语义（回归测试锁住）：
 * - `undefined` 或空串 = **保持不变**——前端拿不到明文，「留空」是常态；
 *   旧实现用空串直接覆盖，用户在设置页只改公网地址就会把已设密钥静默清掉；
 * - `null` = 显式清除（关闭鉴权，前端走「清除密钥」按钮）；
 * - 非空串 = 设置新密钥。
 */
export function applySecurityPatch(cfg: Config, payload: Record<string, unknown>): void {
  if (payload['proxyKey'] !== undefined) {
    if (payload['proxyKey'] === null) {
      cfg.proxyKey = '';
    } else {
      const v = String(payload['proxyKey']).trim();
      if (v) cfg.proxyKey = v;
    }
  }
  if (payload['publicBaseUrl'] !== undefined)
    cfg.publicBaseUrl = String(payload['publicBaseUrl']).trim().replace(/\/+$/, '');
  if (payload['exposeCatalog'] !== undefined) cfg.exposeCatalog = !!payload['exposeCatalog'];
  if (payload['corsOrigins'] !== undefined && Array.isArray(payload['corsOrigins'])) {
    cfg.corsOrigins = payload['corsOrigins'].map((s) => String(s).trim()).filter(Boolean);
  }
}

export function registerApiRoutes(
  ctx: AppContext,
  router: { get(path: string, handler: Handler): void; post(path: string, handler: Handler): void },
): void {
  const config = () => ctx.configStore.value;
  const meta = () => ctx.metaStore.value;

  router.get('/api/meta', (c: Ctx) => {
    sendJSON(c.res, 200, {
      version: ctx.version,
      authRequired: !!config().proxyKey,
      configured: isConfigured(config()),
      proxyBase: publicProxyBase(config()),
    });
  });

  router.get('/api/models', (c: Ctx) => {
    void ctx.catalog.catalog().then((catalogIds) => {
      sendJSON(c.res, 200, {
        subscription: subscriptionView(ctx),
        catalogCount: catalogIds.length,
        catalog: catalogIds,
        proxyBase: publicProxyBase(config()),
        officialFetch: meta().officialModelsFetch,
      });
    });
  });

  router.post('/api/probe', async (c: Ctx) => {
    const body = await readJsonBody(c.req);
    if (!body.ok) return sendError(c.res, 400, body.reason === 'bad-json' ? 'invalid JSON body' : 'body too large');
    const model = (body.value as { model?: unknown })?.model;
    if (typeof model !== 'string' || !model) return sendError(c.res, 400, 'model required');
    try {
      const result = await ctx.probe.probeModel(model, c.abortSignal);
      sendJSON(c.res, result.ok ? 200 : 502, result);
    } catch (err) {
      sendJSON(c.res, 502, { ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/api/validate-upstreams', async (c: Ctx) => {
    const body = await readJsonBody(c.req);
    if (!body.ok) return sendError(c.res, 400, body.reason === 'bad-json' ? 'invalid JSON body' : 'body too large');
    const model = (body.value as { model?: unknown })?.model;
    if (typeof model !== 'string' || !model) return sendError(c.res, 400, 'model required');
    const outcome = await ctx.probe.validateUpstreams(model, c.abortSignal);
    if (!outcome.ok) {
      // 钉住参数被网关丢弃：校验结果是假绿，明确拒绝而不是输出全绿误导
      sendJSON(c.res, 409, { ok: false, error: outcome.reason, pinState: outcome.pinState });
      return;
    }
    const summary: Record<string, number> = { ok: 0, limited: 0, bad: 0, auth: 0, unknown: 0 };
    for (const r of Object.values(outcome.results)) summary[r.status] = (summary[r.status] ?? 0) + 1;
    sendJSON(c.res, 200, {
      ok: true,
      summary,
      results: outcome.results,
      upstreams: outcome.upstreams,
      pinState: outcome.pinState,
    });
  });

  router.post('/api/fetch-official-models', async (c: Ctx) => {
    const result = await ctx.catalog.fetchOfficialModels(c.abortSignal);
    sendJSON(c.res, 200, { ok: true, ...result });
  });

  router.post('/api/test', async (c: Ctx) => {
    const body = await readJsonBody(c.req);
    if (!body.ok) return sendError(c.res, 400, body.reason === 'bad-json' ? 'invalid JSON body' : 'body too large');
    const payload = (body.value ?? {}) as {
      model?: unknown;
      upstream?: unknown;
      upstreams?: unknown;
      exclude?: unknown;
    };
    const model = typeof payload.model === 'string' ? payload.model : '';
    if (!model) return sendError(c.res, 400, 'model required');

    // 临时配置覆盖：不落盘，仅本次请求生效（与保存的配置叠加）
    const base = config().perModel[model];
    const cfg: PerModelConfig = base ? { ...base } : { upstreams: [], exclude: [], pinMode: 'strict', sort: null };
    if (payload.upstreams !== undefined) cfg.upstreams = normalizePerModel({ upstreams: payload.upstreams }).upstreams;
    else if (payload.upstream !== undefined)
      cfg.upstreams = typeof payload.upstream === 'string' && payload.upstream ? [payload.upstream] : [];
    if (payload.exclude !== undefined) cfg.exclude = normalizePerModel({ exclude: payload.exclude }).exclude;

    const result = await ctx.chain.run({
      modelId: model,
      body: { model, messages: [{ role: 'user', content: 'Reply with the word OK' }], max_tokens: 256 },
      cfg,
      meta: meta().models[model],
      stream: false,
      clientSignal: c.abortSignal,
    });

    const targets = cfg.upstreams.filter(Boolean);
    const trace = result.trace;
    if (result.outcome === 'stream') {
      // stream:false 的请求不会返回流式结果；防御性兜底
      sendJSON(c.res, 502, { ok: false, error: 'unexpected stream outcome', targets, trace });
      return;
    }
    recordHistory(ctx, model, result, { stream: false });

    if (result.outcome !== 'success') {
      const message = result.outcome === 'failure' ? result.message : 'unexpected stream outcome';
      sendJSON(c.res, 200, {
        ok: false,
        error: message.slice(0, 400),
        targets,
        exclude: cfg.exclude,
        trace,
        degraded: result.degraded,
      });
      return;
    }

    sendJSON(c.res, 200, {
      ok: true,
      ms: result.totalMs,
      targets,
      exclude: cfg.exclude,
      actual: result.routing.finalProvider,
      actualName: result.routing.finalProviderName,
      pipeline: result.routing.pipeline,
      pinnable: result.routing.pipeline !== null,
      canonicalSlug: result.routing.canonicalSlug,
      fallbacks: result.routing.fallbacks,
      content: typeof result.routing.content === 'string' ? result.routing.content.slice(0, 120) : '',
      account: result.account?.name ?? null,
      trace,
      degraded: result.degraded,
    });
  });

  router.get('/api/accounts', (c: Ctx) => {
    const cfg = config();
    const stats = meta().stats;
    // 不回传明文 key：只给掩码与指纹（末 4 位），编辑时留空 = 保持不变
    sendJSON(c.res, 200, {
      accounts: cfg.accounts.map((a) => ({
        name: a.name,
        enabled: a.enabled,
        keyMasked: maskSecret(a.key),
        keyTail: a.key.slice(-4),
        hasKey: !!a.key,
      })),
      mode: cfg.accountMode,
      active: cfg.activeAccount,
      stats,
    });
  });

  router.post('/api/accounts', async (c: Ctx) => {
    const body = await readJsonBody(c.req);
    if (!body.ok) return sendError(c.res, 400, body.reason === 'bad-json' ? 'invalid JSON body' : 'body too large');
    const payload = (body.value ?? {}) as {
      accounts?: unknown;
      mode?: unknown;
      active?: unknown;
    };
    const accounts = mergeAccounts(config().accounts, payload.accounts);
    if (!accounts.length) return sendError(c.res, 400, '至少需要一个有效账号（key 非空）');

    updateConfig(ctx, (cfg) => {
      cfg.accounts = accounts;
      cfg.accountMode = payload.mode === 'roundrobin' ? 'roundrobin' : payload.mode === 'single' ? 'single' : 'sticky';
      const wanted = Number(payload.active);
      cfg.activeAccount = Number.isInteger(wanted) ? Math.min(Math.max(0, wanted), accounts.length - 1) : 0;
    });
    sendJSON(c.res, 200, {
      ok: true,
      accounts: accounts.length,
      mode: config().accountMode,
      active: config().activeAccount,
    });
  });

  router.post('/api/accounts/test', async (c: Ctx) => {
    const body = await readJsonBody(c.req);
    if (!body.ok) return sendError(c.res, 400, body.reason === 'bad-json' ? 'invalid JSON body' : 'body too large');
    const payload = (body.value ?? {}) as { key?: unknown; index?: unknown };
    // 两种用法：传 key（新增账号保存前测试）或传 index（测试已存账号——服务端取，前端拿不到明文）
    let key = String(payload.key ?? '').trim();
    if (!key && typeof payload.index === 'number' && Number.isInteger(payload.index)) {
      key = config().accounts[payload.index]?.key ?? '';
    }
    if (!key) return sendError(c.res, 400, 'key required');

    const started = Date.now();
    const model = config().knownModels[0] ?? 'cline-pass/glm-5.3-flash';
    const { json } = await fetchJSON(
      `${config().upstreamBase}/chat/completions`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Say OK' }], max_tokens: 512 }),
        signal: c.abortSignal,
      },
      120_000,
    );
    const shaped = json as { error?: unknown } | null;
    if (shaped && typeof shaped === 'object' && shaped.error) {
      const message = typeof shaped.error === 'string' ? shaped.error : JSON.stringify(shaped.error);
      const authFail = /unauthorized|re-authenticate|invalid\s*api|401/i.test(message);
      // 密钥无效直接 Unauthorized；其他错误（如推理模型耗尽 max_tokens 的 empty response）
      // 说明鉴权已通过，不应误报为密钥问题
      return sendJSON(
        c.res,
        200,
        authFail
          ? { ok: false, ms: Date.now() - started, error: `密钥无效或未授权：${message.slice(0, 160)}` }
          : { ok: true, ms: Date.now() - started, model, note: `密钥鉴权通过；网关提示：${message.slice(0, 120)}` },
      );
    }
    sendJSON(c.res, 200, { ok: true, ms: Date.now() - started, model });
  });

  router.get('/api/security', (c: Ctx) => {
    const cfg = config();
    sendJSON(c.res, 200, {
      hasProxyKey: !!cfg.proxyKey,
      publicBaseUrl: cfg.publicBaseUrl,
      authRequired: !!cfg.proxyKey,
      exposeCatalog: cfg.exposeCatalog,
      corsOrigins: cfg.corsOrigins,
    });
  });

  router.post('/api/security', async (c: Ctx) => {
    const body = await readJsonBody(c.req);
    if (!body.ok) return sendError(c.res, 400, body.reason === 'bad-json' ? 'invalid JSON body' : 'body too large');
    const payload = (body.value ?? {}) as Record<string, unknown>;

    updateConfig(ctx, (cfg) => applySecurityPatch(cfg, payload));

    const cfg = config();
    sendJSON(c.res, 200, {
      ok: true,
      hasProxyKey: !!cfg.proxyKey,
      publicBaseUrl: cfg.publicBaseUrl,
      authRequired: !!cfg.proxyKey,
      proxyBase: publicProxyBase(cfg),
      exposeCatalog: cfg.exposeCatalog,
      corsOrigins: cfg.corsOrigins,
    });
  });

  router.get('/api/history', (c: Ctx) => {
    sendJSON(c.res, 200, { history: meta().history });
  });

  // 桌面壳/UI 的启停通道。放行条件（三重，全部满足）：
  // ① 来自回环地址——Docker/反代部署的远程请求来源不是 127.0.0.1，直接拒绝；
  // ② 无 Origin 且无 Referer——浏览器的跨源 fetch 必带 Origin（被拦），本机恶意网页
  //    打不到这里；非浏览器客户端（壳、curl）天然不带。本机恶意进程本来就能 taskkill，
  //    这不引入新的攻击面。
  // 鉴权不走 proxyKey：壳不应依赖用户的下游密钥配置。
  router.post('/api/shutdown', async (c: Ctx) => {
    const remote = c.req.socket.remoteAddress ?? '';
    const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
    const browserLike = c.req.headers['origin'] !== undefined || c.req.headers['referer'] !== undefined;
    if (!loopback || browserLike || !ctx.onShutdown) {
      sendError(c.res, 404, 'not found', 'not_found');
      return;
    }
    sendJSON(c.res, 200, { ok: true, message: '服务正在优雅关停' });
    // 让响应先落到线上再关停
    setTimeout(() => ctx.onShutdown?.('control-api'), 50);
  });

  router.get('/api/config', (c: Ctx) => {
    const cfg: Config = config();
    sendJSON(c.res, 200, { port: cfg.port, perModel: cfg.perModel, knownModels: cfg.knownModels });
  });

  router.post('/api/config', async (c: Ctx) => {
    const body = await readJsonBody(c.req);
    if (!body.ok) return sendError(c.res, 400, body.reason === 'bad-json' ? 'invalid JSON body' : 'body too large');
    const perModel = (body.value as { perModel?: unknown })?.perModel;
    if (perModel && typeof perModel === 'object' && !Array.isArray(perModel)) {
      updateConfig(ctx, (cfg) => {
        for (const [model, raw] of Object.entries(perModel as Record<string, unknown>)) {
          cfg.perModel[model] = normalizePerModel(raw);
        }
      });
    }
    sendJSON(c.res, 200, { ok: true });
  });
}

/** 记录请求历史与账号统计（历史条数受 historyLimit 约束）。 */
export function recordHistory(
  ctx: AppContext,
  modelId: string,
  result: {
    account: { name: string } | null;
    trace: ChainResult['trace'];
    totalMs: number;
    outcome: string;
    routing: RoutingInfo;
    message?: string;
    degraded?: boolean;
  },
  options: { stream: boolean; pinMismatch?: boolean },
): void {
  ctx.metaStore.update((meta) => {
    const entry = {
      ts: Date.now(),
      model: modelId,
      provider: result.routing.finalProvider,
      canonical: result.routing.canonicalSlug,
      ms: result.totalMs,
      stream: options.stream,
      error: result.outcome === 'failure' ? (result.message ?? null) : null,
      account: result.account?.name ?? null,
      attempts: result.trace.map((t) => t.upstream ?? 'auto'),
      trace: result.trace,
      pinMismatch: options.pinMismatch ?? false,
    };
    meta.history.unshift(entry);
    if (meta.history.length > ctx.configStore.value.historyLimit)
      meta.history.length = ctx.configStore.value.historyLimit;

    if (result.account) {
      const name = result.account.name;
      const existing = meta.stats[name];
      const st = existing ?? { requests: 0, lastUsed: null, lastError: null };
      meta.stats[name] = st;
      st.requests += 1;
      st.lastUsed = Date.now();
      st.lastError = result.outcome === 'failure' ? (result.message ?? null) : null;
    }
  });
}

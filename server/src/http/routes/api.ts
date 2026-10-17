import type { IncomingMessage } from 'node:http';

import { expiryState } from '../../accounts/expiry.ts';
import { ensureUniqueAccountNames } from '../../accounts/naming.ts';
import { type AppContext, updateConfig } from '../../appContext.ts';
import { isIsoDate } from '../../config/date.ts';
import {
  consoleGateway,
  gatewayById,
  gatewayConfigured,
  gatewayEnabledAccounts,
  gatewayProxyBase,
} from '../../config/derive.ts';
import {
  type Account,
  defaultGateway,
  type Gateway,
  GatewaySchema,
  MAX_GATEWAYS,
  type PerModelConfig,
} from '../../config/schema.ts';
import type { ChainResult } from '../../proxy/chain.ts';
import { isLoopbackHost, maskSecret } from '../../security/compare.ts';
import { fetchJSON } from '../../upstream/client.ts';
import type { RoutingInfo } from '../../upstream/routing.ts';
import { gatewayModels } from '../../upstream/types.ts';
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

/** perModel 映射归一化（每个模型的配置逐个收敛）。 */
function normalizePerModelMap(raw: unknown): Record<string, PerModelConfig> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, PerModelConfig> = {};
  for (const [id, cfg] of Object.entries(raw as Record<string, unknown>)) {
    if (!id.trim()) continue;
    out[id] = normalizePerModel(cfg);
  }
  return out;
}

/**
 * 账号列表合并（前端编辑结果 → 服务端账号池）。
 *
 * key 的归属由每行的 `existingIndex`（编辑开始时在旧列表里的下标）显式指定，
 * **绝不能按当前行号对位**：删除一行会让后面的行错位继承别人的密钥（数据破坏）。
 * 前端拿不到明文，留空 = 用 existingIndex 指向的旧 key；掩码串原样传回也当作「未修改」。
 *
 * `expiresAt` 是三态语义：缺省 = 保持不变（老客户端/局部提交），`null`/空串 = 清空，
 * 合法日期 = 设置。非法日期同样按「保持」处理——手抖打错不该把已有日期清掉。
 */
export function mergeAccounts(existing: Account[], incoming: unknown): Account[] {
  return mergeAccountsDetailed(existing, incoming).accounts;
}

export interface AccountMergeResult {
  accounts: Account[];
  /** 名字变了的账号（旧名 → 新名），调用方据此迁移按名字索引的观测数据。 */
  renames: Array<{ from: string; to: string }>;
}

export function mergeAccountsDetailed(existing: Account[], incoming: unknown): AccountMergeResult {
  const rows = Array.isArray(incoming) ? incoming : [];
  const picked: Array<{ account: Account; priorName: string | null }> = [];

  rows.forEach((raw, i) => {
    const a = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const name = String(a['name'] ?? `账号${i + 1}`).slice(0, 50);
    const key = String(a['key'] ?? '').trim();
    const safeKey = /^[•*]+$/.test(key.slice(0, -4)) || key.includes('•') ? '' : key;
    const keepIdx = a['existingIndex'];
    const prior =
      typeof keepIdx === 'number' && Number.isInteger(keepIdx) && keepIdx >= 0 ? existing[keepIdx] : undefined;
    const finalKey = safeKey || prior?.key || '';
    if (!finalKey) return; // 新行没填 key 就丢弃（空账号没有意义）

    let expiresAt = prior?.expiresAt;
    const rawExpires = a['expiresAt'];
    if (rawExpires === null || rawExpires === '') expiresAt = undefined;
    else if (typeof rawExpires === 'string' && isIsoDate(rawExpires)) expiresAt = rawExpires;

    picked.push({
      account: {
        name,
        key: finalKey,
        enabled: a['enabled'] !== false,
        ...(expiresAt ? { expiresAt } : {}),
      },
      priorName: prior?.name ?? null,
    });
  });

  const unified = ensureUniqueAccountNames(picked.map((p) => p.account));
  const renames: Array<{ from: string; to: string }> = [];
  unified.accounts.forEach((account, i) => {
    const priorName = picked[i]?.priorName ?? null;
    if (priorName && priorName !== account.name) renames.push({ from: priorName, to: account.name });
  });
  return { accounts: unified.accounts, renames };
}

/**
 * 账号改名 / 删除后整理按账号名索引的观测数据（用量统计、风控结论）。
 *
 * 两段式（先全部取出并删除，再写入新名）是必须的：改名可以成环
 * （A→B、B→A），逐条搬会把目标位置的旧数据覆盖掉。
 * 历史记录不动——那是行为日志，账号名在里面是历史事实。
 */
function migrateAccountMeta(ctx: AppContext, renames: Array<{ from: string; to: string }>, names: string[]): void {
  const alive = new Set(names);
  const hasStale = [...Object.keys(ctx.metaStore.value.stats), ...Object.keys(ctx.metaStore.value.accountClass)].some(
    (n) => !alive.has(n),
  );
  if (!renames.length && !hasStale) return;

  ctx.metaStore.update((meta) => {
    const moves = renames.map((r) => ({ ...r, stats: meta.stats[r.from], cls: meta.accountClass[r.from] }));
    for (const r of renames) {
      delete meta.stats[r.from];
      delete meta.accountClass[r.from];
    }
    for (const m of moves) {
      if (!alive.has(m.to)) continue;
      if (m.stats) meta.stats[m.to] = m.stats;
      if (m.cls) meta.accountClass[m.to] = m.cls;
    }
    for (const name of Object.keys(meta.stats)) if (!alive.has(name)) delete meta.stats[name];
    for (const name of Object.keys(meta.accountClass)) if (!alive.has(name)) delete meta.accountClass[name];
  });
}

/** 订阅模型 + 配置 + 观测数据（控制台主表数据源，按网关）。 */
function subscriptionView(ctx: AppContext, gateway: Gateway) {
  const meta = gatewayModels(ctx.metaStore.value, gateway.id);
  return gateway.knownModels.map((id) => ({
    id,
    config: gateway.perModel[id] ?? null,
    meta: meta[id] ?? null,
  }));
}

/**
 * 请求指向哪个网关：`?gateway=<id>`，缺省 = 控制台网关。
 * 返回 null 表示 id 不存在（调用方回 404，不要静默回退到别的网关——那会把请求发到错误的地方）。
 */
function requestGateway(ctx: AppContext, c: Ctx): Gateway | null {
  const config = ctx.configStore.value;
  const id = c.url.searchParams.get('gateway') ?? config.console.gatewayId;
  return gatewayById(config, id);
}

/** 网关视图：配置 + 运行状态 + 统计。**不回传明文密钥**。 */
function gatewayViews(ctx: AppContext) {
  const config = ctx.configStore.value;
  const statuses = new Map(ctx.gateways.statuses().map((s) => [s.id, s]));
  return config.gateways.map((gateway) => {
    const { proxyKey, ...rest } = gateway;
    const status = statuses.get(gateway.id) ?? {
      id: gateway.id,
      state: 'stopped' as const,
      boundPort: null,
      boundHost: null,
    };
    return {
      ...rest,
      hasProxyKey: !!proxyKey,
      accountCount: gatewayEnabledAccounts(config, gateway).length,
      modelCount: gateway.knownModels.length,
      proxyBase: gatewayProxyBase(gateway),
      status,
    };
  });
}

/**
 * 网关配置写回后应用监听变更。
 *
 * 若变的是**当前请求所在的 listener**（改控制台网关端口/切换控制台），
 * 不能在这里等 reconcile——关闭 listener 会等这个请求结束，而请求正在等 reconcile。
 * 所以先回响应，`finish` 之后再做。前端靠 `/api/gateways` 的轮询看到最终状态。
 */
async function applyGatewayChange(ctx: AppContext, c: Ctx, changedIds: string[]): Promise<boolean> {
  if (changedIds.includes(c.gatewayId)) {
    c.res.once('finish', () => {
      setTimeout(() => void ctx.gateways.reconcile(), 50);
    });
    return true;
  }
  await ctx.gateways.reconcile();
  return false;
}

/**
 * 网关保存请求的字段白名单与归一化（防止前端顺手改掉 id 之类的东西）。
 * proxyKey 三态：缺省/空串 = 保持，null = 清除，非空 = 设置——前端拿不到明文，「留空」是常态。
 */
export type GatewayMergeResult =
  | { ok: true; gateway: Gateway }
  | { ok: false; code: string; message: string; params?: Record<string, string | number> };

/**
 * 网关保存请求的字段白名单与归一化。
 *
 * 失败时同时给 `code`（前端按语言映射）与中文 `message`（日志/老客户端兜底）——
 * 控制台文案不靠服务端拼中文。
 */
export function mergeGatewayPayload(raw: Record<string, unknown>, existing: Gateway | null): GatewayMergeResult {
  const fallback = existing ?? defaultGateway({ id: String(raw['id'] ?? '') });
  const name = typeof raw['name'] === 'string' ? raw['name'].trim() : fallback.name;
  if (!name || name.length > 50) return { ok: false, code: 'gateway.nameInvalid', message: '网关名称需要 1-50 个字符' };

  const port = raw['port'] === undefined ? fallback.port : Number(raw['port']);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    return { ok: false, code: 'gateway.portInvalid', message: '端口必须是 1-65535 的整数' };

  const bindHost = typeof raw['bindHost'] === 'string' ? raw['bindHost'].trim() : fallback.bindHost;
  if (!bindHost) return { ok: false, code: 'gateway.bindHostRequired', message: '绑定地址不能为空' };

  const accountMode =
    raw['accountMode'] === 'single' || raw['accountMode'] === 'roundrobin' || raw['accountMode'] === 'sticky'
      ? raw['accountMode']
      : fallback.accountMode;

  const allAccounts = typeof raw['allAccounts'] === 'boolean' ? raw['allAccounts'] : fallback.allAccounts;
  const accounts = Array.isArray(raw['accounts'])
    ? [...new Set(raw['accounts'].map((n) => String(n ?? '').trim()).filter(Boolean))]
    : fallback.accounts;

  const activeAccount = typeof raw['activeAccount'] === 'string' ? raw['activeAccount'].trim() : fallback.activeAccount;

  const corsOrigins = Array.isArray(raw['corsOrigins'])
    ? raw['corsOrigins'].map((o) => String(o ?? '').trim()).filter(Boolean)
    : fallback.corsOrigins;

  const knownModels = Array.isArray(raw['knownModels'])
    ? [...new Set(raw['knownModels'].map((m) => String(m ?? '').trim()).filter(Boolean))]
    : fallback.knownModels;

  // proxyKey 三态：缺省或空串 = 保持；null = 清除；非空 = 设置
  let proxyKey = fallback.proxyKey;
  if (raw['proxyKey'] === null) proxyKey = '';
  else if (typeof raw['proxyKey'] === 'string' && raw['proxyKey'].trim()) proxyKey = raw['proxyKey'].trim();

  const failover =
    raw['failover'] === undefined
      ? fallback.failover
      : (() => {
          const parsed = GatewaySchema.shape.failover.safeParse(raw['failover']);
          return parsed.success ? parsed.data : null;
        })();
  if (!failover) return { ok: false, code: 'gateway.failoverInvalid', message: '失败转移参数不合法' };

  return {
    ok: true,
    gateway: {
      ...fallback,
      name,
      port,
      bindHost,
      proxyKey,
      publicBaseUrl:
        typeof raw['publicBaseUrl'] === 'string'
          ? raw['publicBaseUrl'].trim().replace(/\/+$/, '')
          : fallback.publicBaseUrl,
      corsOrigins,
      exposeCatalog: typeof raw['exposeCatalog'] === 'boolean' ? raw['exposeCatalog'] : fallback.exposeCatalog,
      allAccounts,
      accounts,
      accountMode,
      activeAccount,
      knownModels,
      perModel: raw['perModel'] === undefined ? fallback.perModel : normalizePerModelMap(raw['perModel']),
      failover,
    },
  };
}

export function registerApiRoutes(
  ctx: AppContext,
  router: { get(path: string, handler: Handler): void; post(path: string, handler: Handler): void },
): void {
  const config = () => ctx.configStore.value;
  const meta = () => ctx.metaStore.value;

  router.get('/api/meta', (c: Ctx) => {
    const cfg = config();
    const gateway = consoleGateway(cfg);
    sendJSON(c.res, 200, {
      version: ctx.version,
      authRequired: !!gateway.proxyKey,
      configured: gatewayConfigured(cfg, gateway),
      proxyBase: gatewayProxyBase(gateway),
      consoleGatewayId: gateway.id,
      /** 只给「切换器」需要的字段；完整信息在 /api/gateways。 */
      gateways: cfg.gateways.map((g) => ({ id: g.id, name: g.name })),
    });
  });

  router.get('/api/models', (c: Ctx) => {
    const gateway = requestGateway(ctx, c);
    if (!gateway) return sendError(c.res, 404, 'unknown gateway', 'not_found');
    void ctx.catalog
      .catalog()
      .catch(() => [] as string[])
      .then((catalogIds) => {
        sendJSON(c.res, 200, {
          gateway: { id: gateway.id, name: gateway.name },
          subscription: subscriptionView(ctx, gateway),
          catalogCount: catalogIds.length,
          catalog: catalogIds,
          proxyBase: gatewayProxyBase(gateway),
          officialFetch: meta().officialModelsFetch,
        });
      });
  });

  router.post('/api/probe', async (c: Ctx) => {
    const body = await readJsonBody(c.req);
    if (!body.ok) return sendError(c.res, 400, body.reason === 'bad-json' ? 'invalid JSON body' : 'body too large');
    const model = (body.value as { model?: unknown })?.model;
    if (typeof model !== 'string' || !model) return sendError(c.res, 400, 'model required');
    const gateway = requestGateway(ctx, c);
    const runtime = gateway ? ctx.gateways.get(gateway.id) : null;
    if (!gateway || !runtime) return sendError(c.res, 404, 'unknown gateway', 'not_found');
    try {
      const result = await runtime.probe.probeModel(model, c.abortSignal);
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
    const gateway = requestGateway(ctx, c);
    const runtime = gateway ? ctx.gateways.get(gateway.id) : null;
    if (!gateway || !runtime) return sendError(c.res, 404, 'unknown gateway', 'not_found');
    const outcome = await runtime.probe.validateUpstreams(model, c.abortSignal);
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
    const gateway = requestGateway(ctx, c);
    if (!gateway) return sendError(c.res, 404, 'unknown gateway', 'not_found');
    const result = await ctx.catalog.fetchOfficialModels(c.abortSignal, {
      knownModels: gateway.knownModels,
      addKnownModels: (ids) =>
        updateConfig(ctx, (cfg) => {
          const target = cfg.gateways.find((g) => g.id === gateway.id);
          if (!target) return;
          for (const id of ids) if (!target.knownModels.includes(id)) target.knownModels.push(id);
        }),
    });
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

    const gateway = requestGateway(ctx, c);
    const runtime = gateway ? ctx.gateways.get(gateway.id) : null;
    if (!gateway || !runtime) return sendError(c.res, 404, 'unknown gateway', 'not_found');

    // 临时配置覆盖：不落盘，仅本次请求生效（与保存的配置叠加）
    const base = gateway.perModel[model];
    const cfg: PerModelConfig = base ? { ...base } : { upstreams: [], exclude: [], pinMode: 'strict', sort: null };
    if (payload.upstreams !== undefined) cfg.upstreams = normalizePerModel({ upstreams: payload.upstreams }).upstreams;
    else if (payload.upstream !== undefined)
      cfg.upstreams = typeof payload.upstream === 'string' && payload.upstream ? [payload.upstream] : [];
    if (payload.exclude !== undefined) cfg.exclude = normalizePerModel({ exclude: payload.exclude }).exclude;

    const result = await runtime.chain.run({
      modelId: model,
      body: { model, messages: [{ role: 'user', content: 'Reply with the word OK' }], max_tokens: 256 },
      cfg,
      meta: gatewayModels(meta(), gateway.id)[model],
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
    // 客户端在请求结束前断开（取消）：不是上游失败，不记历史、不写响应
    if (result.outcome === 'cancelled') return;
    recordHistory(ctx, gateway.id, model, result, { stream: false });

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
    const accountClass = meta().accountClass;
    // 不回传明文 key：只给掩码与指纹（末 4 位），编辑时留空 = 保持不变
    sendJSON(c.res, 200, {
      accounts: cfg.accounts.map((a) => ({
        name: a.name,
        enabled: a.enabled,
        keyMasked: maskSecret(a.key),
        keyTail: a.key.slice(-4),
        hasKey: !!a.key,
        expiresAt: a.expiresAt ?? null,
        /** 到期状态由**服务端**算（时钟以服务端为准；i18n 时前端按 kind 取词）。 */
        expiry: expiryState(a.expiresAt),
        /** 风控体检结论（观测值，可能为空 = 从未体检过）。 */
        classify: accountClass[a.name] ?? null,
      })),
      /** 体检判定模型（全局；账号策略与账号范围是网关级的，在「网关」页编辑）。 */
      classifyModel: cfg.classifyModel,
      stats,
    });
  });

  router.post('/api/accounts', async (c: Ctx) => {
    const body = await readJsonBody(c.req);
    if (!body.ok) return sendError(c.res, 400, body.reason === 'bad-json' ? 'invalid JSON body' : 'body too large');
    const payload = (body.value ?? {}) as { accounts?: unknown; classifyModel?: unknown };
    const { accounts, renames } = mergeAccountsDetailed(config().accounts, payload.accounts);
    if (!accounts.length)
      return sendError(c.res, 400, '至少需要一个有效账号（key 非空）', 'invalid_request_error', 'accounts.required');
    const names = new Set(accounts.map((a) => a.name));
    const classifyModel = typeof payload.classifyModel === 'string' ? payload.classifyModel.trim().slice(0, 120) : '';

    updateConfig(ctx, (cfg) => {
      cfg.accounts = accounts;
      if (classifyModel) cfg.classifyModel = classifyModel;
      const renameMap = new Map(renames.map((r) => [r.from, r.to]));
      for (const gw of cfg.gateways) {
        // 改名：账号范围与 single 模式的选择跟着改
        if (renameMap.size) {
          gw.accounts = gw.accounts.map((n) => renameMap.get(n) ?? n);
          gw.activeAccount = renameMap.get(gw.activeAccount) ?? gw.activeAccount;
        }
        // 删除：把已不存在的名字从范围里摘掉（空范围表示「全部」，这里不补）
        gw.accounts = gw.accounts.filter((n) => names.has(n));
        if (gw.activeAccount && !names.has(gw.activeAccount)) gw.activeAccount = '';
      }
    });
    // 账号名是观测数据的键：改名要迁走、删除要清掉（历史记录是日志，保留历史账号名）
    migrateAccountMeta(ctx, renames, [...names]);

    sendJSON(c.res, 200, {
      ok: true,
      accounts: accounts.length,
      classifyModel: config().classifyModel,
      renamed: renames,
    });
  });

  /**
   * 风控体检：每个账号发**一次**最小请求，看网关默认路由到哪个渠道。
   * 显式传 `names` 时只体检这些（允许体检停用账号）；不传则体检全部启用账号。
   * 串行执行——串行不会打满上游速率限制，也让「1 发/账号」的额度消耗可解释。
   */
  router.post('/api/accounts/classify', async (c: Ctx) => {
    const body = await readJsonBody(c.req);
    if (!body.ok) return sendError(c.res, 400, body.reason === 'bad-json' ? 'invalid JSON body' : 'body too large');
    const payload = (body.value ?? {}) as { names?: unknown };
    const wanted = Array.isArray(payload.names)
      ? new Set(payload.names.filter((n): n is string => typeof n === 'string' && n.length > 0))
      : null;
    const targets = config().accounts.filter((a) => !!a.key && (wanted ? wanted.has(a.name) : a.enabled !== false));
    if (!targets.length) {
      return sendError(
        c.res,
        400,
        wanted ? '没有匹配的账号' : '没有可体检的启用账号',
        'invalid_request_error',
        wanted ? 'accounts.classify.noTargets' : 'accounts.classify.noEnabled',
      );
    }
    if (ctx.classify.isRunning())
      return sendError(c.res, 409, '体检正在进行中，请稍候', 'invalid_request_error', 'accounts.classify.busy');
    const batch = await ctx.classify.classifyMany(targets, c.abortSignal);
    // 客户端中途离开：不再写响应（socket 已断）
    if (batch.cancelled) return;
    sendJSON(c.res, 200, { ok: true, ...batch });
  });

  router.post('/api/accounts/test', async (c: Ctx) => {
    const body = await readJsonBody(c.req);
    if (!body.ok) return sendError(c.res, 400, body.reason === 'bad-json' ? 'invalid JSON body' : 'body too large');
    const payload = (body.value ?? {}) as { key?: unknown; name?: unknown };
    // 两种用法：传 key（新增账号保存前测试）或传 name（测试已存账号——服务端取，前端拿不到明文）
    let key = String(payload.key ?? '').trim();
    if (!key && typeof payload.name === 'string') {
      key = config().accounts.find((a) => a.name === payload.name)?.key ?? '';
    }
    if (!key) return sendError(c.res, 400, 'key required');

    const started = Date.now();
    const gateway = consoleGateway(config());
    const model = gateway.knownModels[0] ?? 'cline-pass/glm-5.3-flash';
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
          ? {
              ok: false,
              ms: Date.now() - started,
              error: `密钥无效或未授权：${message.slice(0, 160)}`,
              notice: { code: 'account.keyInvalid', params: { message: message.slice(0, 160) } },
            }
          : {
              ok: true,
              ms: Date.now() - started,
              model,
              // 用户可见文案不在服务端拼：给稳定的 code + params，前端按语言映射
              notice: { code: 'account.keyOkGatewayNotice', params: { message: message.slice(0, 120) } },
            },
      );
    }
    sendJSON(c.res, 200, { ok: true, ms: Date.now() - started, model });
  });

  // ---- 网关管理（3.0 起「访问与安全」并入网关） ----

  router.get('/api/gateways', (c: Ctx) => {
    sendJSON(c.res, 200, {
      gateways: gatewayViews(ctx),
      consoleGatewayId: config().console.gatewayId,
      maxGateways: MAX_GATEWAYS,
    });
  });

  router.post('/api/gateways/save', async (c: Ctx) => {
    const body = await readJsonBody(c.req);
    if (!body.ok) return sendError(c.res, 400, body.reason === 'bad-json' ? 'invalid JSON body' : 'body too large');
    const raw = ((body.value ?? {}) as { gateway?: unknown }).gateway;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return sendError(c.res, 400, 'gateway required');
    const payload = raw as Record<string, unknown>;

    const cfg = config();
    const id = typeof payload['id'] === 'string' ? payload['id'].trim() : '';
    if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(id))
      return sendError(
        c.res,
        400,
        '网关 id 需为 1-32 位的字母数字与连字符',
        'invalid_request_error',
        'gateway.idInvalid',
      );
    const existing = gatewayById(cfg, id);
    if (!existing && cfg.gateways.length >= MAX_GATEWAYS) {
      return sendError(c.res, 400, `最多只能有 ${MAX_GATEWAYS} 个网关`, 'invalid_request_error', 'gateway.limit', {
        max: MAX_GATEWAYS,
      });
    }

    const merged = mergeGatewayPayload({ ...payload, id }, existing);
    if (!merged.ok) {
      return sendError(c.res, 400, merged.message, 'invalid_request_error', merged.code, merged.params);
    }
    const gateway = merged.gateway;
    if (!existing) gateway.id = id;

    // 与启动闸门同一条规则：非回环地址 + 空密钥 = 任何人可白嫖，运行期保存也不许绕过
    if (!isLoopbackHost(gateway.bindHost) && !gateway.proxyKey && process.env['ALLOW_INSECURE_BIND'] !== '1') {
      return sendError(
        c.res,
        400,
        '绑定非回环地址时必须设置 API Key（或把绑定地址改成 127.0.0.1）',
        'invalid_request_error',
        'gateway.insecureBind',
      );
    }

    // 端口冲突在保存时就拦住：同地址同端口一定绑不上，没必要等到运行时报错
    const clash = cfg.gateways.find((g) => g.id !== id && g.bindHost === gateway.bindHost && g.port === gateway.port);
    if (clash)
      return sendError(
        c.res,
        409,
        `端口 ${gateway.port} 已被网关「${clash.name}」占用`,
        'invalid_request_error',
        'gateway.portConflict',
        { port: gateway.port, name: clash.name },
      );

    // 账号范围只保留存在的账号（空 = 全部）
    const alive = new Set(cfg.accounts.map((a) => a.name));
    gateway.accounts = gateway.accounts.filter((n) => alive.has(n));
    if (gateway.activeAccount && !alive.has(gateway.activeAccount)) gateway.activeAccount = '';

    updateConfig(ctx, (draft) => {
      const index = draft.gateways.findIndex((g) => g.id === id);
      if (index >= 0) draft.gateways[index] = gateway;
      else draft.gateways.push(gateway);
    });

    const deferred = await applyGatewayChange(ctx, c, [id]);
    sendJSON(c.res, 200, { ok: true, deferred, gateways: gatewayViews(ctx) });
  });

  router.post('/api/gateways/delete', async (c: Ctx) => {
    const body = await readJsonBody(c.req);
    if (!body.ok) return sendError(c.res, 400, body.reason === 'bad-json' ? 'invalid JSON body' : 'body too large');
    const id = String(((body.value ?? {}) as { id?: unknown }).id ?? '').trim();
    const cfg = config();
    const target = gatewayById(cfg, id);
    if (!target) return sendError(c.res, 404, '网关不存在', 'not_found', 'gateway.notFound');
    if (cfg.gateways.length <= 1)
      return sendError(c.res, 400, '至少保留一个网关', 'invalid_request_error', 'gateway.lastOne');
    if (cfg.console.gatewayId === id)
      return sendError(
        c.res,
        400,
        '不能删除控制台网关：先把控制台切到别的网关',
        'invalid_request_error',
        'gateway.consoleProtected',
      );

    updateConfig(ctx, (draft) => {
      draft.gateways = draft.gateways.filter((g) => g.id !== id);
    });
    const deferred = await applyGatewayChange(ctx, c, [id]);
    sendJSON(c.res, 200, { ok: true, deferred, gateways: gatewayViews(ctx) });
  });

  router.post('/api/gateways/console', async (c: Ctx) => {
    const body = await readJsonBody(c.req);
    if (!body.ok) return sendError(c.res, 400, body.reason === 'bad-json' ? 'invalid JSON body' : 'body too large');
    const id = String(((body.value ?? {}) as { id?: unknown }).id ?? '').trim();
    const cfg = config();
    if (!gatewayById(cfg, id)) return sendError(c.res, 404, '网关不存在', 'not_found', 'gateway.notFound');
    // 控制台不能切到一个没起来的网关：旧控制台马上就要停，切过去就再也进不来了
    const status = ctx.gateways.statuses().find((s) => s.id === id);
    if (status?.state !== 'running') {
      return sendError(
        c.res,
        409,
        '该网关当前未运行，无法作为控制台网关',
        'invalid_request_error',
        'gateway.notRunning',
      );
    }
    const previous = cfg.console.gatewayId;
    updateConfig(ctx, (draft) => {
      draft.console.gatewayId = id;
    });
    const deferred = await applyGatewayChange(ctx, c, [previous, id]);
    sendJSON(c.res, 200, { ok: true, deferred, gateways: gatewayViews(ctx) });
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
    const gateway = requestGateway(ctx, c);
    if (!gateway) return sendError(c.res, 404, 'unknown gateway', 'not_found');
    sendJSON(c.res, 200, {
      gateway: { id: gateway.id, name: gateway.name },
      perModel: gateway.perModel,
      knownModels: gateway.knownModels,
    });
  });

  router.post('/api/config', async (c: Ctx) => {
    const body = await readJsonBody(c.req);
    if (!body.ok) return sendError(c.res, 400, body.reason === 'bad-json' ? 'invalid JSON body' : 'body too large');
    const gateway = requestGateway(ctx, c);
    if (!gateway) return sendError(c.res, 404, 'unknown gateway', 'not_found');
    const perModel = (body.value as { perModel?: unknown })?.perModel;
    if (perModel && typeof perModel === 'object' && !Array.isArray(perModel)) {
      updateConfig(ctx, (cfg) => {
        const target = cfg.gateways.find((g) => g.id === gateway.id);
        if (!target) return;
        for (const [model, raw] of Object.entries(perModel as Record<string, unknown>)) {
          target.perModel[model] = normalizePerModel(raw);
        }
      });
    }
    sendJSON(c.res, 200, { ok: true });
  });
}

/** 记录请求历史与账号统计（历史条数受 historyLimit 约束）。 */
export function recordHistory(
  ctx: AppContext,
  gatewayId: string,
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
      gateway: gatewayId,
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

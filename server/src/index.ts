import { AccountPool } from './accounts/pool.ts';
import { isConfigured, publicProxyBase } from './config/derive.ts';
import { applyEnvOverrides } from './config/env.ts';
import { loadConfig, writeConfig } from './config/load.ts';
import type { Config } from './config/schema.ts';
import { sendJSON } from './http/respond.ts';
import { type Handler, Router } from './http/router.ts';
import { registerApiRoutes } from './http/routes/api.ts';
import { chatHandler, isChatPath, isModelsPath, modelsHandler } from './http/routes/chat.ts';
import { staticHandler } from './http/routes/static.ts';
import { createHttpServer, shutdownServer } from './http/server.ts';
import { logger } from './log/logger.ts';
import { CONFIG_PATH, DATA_DIR, META_PATH } from './paths.ts';
import { ChatChain } from './proxy/chain.ts';
import { ChannelHealth } from './proxy/health.ts';
import { assertBindSafe, InsecureBindError } from './security/bind.ts';
import { isLoopbackHost } from './security/compare.ts';
import { authMiddleware, corsResponseHeaders, originCheckMiddleware } from './security/middleware.ts';
import { JsonStore } from './store/jsonStore.ts';
import { loadMetaStore } from './store/metaStore.ts';
import { CatalogService } from './upstream/catalog.ts';
import { classifyChannelStatus } from './upstream/errors.ts';
import { mergeLearnedProviders, ProbeService } from './upstream/probe.ts';
import { blankModelMeta, type MetaFile } from './upstream/types.ts';

export const VERSION = '2.0.0-dev';
const startedAt = Date.now();

/**
 * 渠道失败自动学习：
 * - 钉住失败 → 记录该渠道状态（仅确定性失败；瞬时限流标 limited 不拉黑）
 * - 自动+排除模式 → 网关报错附带的最新渠道清单合并进已知列表
 *   （触发场景：本地清单过期，网关侧新增了渠道——白名单漏掉新渠道）
 */
function learnFromFailure(configStore: JsonStore<Config>, metaStore: JsonStore<MetaFile>) {
  return (modelId: string, upstream: string | null, message: string): void => {
    if (upstream) {
      const status = classifyChannelStatus(message);
      if (status === 'unknown') return; // 无把握的不记录，避免误标
      const entry = { status, note: message.slice(0, 160), checkedAt: Date.now() };
      metaStore.update((meta) => {
        const model = meta.models[modelId] ?? blankModelMeta();
        model.upstreamStatus = { ...model.upstreamStatus, [upstream]: entry };
        meta.models[modelId] = model;
      });
      return;
    }

    // 自动模式：把网关报错里附带的最新渠道清单并进已知列表
    const current = metaStore.value.models[modelId];
    const model = current ?? blankModelMeta();
    const merged = mergeLearnedProviders(model, message);
    if (!merged.length) return;
    logger.info({ modelId, learned: merged.length }, '从网关报错学习到新的渠道清单');
    metaStore.update((meta) => {
      meta.models[modelId] = model;
    });
    void configStore; // 保持依赖形状一致（后续可能基于配置决定是否学习）
  };
}

async function main(): Promise<void> {
  const loaded = await loadConfig(CONFIG_PATH);
  for (const note of loaded.notes) logger.warn({ note }, '配置迁移/修正');

  if (loaded.fresh) {
    await writeConfig(CONFIG_PATH, loaded.config);
    logger.info({ file: CONFIG_PATH }, '已生成默认配置文件');
  }

  for (const note of applyEnvOverrides(loaded.config)) logger.info({ note }, '环境变量覆盖');

  assertBindSafe(loaded.config);

  const configStore = new JsonStore<Config>(CONFIG_PATH, loaded.config, {
    onError: (err) => logger.error({ err }, '配置写盘失败'),
  });
  const metaLoaded = await loadMetaStore(META_PATH);
  for (const note of metaLoaded.notes) logger.warn({ note }, '观测数据');
  const metaStore = metaLoaded.store;

  // ---- 服务装配 ----
  const pool = new AccountPool(configStore.value);
  const health = new ChannelHealth();
  const chain = new ChatChain({
    upstreamBase: configStore.value.upstreamBase,
    failover: configStore.value.failover,
    pool,
    health,
  });
  const catalog = new CatalogService({
    upstreamBase: configStore.value.upstreamBase,
    pool,
    meta: metaStore.value,
    markDirty: () => metaStore.markDirty(),
    knownModels: () => configStore.value.knownModels,
    addKnownModels: (ids) => configStore.update((cfg) => cfg.knownModels.push(...ids)),
  });
  const probe = new ProbeService({
    upstreamBase: configStore.value.upstreamBase,
    pool,
    getMeta: (id) => metaStore.value.models[id],
    setMeta: (id, model) =>
      metaStore.update((meta) => {
        meta.models[id] = model;
      }),
    orEndpoints: (slug) => catalog.orEndpoints(slug),
  });
  chain.onChannelFailure(learnFromFailure(configStore, metaStore));

  const ctx = {
    version: VERSION,
    startedAt,
    configStore,
    metaStore,
    pool,
    health,
    chain,
    probe,
    catalog,
  };

  // ---- 路由 ----
  const router = new Router();
  router.get('/healthz', (c) => {
    sendJSON(c.res, 200, {
      ok: true,
      version: VERSION,
      uptime: Math.round((Date.now() - startedAt) / 1000),
      configured: isConfigured(configStore.value),
    });
  });
  registerApiRoutes(ctx, router);

  const handler: Handler = (c) => {
    // OpenAI 兼容端点（多路径兼容，与旧版一致）
    if (isModelsPath(c.path) && c.method === 'GET') return modelsHandler(ctx)(c);
    if (isChatPath(c.path) && c.method === 'POST') return chatHandler(ctx)(c);
    const route = router.resolve(c.method, c.path);
    if (route) return route(c);
    return staticHandler()(c);
  };

  const server = createHttpServer({
    handler,
    middleware: [
      corsResponseHeaders(() => configStore.value.corsOrigins),
      originCheckMiddleware(() => configStore.value.corsOrigins),
      authMiddleware(
        () => configStore.value.proxyKey,
        // 只保护 API 与 OpenAI 兼容端点；静态页面保持开放（见 middleware 注释）
        (path) => isChatPath(path) || isModelsPath(path) || path.startsWith('/api/'),
      ),
    ],
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      logger.fatal({ port: configStore.value.port }, '端口已被占用，无法启动');
    } else {
      logger.fatal({ err }, '服务启动失败');
    }
    process.exit(1);
  });

  const { port, bindHost } = configStore.value;
  await new Promise<void>((resolve) => server.listen(port, bindHost, resolve));

  const config = configStore.value;
  logger.info(
    {
      version: VERSION,
      dataDir: DATA_DIR,
      configFile: CONFIG_PATH,
      accounts: config.accounts.length,
      accountMode: config.accountMode,
      authRequired: !!config.proxyKey,
      models: config.knownModels.length,
    },
    `控制台已启动: http://${isLoopbackHost(bindHost) ? '127.0.0.1' : bindHost}:${port}/`,
  );
  logger.info(`代理地址: ${publicProxyBase(config)}`);
  if (!isConfigured(config)) {
    logger.warn('尚未配置上游 API Key：在控制台「账号管理」添加账号，或设置 CLINE_PASS_KEY 环境变量');
  }

  // ---- 生命周期 ----
  let shuttingDown = false;
  const onSignal = (signal: string): void => {
    if (shuttingDown) {
      logger.warn({ signal }, '再次收到退出信号，立即退出');
      process.exit(1);
    }
    shuttingDown = true;
    logger.info({ signal }, '收到退出信号，开始优雅退出');
    void shutdownServer(server, {
      onClose: async () => {
        configStore.close();
        metaStore.close();
        await Promise.all([configStore.flush(), metaStore.flush()]);
        logger.info('数据已落盘');
      },
    })
      .then(() => {
        logger.info('已优雅退出');
        process.exit(0);
      })
      .catch((err: unknown) => {
        logger.error({ err }, '优雅退出过程中出错');
        process.exit(1);
      });
  };
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));

  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, '未捕获异常');
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, '未处理的 Promise 拒绝');
  });
}

main().catch((err: unknown) => {
  if (err instanceof InsecureBindError) {
    // 安全配置错误是用户可修的，打成人话而不是堆栈
    console.error(`\n[拒绝启动] ${err.message}\n`);
    process.exit(1);
  }
  logger.fatal({ err }, '启动失败');
  process.exit(1);
});

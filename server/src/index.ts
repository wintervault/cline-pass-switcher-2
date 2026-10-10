import { isConfigured, publicProxyBase } from './config/derive.ts';
import { applyEnvOverrides } from './config/env.ts';
import { loadConfig, writeConfig } from './config/load.ts';
import type { Config } from './config/schema.ts';
import { sendError, sendJSON } from './http/respond.ts';
import { type Handler, Router } from './http/router.ts';
import { createHttpServer, shutdownServer } from './http/server.ts';
import { logger } from './log/logger.ts';
import { CONFIG_PATH, DATA_DIR } from './paths.ts';
import { assertBindSafe, InsecureBindError } from './security/bind.ts';
import { isLoopbackHost } from './security/compare.ts';
import { JsonStore } from './store/jsonStore.ts';

export const VERSION = '2.0.0-dev';
const startedAt = Date.now();

function buildRouter(configStore: JsonStore<Config>): Router {
  const router = new Router();

  router.get('/healthz', (ctx) => {
    const config = configStore.value;
    sendJSON(ctx.res, 200, {
      ok: true,
      version: VERSION,
      uptime: Math.round((Date.now() - startedAt) / 1000),
      configured: isConfigured(config),
    });
  });

  router.get('/api/meta', (ctx) => {
    const config = configStore.value;
    sendJSON(ctx.res, 200, {
      version: VERSION,
      authRequired: !!config.proxyKey,
      configured: isConfigured(config),
      proxyBase: publicProxyBase(config),
    });
  });

  return router;
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

  const router = buildRouter(configStore);
  const handler: Handler = (ctx) => {
    const route = router.resolve(ctx.method, ctx.path);
    if (!route) {
      sendError(ctx.res, 404, `no route: ${ctx.method} ${ctx.path}`, 'not_found');
      return;
    }
    return route(ctx);
  };

  const server = createHttpServer({ handler });

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
      routes: router.size,
      accounts: config.accounts.length,
      accountMode: config.accountMode,
      authRequired: !!config.proxyKey,
    },
    `控制台已启动: http://${isLoopbackHost(bindHost) ? '127.0.0.1' : bindHost}:${port}/`,
  );
  if (!isConfigured(config)) {
    logger.warn('尚未配置上游 API Key：在控制台「账号管理」添加账号，或设置 CLINE_PASS_KEY 环境变量');
  }

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
        await configStore.flush();
        logger.info('配置已落盘');
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

import type { AccountPool } from './accounts/pool.ts';
import type { Config } from './config/schema.ts';
import type { ChatChain } from './proxy/chain.ts';
import type { ChannelHealth } from './proxy/health.ts';
import type { JsonStore } from './store/jsonStore.ts';
import type { CatalogService } from './upstream/catalog.ts';
import type { ProbeService } from './upstream/probe.ts';
import type { MetaFile } from './upstream/types.ts';

/** 组装好的服务容器，路由层从这里取依赖。 */
export interface AppContext {
  version: string;
  startedAt: number;
  configStore: JsonStore<Config>;
  metaStore: JsonStore<MetaFile>;
  pool: AccountPool;
  health: ChannelHealth;
  chain: ChatChain;
  probe: ProbeService;
  catalog: CatalogService;
  /** 优雅关停（桌面壳的启停控制走这里；与 SIGTERM 同一条路径）。由 index.ts 装配。 */
  onShutdown?: (reason: string) => void;
}

/** 就地修改配置并安排落盘。 */
export function updateConfig(ctx: AppContext, mutate: (config: Config) => void): void {
  ctx.configStore.update(mutate);
}

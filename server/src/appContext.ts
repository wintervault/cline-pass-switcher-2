import type { ClassifyService } from './accounts/classify.ts';
import type { Config } from './config/schema.ts';
import type { GatewayManager } from './gateways/manager.ts';
import type { JsonStore } from './store/jsonStore.ts';
import type { CatalogService } from './upstream/catalog.ts';
import type { MetaFile } from './upstream/types.ts';

/**
 * 组装好的服务容器，路由层从这里取依赖。
 *
 * 3.0 起账号池 / 渠道冷却 / 故障转移链 / 探针都是**网关级**的，放在
 * `gateways` 里按 id 取；全局的只有账号池数据、观测数据、目录缓存与体检。
 */
export interface AppContext {
  version: string;
  startedAt: number;
  configStore: JsonStore<Config>;
  metaStore: JsonStore<MetaFile>;
  /** 网关运行时与 listener 管理（reconcile 是唯一入口）。 */
  gateways: GatewayManager;
  /** 目录/官方清单缓存（全局共享，模型清单落点是网关级）。 */
  catalog: CatalogService;
  /** 账号风控体检（观测值写 metadata，见 accounts/classify.ts）。 */
  classify: ClassifyService;
  /** 优雅关停（桌面壳的启停控制走这里；与 SIGTERM 同一条路径）。由 index.ts 装配。 */
  onShutdown?: (reason: string) => void;
}

/** 就地修改配置并安排落盘。 */
export function updateConfig(ctx: AppContext, mutate: (config: Config) => void): void {
  ctx.configStore.update(mutate);
}

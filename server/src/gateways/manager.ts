import type http from 'node:http';

import type { AccountPool } from '../accounts/pool.ts';
import type { Config } from '../config/schema.ts';
import { shutdownServer } from '../http/server.ts';
import { logger } from '../log/logger.ts';
import type { ChatChain } from '../proxy/chain.ts';
import type { ChannelHealth } from '../proxy/health.ts';
import type { ProbeService } from '../upstream/probe.ts';

/** 网关运行状态。`error` 必须是可见的：绑定失败不能让用户以为它起来了。 */
export type GatewayState = 'running' | 'error' | 'stopped';

export interface GatewayStatus {
  id: string;
  state: GatewayState;
  /** state=error 时的原因（端口占用、地址不可用等）。 */
  error?: string;
  /** 实际监听端口（监听 0 时由系统分配）；未运行时为 null。 */
  boundPort: number | null;
  boundHost: string | null;
}

/**
 * 一个网关的运行时。
 *
 * `pool` / `health` / `chain` / `probe` 都是**按网关隔离**的：
 * 粘性位置、渠道冷却、探针结论都不能跨网关共享——同一个账号在不同网关里
 * 可能是完全不同的路由结果（风控按账号而不是按端口）。
 */
export interface GatewayRuntime {
  readonly id: string;
  readonly pool: AccountPool;
  readonly health: ChannelHealth;
  readonly chain: ChatChain;
  readonly probe: ProbeService;
  server: http.Server | null;
  /** 上一次成功监听的目标（用于判断配置里的端口/地址是否变了）。 */
  bound: { port: number; bindHost: string } | null;
  status: GatewayStatus;
}

export interface GatewayManagerDeps {
  config: () => Config;
  /** 为网关创建运行时（pool/chain/probe 等）。 */
  createRuntime: (id: string) => GatewayRuntime;
  /** 为网关创建 HTTP 服务（控制台网关额外挂 /api 与静态页）。 */
  createServer: (id: string) => http.Server;
  onStateChange?: (status: GatewayStatus) => void;
}

const bindKey = (port: number, host: string): string => `${host}:${port}`;

/**
 * 多网关监听管理。
 *
 * 三条硬约束（docs/ROADMAP-3.0.md §2）：
 * 1. **一个网关一个 listener**，互不共享端口与鉴权；
 * 2. **失败必须局部化**：某个网关绑不上（端口占用/地址不可用）只把这一个标成
 *    error 并写原因，其它网关照常服务，控制台要能看见是哪一个没起来；
 * 3. **reconcile 是唯一入口**：启动、保存网关设置、删除网关都走它，
 *    避免「运行时状态」与「配置」出现两套真值。
 */
export class GatewayManager {
  readonly #runtimes = new Map<string, GatewayRuntime>();
  readonly #deps: GatewayManagerDeps;
  /** 上一轮生效的控制台网关 id：换了网关就要重挂 handler（/api 只在控制台上）。 */
  #consoleId: string | null = null;
  /** reconcile 串行队列（见 reconcile 的注释）。 */
  #queue: Promise<void> = Promise.resolve();

  constructor(deps: GatewayManagerDeps) {
    this.#deps = deps;
  }

  get(id: string): GatewayRuntime | null {
    return this.#runtimes.get(id) ?? null;
  }

  list(): GatewayRuntime[] {
    return [...this.#runtimes.values()];
  }

  statuses(): GatewayStatus[] {
    return this.list().map((r) => r.status);
  }

  /**
   * 让运行时与配置对齐：补齐缺失的运行时、关闭已删除的网关、按需绑定/重绑。
   * 幂等：没变就什么都不做。
   *
   * **串行执行**：保存/删除网关可能并发触发（连点、两个页面），两个 reconcile 交错
   * 会重复绑定同一个端口或关掉刚起的 listener。排队后每次看到的都是最新配置。
   */
  reconcile(): Promise<void> {
    const run = this.#queue.then(
      () => this.#reconcile(),
      () => this.#reconcile(),
    );
    this.#queue = run.catch(() => {});
    return run;
  }

  async #reconcile(): Promise<void> {
    const config = this.#deps.config();
    const wanted = new Map(config.gateways.map((g) => [g.id, g]));

    // 删除已不存在的网关
    for (const [id, runtime] of [...this.#runtimes]) {
      if (wanted.has(id)) continue;
      await this.#close(runtime, 3_000);
      this.#runtimes.delete(id);
      logger.info({ gateway: id }, '网关已移除');
    }

    // 补齐运行时
    for (const id of wanted.keys()) {
      if (!this.#runtimes.has(id)) this.#runtimes.set(id, this.#deps.createRuntime(id));
    }

    // 控制台网关换了：两端都要重建 listener（/api 与静态页挂在哪不一样）
    const consoleId = config.console.gatewayId;
    const consoleChanged = this.#consoleId !== null && this.#consoleId !== consoleId;
    if (consoleChanged) {
      for (const id of [this.#consoleId, consoleId]) {
        const runtime = id ? this.#runtimes.get(id) : null;
        if (runtime) await this.#close(runtime, 3_000);
      }
      logger.info({ from: this.#consoleId, to: consoleId }, '控制台已切换到另一个网关');
    }
    this.#consoleId = consoleId;

    // 按需绑定 / 重绑
    for (const [id, gateway] of wanted) {
      const runtime = this.#runtimes.get(id);
      if (!runtime) continue;
      const want = { port: gateway.port, bindHost: gateway.bindHost };
      if (
        runtime.server &&
        runtime.bound &&
        bindKey(runtime.bound.port, runtime.bound.bindHost) === bindKey(want.port, want.bindHost)
      ) {
        continue;
      }
      if (runtime.server) await this.#close(runtime, 3_000);
      await this.#bind(runtime, want);
    }
  }

  /** 优雅关停所有网关（在途请求给宽限期），用于进程退出。 */
  async closeAll(graceMs = 30_000): Promise<void> {
    await Promise.all(this.list().map((r) => this.#close(r, graceMs)));
    this.#runtimes.clear();
  }

  async #bind(runtime: GatewayRuntime, want: { port: number; bindHost: string }): Promise<void> {
    let server: http.Server | null = null;
    try {
      // createServer 也可能抛（handler 装配错误）：同样按「这个网关失败」处理，
      // 不能让一个网关的装配问题把整个 reconcile（以及其它网关）带崩
      server = this.#deps.createServer(runtime.id);
      const created = server;
      runtime.server = created;
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error): void => {
          created.off('listening', onListening);
          reject(err);
        };
        const onListening = (): void => {
          created.off('error', onError);
          resolve();
        };
        created.once('error', onError);
        created.once('listening', onListening);
        created.listen(want.port, want.bindHost);
      });
      const address = created.address();
      const boundPort = typeof address === 'object' && address !== null ? address.port : want.port;
      runtime.bound = want;
      runtime.status = { id: runtime.id, state: 'running', boundPort, boundHost: want.bindHost };
      logger.info({ gateway: runtime.id, port: boundPort, host: want.bindHost }, '网关已启动');
    } catch (err) {
      // listen 失败时 handle 已由 Node 收回，但 Server 对象可能仍留着监听器/句柄，
      // 显式关一次，避免反复失败时越积越多
      server?.close(() => {});
      runtime.server = null;
      runtime.bound = null;
      const message = err instanceof Error ? err.message : String(err);
      runtime.status = { id: runtime.id, state: 'error', error: message, boundPort: null, boundHost: null };
      logger.error({ gateway: runtime.id, port: want.port, host: want.bindHost, err }, '网关绑定失败');
    }
    this.#deps.onStateChange?.(runtime.status);
  }

  async #close(runtime: GatewayRuntime, graceMs: number): Promise<void> {
    const server = runtime.server;
    runtime.server = null;
    runtime.bound = null;
    if (server) await shutdownServer(server, { graceMs });
    runtime.status = { id: runtime.id, state: 'stopped', boundPort: null, boundHost: null };
    this.#deps.onStateChange?.(runtime.status);
  }
}

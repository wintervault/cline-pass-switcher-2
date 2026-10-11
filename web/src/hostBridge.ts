import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * 桌面壳桥（由壳的初始化脚本注入 `window.cpsHost`）。
 *
 * **走 HTTP 而不是 Tauri IPC**（v2.9.2 根因修复）：控制台页面是外部 URL
 * （`http://127.0.0.1:3123/`），Tauri 对外部来源不注入 `__TAURI_INTERNALS__`，
 * 新版还会用 ACL 拒绝未声明 remote capability 的自定义命令——IPC 调用只会静默失败，
 * UI 只能把失败当成「已停止」，于是「明明在跑却显示已停止」且按钮点了没反应。
 * 现在壳监听一个回环控制端口，这里只做 fetch，浏览器直开也能用。
 *
 * 浏览器直开（无 cpsHost）时 `host` 为 null，控制簇不渲染。
 */

export interface HostStatus {
  state: 'running' | 'starting' | 'stopping' | 'stopped' | 'error';
  /** 壳的控制端口（诊断用；0 = 控制服务未就绪） */
  port?: number;
  /** state === 'error' 时的原因（例如「未找到 Node.js」） */
  error?: string;
}

export interface HostBridge extends HostWindow {
  hosted: true;
  port: number;
  status: () => Promise<HostStatus>;
  start: () => Promise<HostStatus>;
  stop: () => Promise<HostStatus>;
  restart: () => Promise<HostStatus>;
  log: () => Promise<{ lines: string[] }>;
  openLogs: () => Promise<void>;
}

/**
 * 窗口控制（自绘标题栏用）。壳把它和 HTTP 控制桥一起注入：
 * 系统标题栏在暗色下就是一条与页面无关的灰条，还挤掉一截内容区——
 * 改成页面自绘：拖拽、最小化、最大化、关闭都由壳在原生侧执行。
 */
export interface HostWindow {
  minimize: () => Promise<unknown>;
  toggleMaximize: () => Promise<unknown>;
  close: () => Promise<unknown>;
  isMaximized: () => Promise<boolean>;
  dragMove: () => Promise<unknown>;
}

export const HOST_LABEL: Record<HostStatus['state'], string> = {
  running: '运行中',
  starting: '启动中',
  stopping: '停止中',
  stopped: '已停止',
  error: '启动失败',
};

/**
 * 取壳注入的桥。只认「功能齐全」的桥：旧版壳注入的对象缺少窗口方法时
 * 一律当作没有桥——否则页面会以半残状态渲染（标题栏直接抛错整页白屏）。
 */
export function getHostBridge(): HostBridge | null {
  const bridge = (window as unknown as { cpsHost?: HostBridge }).cpsHost;
  if (!bridge || typeof bridge.status !== 'function' || typeof bridge.isMaximized !== 'function') return null;
  return bridge;
}

/** 恢复轮询间隔：运行中不必盯得那么紧，过渡态要跟得紧。 */
function pollDelay(state: HostStatus['state'] | 'unknown'): number {
  if (state === 'starting' || state === 'stopping') return 500;
  if (state === 'unknown') return 1000;
  return 2000;
}

export interface HostControl {
  /** 桌面壳里为桥对象；浏览器直开为 null */
  host: HostBridge | null;
  status: HostStatus;
  /** 有控制动作在飞（按钮转圈用，避免过渡态里按钮闪回可点状态） */
  busy: boolean;
  /** 最近一次控制动作的失败原因（IPC/HTTP 不通、壳没起来等） */
  error: string | null;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  restart: () => Promise<void>;
  openLogs: () => void;
}

/**
 * 服务状态轮询 + 控制动作。所有动作都带回执：失败一定变成可见的错误文案，
 * 绝不静默——「点了没反应」正是上一版最糟的地方。
 */
export function useHostControl(onChanged?: () => void): HostControl {
  const host = getHostBridge();
  const [status, setStatus] = useState<HostStatus>({ state: 'running' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const changed = useRef(onChanged);
  changed.current = onChanged;

  const poll = useCallback(async (): Promise<HostStatus['state'] | 'unknown'> => {
    if (!host) return 'unknown';
    try {
      const next = await host.status();
      setStatus(next);
      setError(null);
      return next.state;
    } catch (err) {
      setStatus({ state: 'error', error: (err as Error).message });
      setError((err as Error).message);
      return 'error';
    }
  }, [host]);

  useEffect(() => {
    if (!host) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async (): Promise<void> => {
      const state = await poll();
      if (!alive) return;
      timer = setTimeout(() => void tick(), pollDelay(state));
    };
    void tick();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [host, poll]);

  const act = useCallback(
    async (fn: (bridge: HostBridge) => Promise<HostStatus>): Promise<void> => {
      if (!host) return;
      setBusy(true);
      try {
        const next = await fn(host);
        setStatus(next);
        setError(null);
        changed.current?.();
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [host],
  );

  return {
    host,
    status,
    busy,
    error,
    start: useCallback(() => act((b) => b.start()), [act]),
    stop: useCallback(() => act((b) => b.stop()), [act]),
    restart: useCallback(() => act((b) => b.restart()), [act]),
    openLogs: useCallback(() => {
      void host?.openLogs().catch((err: unknown) => setError((err as Error).message));
    }, [host]),
  };
}

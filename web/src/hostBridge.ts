import { useCallback, useEffect, useRef, useState } from 'react';

import { useI18n } from './i18n/index.tsx';

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

type NoticeKind = 'ok' | 'fail' | 'info';

export interface HostControlOptions {
  /** 控制动作落地后调用（如让查询缓存失效） */
  onChanged?: () => void;
  /**
   * 动作结果的回执。启停服务要等好几秒，只在「按下了」这一刻提示不够——
   * 所以真正的成功提示在**状态真的变过去之后**才发（见 awaiting）。
   */
  onNotice?: (text: string, kind: NoticeKind) => void;
}

/**
 * 服务状态轮询 + 控制动作。
 *
 * 回执是两段的：按下时立刻说「正在重启…」，等轮询确认到目标状态再说「已重启」。
 * 上一版什么都不提示，用户按完只能猜——这正是「不知道到底成了没有」的来源。
 */
export function useHostControl(options: HostControlOptions = {}): HostControl {
  const { t } = useI18n();
  const host = getHostBridge();
  const [status, setStatus] = useState<HostStatus>({ state: 'running' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const changed = useRef(options.onChanged);
  changed.current = options.onChanged;
  const notify = useRef(options.onNotice);
  notify.current = options.onNotice;
  /** 正在等待的目标状态（动作返回时还没到位，由轮询确认） */
  const awaiting = useRef<{ target: HostStatus['state']; okText: string } | null>(null);

  const settle = useCallback(
    (next: HostStatus): void => {
      const pending = awaiting.current;
      if (!pending) return;
      if (next.state === pending.target) {
        awaiting.current = null;
        notify.current?.(pending.okText, 'ok');
        changed.current?.();
      } else if (next.state === 'error') {
        awaiting.current = null;
        notify.current?.(next.error ?? t('service.toast.startFailed'), 'fail');
      }
    },
    [t],
  );

  const poll = useCallback(async (): Promise<HostStatus['state'] | 'unknown'> => {
    if (!host) return 'unknown';
    try {
      const next = await host.status();
      setStatus(next);
      setError(null);
      settle(next);
      return next.state;
    } catch (err) {
      setStatus({ state: 'error', error: (err as Error).message });
      setError((err as Error).message);
      return 'error';
    }
  }, [host, settle]);

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
    async (
      fn: (bridge: HostBridge) => Promise<HostStatus>,
      target: HostStatus['state'],
      okText: string,
      pendingText: string,
    ): Promise<void> => {
      if (!host) return;
      setBusy(true);
      notify.current?.(pendingText, 'info');
      try {
        const next = await fn(host);
        setStatus(next);
        setError(null);
        if (next.state === target) {
          notify.current?.(okText, 'ok');
          changed.current?.();
        } else if (next.state === 'error') {
          notify.current?.(next.error ?? t('service.toast.actionFailed'), 'fail');
        } else {
          awaiting.current = { target, okText };
        }
      } catch (err) {
        notify.current?.((err as Error).message, 'fail');
      } finally {
        setBusy(false);
      }
    },
    [host, t],
  );

  return {
    host,
    status,
    busy,
    error,
    start: useCallback(
      () => act((b) => b.start(), 'running', t('service.toast.started'), t('service.toast.starting')),
      [act, t],
    ),
    stop: useCallback(
      () => act((b) => b.stop(), 'stopped', t('service.toast.stopped'), t('service.toast.stopping')),
      [act, t],
    ),
    restart: useCallback(
      () => act((b) => b.restart(), 'running', t('service.toast.restarted'), t('service.toast.restarting')),
      [act, t],
    ),
    openLogs: useCallback(() => {
      void host?.openLogs().catch((err: unknown) => setError((err as Error).message));
    }, [host]),
  };
}

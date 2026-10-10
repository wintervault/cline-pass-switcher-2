import { useEffect, useRef, useState } from 'react';

/**
 * 桌面壳桥（由 Tauri 初始化脚本注入 window.cpsHost）。
 * 浏览器直开时 cpsHost 不存在 → useHostBridge 返回 hosted:false，控制簇不渲染。
 */

export interface HostBridge {
  hosted: true;
  status: () => Promise<string>;
  start: () => Promise<string>;
  stop: () => Promise<string>;
  restart: () => Promise<string>;
  openLogs: () => Promise<void>;
}

export type HostStatus = 'running' | 'starting' | 'stopping' | 'stopped';

export function getHostBridge(): HostBridge | null {
  return (window as unknown as { cpsHost?: HostBridge }).cpsHost ?? null;
}

/**
 * 服务状态轮询。经历过非运行态（启/停/重启）后恢复 running 时整页重载——
 * 服务刚换过一轮，页面里的查询缓存、WebSocket 型状态都要重来。
 */
export function useHostBridge(): { host: HostBridge | null; status: HostStatus } {
  const host = getHostBridge();
  const [status, setStatus] = useState<HostStatus>('running');
  const prev = useRef<string>('running');

  useEffect(() => {
    if (!host) return;
    let alive = true;
    const poll = async (): Promise<void> => {
      try {
        const s = (await host.status()) as HostStatus;
        if (!alive) return;
        setStatus(s);
        if (s === 'running' && prev.current !== 'running') {
          window.location.reload();
          return;
        }
        prev.current = s;
      } catch {
        if (alive) {
          setStatus('stopped');
          prev.current = 'stopped';
        }
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 1500);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [host]);

  return { host, status };
}

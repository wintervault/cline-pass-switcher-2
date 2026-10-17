import { Segmented } from 'antd';
import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from 'react';

import { useMeta } from './api/hooks.ts';

/**
 * 当前查看的网关（订阅模型 / 测试台用）。
 *
 * 为什么放在 context 而不是每个页面各自 useState：
 * 六个页面是**同时挂载**的（切页只切 display），各自持有状态会互相不同步——
 * 在订阅模型页切到「风控号专用」，切到测试台还是旧网关，用户会以为配置丢了。
 *
 * 选择只存本地（localStorage）；服务端不需要知道「你看的是哪个网关」。
 */
const PICKED_KEY = 'cps_gateway';

export interface GatewaySummary {
  id: string;
  name: string;
}

interface GatewayScopeValue {
  /** 当前查看的网关 id（一定存在；网关被删/未加载时回退到控制台网关）。 */
  gatewayId: string;
  gateways: GatewaySummary[];
  consoleGatewayId: string;
  setGatewayId: (id: string) => void;
}

const GatewayScopeContext = createContext<GatewayScopeValue | null>(null);

export function GatewayScopeProvider({ children }: { children: ReactNode }) {
  const meta = useMeta();
  const gateways = useMemo(() => meta.data?.gateways ?? [], [meta.data?.gateways]);
  const consoleGatewayId = meta.data?.consoleGatewayId ?? 'main';
  const [picked, setPicked] = useState<string | null>(() => localStorage.getItem(PICKED_KEY));

  const gatewayId = picked && gateways.some((g) => g.id === picked) ? picked : consoleGatewayId;

  const setGatewayId = useCallback((id: string) => {
    localStorage.setItem(PICKED_KEY, id);
    setPicked(id);
  }, []);

  const value = useMemo(
    () => ({ gatewayId, gateways, consoleGatewayId, setGatewayId }),
    [gatewayId, gateways, consoleGatewayId, setGatewayId],
  );
  return <GatewayScopeContext.Provider value={value}>{children}</GatewayScopeContext.Provider>;
}

export function useGatewayScope(): GatewayScopeValue {
  const value = useContext(GatewayScopeContext);
  if (!value) throw new Error('useGatewayScope 必须在 GatewayScopeProvider 内使用');
  return value;
}

/** 页头的网关切换器：只有一个网关时不占位置。 */
export function GatewaySwitcher() {
  const { gatewayId, gateways, setGatewayId } = useGatewayScope();
  if (gateways.length <= 1) return null;
  return (
    <Segmented
      size="small"
      value={gatewayId}
      onChange={(v) => setGatewayId(String(v))}
      options={gateways.map((g) => ({ value: g.id, label: g.name }))}
    />
  );
}

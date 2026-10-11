import { BorderOutlined, CloseOutlined, MinusOutlined, SwitcherOutlined } from '@ant-design/icons';
import { Tooltip, theme } from 'antd';
import { useEffect, useState } from 'react';

import { getHostBridge } from './hostBridge.ts';
import { Logo } from './logo.tsx';

/**
 * 自绘标题栏（桌面壳里才渲染）。
 *
 * 系统标题栏在暗色下是一条与页面无关的灰条，也挤掉一截内容区。改成页面自绘：
 * 左「应用标识」、中「拖拽区」、右「最小化 / 最大化 / 关闭」。
 * 拖拽与窗口操作都交给壳在原生侧执行（见 hostBridge 注释：外部 URL 下 Tauri
 * 不注入它的脚本，data-tauri-drag-region 这类属性不可用）。
 */
export function TitleBar() {
  const { token } = theme.useToken();
  const bridge = getHostBridge();
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!bridge) return;
    void bridge
      .isMaximized()
      .then(setMaximized)
      .catch(() => {});
  }, [bridge]);

  if (!bridge) return null;

  const btn = (
    key: string,
    title: string,
    icon: React.ReactNode,
    onClick: () => void,
    danger = false,
  ): React.ReactNode => (
    <Tooltip key={key} title={title}>
      <button
        type="button"
        aria-label={title}
        className={danger ? 'cps-wbtn cps-wbtn-close' : 'cps-wbtn'}
        onClick={onClick}
      >
        {icon}
      </button>
    </Tooltip>
  );

  return (
    <div
      role="toolbar"
      aria-label="窗口标题栏：拖动移动窗口，双击切换最大化"
      className="cps-titlebar"
      onMouseDown={(e) => {
        // 只接左键、只接空白处（按钮自己会处理点击）
        if (e.button !== 0) return;
        if ((e.target as HTMLElement).closest('button')) return;
        void bridge.dragMove().catch(() => {});
      }}
      onDoubleClick={(e) => {
        if ((e.target as HTMLElement).closest('button')) return;
        void bridge
          .toggleMaximize()
          .then(() => bridge.isMaximized().then(setMaximized))
          .catch(() => {});
      }}
    >
      <div className="cps-titlebar-brand">
        <Logo size={18} />
        <span>Cline Pass</span>
      </div>
      <div className="cps-titlebar-gap" />
      <div className="cps-titlebar-actions" style={{ color: token.colorTextSecondary }}>
        {btn('min', '最小化', <MinusOutlined />, () => void bridge.minimize().catch(() => {}))}
        {btn(
          'max',
          maximized ? '向下还原' : '最大化',
          maximized ? <SwitcherOutlined /> : <BorderOutlined />,
          () =>
            void bridge
              .toggleMaximize()
              .then(() => bridge.isMaximized().then(setMaximized))
              .catch(() => {}),
        )}
        {btn('close', '关闭到托盘', <CloseOutlined />, () => void bridge.close().catch(() => {}), true)}
      </div>
    </div>
  );
}

/** 标题栏高度：布局顶部留白的唯一来源。 */
export const TITLEBAR_HEIGHT = 36;

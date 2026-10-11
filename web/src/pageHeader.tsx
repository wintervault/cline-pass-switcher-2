import { Typography } from 'antd';
import type { ReactNode } from 'react';

import { GAP_PAGE } from './layout.ts';

/**
 * 每页统一的页头：标题 + 一句话说明 + 右侧主操作。
 *
 * 三条页面（订阅模型 / 账号池 / 测试台…）此前各写各的页头，标题字号、说明
 * 颜色、操作位置全不一样，扫一眼就觉得是拼出来的。现在只有这一个来源。
 * 标题用 20px/600（theme 的 fontSizeHeading3），说明文字固定 13px 同级灰色。
 */
export function PageHeader({ title, desc, actions }: { title: ReactNode; desc?: ReactNode; actions?: ReactNode }) {
  return (
    <header
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 16,
        marginBottom: GAP_PAGE,
        flexWrap: 'wrap',
      }}
    >
      <div style={{ minWidth: 0, flex: '1 1 auto' }}>
        <Typography.Title level={3} style={{ margin: 0, fontSize: 20, lineHeight: '28px' }}>
          {title}
        </Typography.Title>
        {desc && (
          <Typography.Text
            type="secondary"
            style={{ fontSize: 13, lineHeight: '20px', display: 'block', marginTop: 6 }}
          >
            {desc}
          </Typography.Text>
        )}
      </div>
      {actions && (
        <div
          style={{
            display: 'flex',
            gap: 8,
            alignItems: 'center',
            flexWrap: 'wrap',
            justifyContent: 'flex-end',
            paddingTop: 2,
          }}
        >
          {actions}
        </div>
      )}
    </header>
  );
}

/**
 * 区块标题。之前每个页面用不同的字号/间距/分隔线做「小节」，
 * 现在统一成：小标题 + 可选右侧操作，上方留白由调用方用 GAP_SECTION 控制。
 */
export function SectionTitle({ title, extra }: { title: ReactNode; extra?: ReactNode }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        marginBottom: 12,
        minHeight: 28,
      }}
    >
      <Typography.Text strong style={{ fontSize: 14 }}>
        {title}
      </Typography.Text>
      {extra && <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>{extra}</div>}
    </div>
  );
}

import { Typography } from 'antd';
import type { ReactNode } from 'react';

/**
 * 每页统一的页头：标题 + 一句话说明 + 右侧主操作。
 *
 * **页头自己不设外边距** —— 页头与首个区块之间、以及区块彼此之间的间距，
 * 全部由页面根容器的 `gap` 决定（六页一律 `flex column + gap 16`）。
 * 如果这里再写 marginBottom，就会与父级的 gap 叠加，页头到内容的距离
 * 变成 40 而区块之间是 16，同一个页面里出现两套节奏。
 */
export function PageHeader({ title, desc, actions }: { title: ReactNode; desc?: ReactNode; actions?: ReactNode }) {
  return (
    <header
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 16,
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

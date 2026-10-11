import { Typography } from 'antd';
import type { CSSProperties, ReactNode } from 'react';

/**
 * 区块容器 —— 全站唯一的「区域」原语。
 *
 * 2.9.2 那版把卡片全拆了、只靠标题和空白分隔，结果**区块边界消失**：一眼看过去
 * 是散落的零件，而不是几个清楚的区域（真实反馈：「区域划分不明显、零件散乱、
 * 结构化不好」）。所以这里把「一面 + 一条分隔线 + 一个标题栏」定成标准件：
 *
 * - 面：比页面底色高一层（colorBgContainer）+ 1px 描边 + 圆角 → 边界一眼可见
 * - 头：14px 半粗标题 + 右侧操作，底部一条分隔线 → 区域有自己的名字
 * - 体：统一 16px 内边距；表格类用 flush 去掉内边距
 *
 * 所有页面都用它，不再各自拼 div —— 这是「设计统一」的落点。
 */
export function Panel({
  title,
  extra,
  children,
  /** 表格/列表类内容贴边铺满（去掉体内边距） */
  flush = false,
  /** 内容区自己滚动时用，配合 style 里的高度约束 */
  bodyScroll = false,
  style,
  bodyStyle,
  className,
}: {
  title?: ReactNode;
  extra?: ReactNode;
  children: ReactNode;
  flush?: boolean;
  bodyScroll?: boolean;
  style?: CSSProperties;
  bodyStyle?: CSSProperties;
  className?: string;
}) {
  return (
    <section className={className ? `cps-panel ${className}` : 'cps-panel'} style={style}>
      {(title !== undefined || extra !== undefined) && (
        <header className="cps-panel-head">
          {title !== undefined && <div className="cps-panel-title">{title}</div>}
          {extra !== undefined && <div className="cps-panel-extra">{extra}</div>}
        </header>
      )}
      <div
        className={['cps-panel-body', flush ? 'cps-panel-body-flush' : '', bodyScroll ? 'cps-panel-body-scroll' : '']
          .filter(Boolean)
          .join(' ')}
        style={bodyStyle}
      >
        {children}
      </div>
    </section>
  );
}

/** 区块头里的次要说明（跟在标题后面的小字）。 */
export function PanelHint({ children }: { children: ReactNode }) {
  return (
    <Typography.Text type="secondary" style={{ fontSize: 12, fontWeight: 400 }}>
      {children}
    </Typography.Text>
  );
}

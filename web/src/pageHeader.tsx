import { Typography } from 'antd';
import type { ReactNode } from 'react';

/**
 * 每页统一的页头：标题 + 一句话说明 + 右侧主操作。
 * 首屏第一落点：标题一眼可读、说明可跳读、主操作不挪出视线。
 */
export function PageHeader({ title, desc, actions }: { title: ReactNode; desc?: ReactNode; actions?: ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, marginBottom: 20 }}>
      <div style={{ minWidth: 0 }}>
        <Typography.Title level={3} style={{ margin: 0 }}>
          {title}
        </Typography.Title>
        {desc && (
          <Typography.Text type="secondary" style={{ fontSize: 13, display: 'block', marginTop: 4 }}>
            {desc}
          </Typography.Text>
        )}
      </div>
      {actions && (
        <div
          style={{
            marginLeft: 'auto',
            paddingTop: 3,
            display: 'flex',
            gap: 8,
            alignItems: 'center',
            flexWrap: 'wrap',
            justifyContent: 'flex-end',
          }}
        >
          {actions}
        </div>
      )}
    </div>
  );
}

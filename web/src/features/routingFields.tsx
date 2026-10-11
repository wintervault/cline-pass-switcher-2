import { Select, Space, Typography } from 'antd';

import type { PerModelConfig, SortKey } from '../api/types.ts';

/**
 * 路由策略的两个控件（钉住模式 / 渠道排序）。
 *
 * 「订阅模型」和「测试台」编辑的是**同一份配置**，两边各写一遍必然漂移
 * （之前一处带标签、一处是光头下拉，同一个设置两种样子）。抽成一处，
 * 只保留调用点决定的「改动后回执文案」。
 */
export function RoutingFields({
  cfg,
  onChange,
}: {
  cfg: PerModelConfig;
  onChange: (patch: Partial<PerModelConfig>, note: string) => void;
}) {
  const selectWidth = 180;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: '16px 40px' }}>
      <div>
        <Space size={12} align="center">
          <Typography.Text type="secondary" style={{ fontSize: 13 }}>
            钉住模式
          </Typography.Text>
          <Select
            style={{ width: selectWidth }}
            value={cfg.pinMode}
            onChange={(v) =>
              onChange({ pinMode: v }, `钉住模式已改为「${v === 'strict' ? '严格钉住' : '优先 + 回退'}」`)
            }
            options={[
              { value: 'strict', label: '严格钉住' },
              { value: 'preferred', label: '优先 + 回退' },
            ]}
          />
        </Space>
        <Typography.Text type="secondary" style={{ fontSize: 12, lineHeight: '18px', display: 'block', marginTop: 6 }}>
          严格钉住：只走清单内渠道，网关不听话视为失败并切换；优先 + 回退：仅最后一个候选放开网关选择
        </Typography.Text>
      </div>
      <div>
        <Space size={12} align="center">
          <Typography.Text type="secondary" style={{ fontSize: 13 }}>
            渠道排序
          </Typography.Text>
          <Select
            style={{ width: selectWidth }}
            value={cfg.sort ?? ''}
            onChange={(v: string) => {
              const label: Record<string, string> = {
                '': '网关智能选',
                cost: '最低成本',
                ttft: '最快首字',
                tps: '最高吞吐',
              };
              onChange({ sort: (v || null) as SortKey | null }, `渠道排序偏好已改为「${label[v] ?? v}」`);
            }}
            options={[
              { value: '', label: '网关智能选' },
              { value: 'cost', label: '最低成本' },
              { value: 'ttft', label: '最快首字' },
              { value: 'tps', label: '最高吞吐' },
            ]}
          />
        </Space>
        <Typography.Text type="secondary" style={{ fontSize: 12, lineHeight: '18px', display: 'block', marginTop: 6 }}>
          多个可用渠道之间的执行顺序偏好
        </Typography.Text>
      </div>
    </div>
  );
}

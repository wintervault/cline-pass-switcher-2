import { Select, Space, Typography } from 'antd';

import type { PerModelConfig, SortKey } from '../api/types.ts';
import { useT } from '../i18n/index.tsx';

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
  const t = useT();
  const selectWidth = 180;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: '16px 40px' }}>
      <div>
        <Space size={12} align="center">
          <Typography.Text type="secondary" style={{ fontSize: 13 }}>
            {t('routing.pinMode')}
          </Typography.Text>
          <Select
            style={{ width: selectWidth }}
            value={cfg.pinMode}
            onChange={(v) =>
              onChange(
                { pinMode: v },
                t('routing.note.pinMode', {
                  name: v === 'strict' ? t('routing.pinMode.strict') : t('routing.pinMode.preferred'),
                }),
              )
            }
            options={[
              { value: 'strict', label: t('routing.pinMode.strict') },
              { value: 'preferred', label: t('routing.pinMode.preferred') },
            ]}
          />
        </Space>
        <Typography.Text type="secondary" style={{ fontSize: 12, lineHeight: '18px', display: 'block', marginTop: 6 }}>
          {t('routing.pinMode.hint')}
        </Typography.Text>
      </div>
      <div>
        <Space size={12} align="center">
          <Typography.Text type="secondary" style={{ fontSize: 13 }}>
            {t('routing.sort')}
          </Typography.Text>
          <Select
            style={{ width: selectWidth }}
            value={cfg.sort ?? ''}
            onChange={(v: string) => {
              const label: Record<string, string> = {
                '': t('routing.sort.auto'),
                cost: t('routing.sort.cost'),
                ttft: t('routing.sort.ttft'),
                tps: t('routing.sort.tps'),
              };
              onChange({ sort: (v || null) as SortKey | null }, t('routing.note.sort', { name: label[v] ?? v }));
            }}
            options={[
              { value: '', label: t('routing.sort.auto') },
              { value: 'cost', label: t('routing.sort.cost') },
              { value: 'ttft', label: t('routing.sort.ttft') },
              { value: 'tps', label: t('routing.sort.tps') },
            ]}
          />
        </Space>
        <Typography.Text type="secondary" style={{ fontSize: 12, lineHeight: '18px', display: 'block', marginTop: 6 }}>
          {t('routing.sort.hint')}
        </Typography.Text>
      </div>
    </div>
  );
}

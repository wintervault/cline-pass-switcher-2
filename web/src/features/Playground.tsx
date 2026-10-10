import { SendOutlined } from '@ant-design/icons';
import { Alert, App, Badge, Button, Card, Descriptions, Empty, Select, Space, Tag, Typography, theme } from 'antd';
import { useMemo, useState } from 'react';

import { useModels, useTest } from '../api/hooks.ts';
import type { TestResult, TraceEntry } from '../api/types.ts';
import { PageHeader } from '../pageHeader.tsx';
import { sortedUpstreams } from './Models.tsx';

const dotStatus = (status: number): 'success' | 'warning' | 'error' | 'default' =>
  status === 200 ? 'success' : status === 429 ? 'warning' : status >= 500 || status === 402 ? 'error' : 'default';

/** 每次尝试一行：状态点 / 渠道 / HTTP / 耗时 / 备注。 */
function TraceView({ trace }: { trace?: TraceEntry[] }) {
  if (!trace?.length) return null;
  return (
    <div>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        尝试序列
      </Typography.Text>
      <div style={{ marginTop: 6, display: 'grid', gap: 6 }}>
        {trace.map((t) => (
          <Space key={`${t.upstream ?? 'auto'}|${t.status}|${t.ms}`} size={8} style={{ fontSize: 12 }}>
            <Badge status={dotStatus(t.status)} />
            <span style={{ fontFamily: 'monospace' }}>{t.upstream ?? '自动'}</span>
            <Typography.Text type="secondary">HTTP {t.status}</Typography.Text>
            <Typography.Text type="secondary" style={{ fontVariantNumeric: 'tabular-nums' }}>
              {t.ms}ms
            </Typography.Text>
            {t.note && t.note !== 'ok' && <Typography.Text type="danger">{t.note}</Typography.Text>}
          </Space>
        ))}
      </div>
    </div>
  );
}

const PIPELINE_LABEL: Record<string, string> = { direct: '直连 · OpenRouter', planner: '规划器 · Vercel' };

export default function Playground() {
  const { message } = App.useApp();
  const { token } = theme.useToken();
  const models = useModels();
  const test = useTest();
  const [model, setModel] = useState<string>('');
  const [upstream, setUpstream] = useState<string>('');
  const [result, setResult] = useState<TestResult | null>(null);

  const rows = models.data?.subscription ?? [];
  const upstreamOptions = useMemo(() => {
    const meta = rows.find((r) => r.id === model)?.meta ?? null;
    return [
      { value: '', label: '自动（走当前路由策略）' },
      ...sortedUpstreams(meta).map((u) => {
        const st = meta?.upstreamStatus[u]?.status;
        return { value: u, label: st && st !== 'unknown' ? `${u}（${st}）` : u };
      }),
    ];
  }, [rows, model]);

  const run = (): void => {
    if (!model) {
      message.warning('请选择模型');
      return;
    }
    test.mutate(
      { model, upstreams: upstream ? [upstream] : [], exclude: [] },
      {
        onSuccess: (r) => setResult(r),
        onError: (e) => message.error(String(e)),
      },
    );
  };

  const hit = result?.ok && (!result.targets.length || result.actual === result.targets[0]);

  return (
    <div>
      <PageHeader
        title="测试台"
        desc="任选模型与渠道发最小请求（max_tokens=256），看网关实际路由与每次尝试的先后与耗时。"
      />

      <Space wrap size={12}>
        <Select
          showSearch
          style={{ width: 300 }}
          placeholder="选择模型"
          value={model || undefined}
          onChange={setModel}
          options={rows.map((r) => ({ value: r.id, label: r.id }))}
        />
        <Select style={{ width: 260 }} value={upstream} onChange={setUpstream} options={upstreamOptions} />
        <Button type="primary" icon={<SendOutlined />} loading={test.isPending} onClick={run}>
          发送测试
        </Button>
      </Space>

      {!result && (
        <Empty style={{ marginTop: 64 }} description="选择模型后发送测试；不指定渠道 = 按当前路由策略自动选择" />
      )}

      {result && (
        <Card
          size="small"
          style={{ marginTop: 16, maxWidth: 920 }}
          title={
            <Space size={8}>
              {result.ok ? <Tag color="green">成功</Tag> : <Tag color="red">失败</Tag>}
              <Typography.Text code>{model}</Typography.Text>
              {result.ok && <Tag color={hit ? 'green' : 'orange'}>{hit ? '命中目标' : '未命中首个目标'}</Tag>}
            </Space>
          }
        >
          {!result.ok ? (
            <Alert type="error" showIcon message={`请求失败：${result.error ?? '未知错误'}`} />
          ) : (
            <div style={{ display: 'grid', gap: 14 }}>
              <Descriptions
                size="small"
                column={3}
                items={[
                  {
                    key: 'actual',
                    label: '实际上游',
                    children: <Tag color={hit ? 'green' : 'orange'}>{result.actual ?? '未知'}</Tag>,
                  },
                  { key: 'ms', label: '耗时', children: `${result.ms ?? 0} ms` },
                  {
                    key: 'pipeline',
                    label: '管道',
                    children: result.pipeline ? (PIPELINE_LABEL[result.pipeline] ?? result.pipeline) : '未知',
                  },
                  {
                    key: 'canonical',
                    label: '背后模型',
                    children: result.canonicalSlug ? (
                      <Typography.Text code>{result.canonicalSlug}</Typography.Text>
                    ) : (
                      '—'
                    ),
                  },
                  { key: 'account', label: '账号', children: result.account ?? '—' },
                  {
                    key: 'targets',
                    label: '目标渠道',
                    children: result.targets.length ? result.targets.join(' → ') : '自动',
                  },
                ]}
              />

              {result.degraded && (
                <Alert
                  type="warning"
                  showIcon
                  message="排除列表未生效：本地没有该模型的渠道清单（先「探测」），或已知渠道全被排除"
                />
              )}
              {!hit && (
                <Alert
                  type="warning"
                  showIcon
                  message="未命中首个目标上游：渠道可能限流或不可钉（去「订阅模型」点「校验」检查全部渠道）"
                />
              )}

              {result.content && (
                <div>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    模型回复
                  </Typography.Text>
                  <Typography.Paragraph
                    style={{
                      marginTop: 6,
                      marginBottom: 0,
                      padding: '10px 12px',
                      background: token.colorFillQuaternary,
                      borderRadius: token.borderRadius,
                      fontFamily: 'monospace',
                      fontSize: 12,
                      whiteSpace: 'pre-wrap',
                    }}
                  >
                    {result.content}
                  </Typography.Paragraph>
                </div>
              )}

              <TraceView trace={result.trace} />
            </div>
          )}
        </Card>
      )}
    </div>
  );
}

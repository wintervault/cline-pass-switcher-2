import { Alert, App, Button, Select, Space, Table, Tag, Typography } from 'antd';
import { useMemo, useState } from 'react';

import { useModels, useTest } from '../api/hooks.ts';
import type { TestResult, TraceEntry } from '../api/types.ts';
import { sortedUpstreams } from './Models.tsx';

function TraceView({ trace }: { trace?: TraceEntry[] }) {
  if (!trace?.length) return null;
  return (
    <div style={{ marginTop: 8 }}>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        尝试序列：
      </Typography.Text>
      {trace.map((t, i) => (
        <Tag key={i} color={t.status === 200 ? 'green' : 'orange'} style={{ fontFamily: 'monospace' }}>
          {t.upstream ?? 'auto'}({t.status === 200 ? '✔' : `✗${t.status}`} {t.ms}ms
          {t.note && t.status !== 200 && t.note !== 'ok' ? ` · ${t.note.slice(0, 40)}` : ''})
        </Tag>
      ))}
    </div>
  );
}

export default function Playground() {
  const { message } = App.useApp();
  const models = useModels();
  const test = useTest();
  const [model, setModel] = useState<string>('');
  const [upstream, setUpstream] = useState<string>('');
  const [result, setResult] = useState<TestResult | null>(null);

  const rows = models.data?.subscription ?? [];
  const upstreamOptions = useMemo(() => {
    const meta = rows.find((r) => r.id === model)?.meta ?? null;
    return [
      { value: '', label: '自动（不指定上游）' },
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
      <Space wrap style={{ marginBottom: 12 }}>
        <Select
          showSearch
          style={{ width: 280 }}
          placeholder="选择模型"
          value={model || undefined}
          onChange={setModel}
          options={rows.map((r) => ({ value: r.id, label: r.id }))}
        />
        <Select style={{ width: 240 }} value={upstream} onChange={setUpstream} options={upstreamOptions} />
        <Button type="primary" loading={test.isPending} onClick={run}>
          发送测试
        </Button>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          max_tokens=256 的小请求，消耗极小
        </Typography.Text>
      </Space>

      {result && !result.ok && <Alert type="error" showIcon message={`请求失败：${result.error ?? '未知错误'}`} />}
      {result?.degraded && (
        <Alert
          type="warning"
          showIcon
          style={{ marginTop: 8 }}
          message="排除列表未生效：本地没有该模型的渠道清单（先「探测」），或已知渠道全被排除"
        />
      )}
      {result?.ok && (
        <div style={{ marginTop: 12 }}>
          <Space size={16} wrap>
            <Typography.Text>
              实际上游：
              <Tag color={hit ? 'green' : 'orange'}>{result.actual ?? '未知'}</Tag>
            </Typography.Text>
            <Typography.Text type="secondary">耗时 {result.ms} ms</Typography.Text>
            <Typography.Text type="secondary">
              管道：
              {result.pipeline === 'direct'
                ? '直连(OpenRouter)'
                : result.pipeline === 'planner'
                  ? '规划器(Vercel)'
                  : '未知'}
            </Typography.Text>
            <Typography.Text type="secondary">背后模型：{result.canonicalSlug ?? '—'}</Typography.Text>
          </Space>
          {result.content ? (
            <Typography.Paragraph type="secondary" style={{ marginTop: 8, fontSize: 12 }}>
              回复：{result.content}
            </Typography.Paragraph>
          ) : null}
        </div>
      )}
      <TraceView trace={result?.trace} />
      {result?.ok && !hit && (
        <Alert
          type="warning"
          showIcon
          style={{ marginTop: 8 }}
          message="未命中首个目标上游：渠道可能限流或不可钉（点「校验」检查全部渠道）"
        />
      )}
    </div>
  );
}

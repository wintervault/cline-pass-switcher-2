import { CopyOutlined } from '@ant-design/icons';
import {
  Alert,
  App,
  Badge,
  Button,
  Empty,
  Segmented,
  Skeleton,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
  theme,
} from 'antd';
import { useState } from 'react';

import { useHistory } from '../api/hooks.ts';
import type { HistoryEntry, TraceEntry } from '../api/types.ts';
import { PageHeader } from '../pageHeader.tsx';

/** 相对时间：一眼知道「多久之前」，悬停看完整时间。 */
function relTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

/** 尝试状态 → 圆点语义。 */
const dotStatus = (status: number): 'success' | 'warning' | 'error' | 'default' =>
  status === 200 ? 'success' : status === 429 ? 'warning' : status >= 500 || status === 402 ? 'error' : 'default';

/** 尝试链可视化：渠道名 + 状态点 + 耗时，悬停看完整信息。 */
function TraceChain({ trace, attempts }: { trace?: TraceEntry[]; attempts: string[] }) {
  const { token } = theme.useToken();
  const list = trace?.length
    ? trace
    : (attempts ?? []).map((u) => ({ upstream: u === 'auto' ? null : u, status: 200, ms: 0, note: '' }));
  if (!list.length) return <Typography.Text type="secondary">—</Typography.Text>;
  return (
    <Space size={10} wrap>
      {list.map((t, i) => (
        <Tooltip
          key={`${t.upstream ?? 'auto'}|${t.status}|${t.ms}`}
          title={`${t.upstream ?? '自动'} · HTTP ${t.status} · ${t.ms}ms${t.note && t.note !== 'ok' ? ` · ${t.note}` : ''}`}
        >
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
            {i > 0 && <span style={{ color: token.colorTextQuaternary }}>›</span>}
            <Badge status={dotStatus(t.status)} />
            <span style={{ fontFamily: 'monospace' }}>{t.upstream ?? 'auto'}</span>
            <span style={{ color: token.colorTextTertiary }}>{t.ms}ms</span>
          </span>
        </Tooltip>
      ))}
    </Space>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <Space size={8} align="baseline">
      <Typography.Text style={{ fontSize: 18, fontWeight: 600, color: tone }}>{value}</Typography.Text>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {label}
      </Typography.Text>
    </Space>
  );
}

export default function History() {
  const { message } = App.useApp();
  const { token } = theme.useToken();
  const history = useHistory();
  const rows = history.data?.history ?? [];
  /** 排查场景的快捷筛选：全部 / 成功 / 失败。 */
  const [view, setView] = useState<'all' | 'ok' | 'fail'>('all');

  const okRows = rows.filter((r) => !r.error);
  const failed = rows.length - okRows.length;
  const msList = okRows.map((r) => r.ms).filter((m): m is number => typeof m === 'number');
  const avgMs = msList.length ? Math.round(msList.reduce((a, b) => a + b, 0) / msList.length) : 0;
  const streamPct = rows.length ? Math.round((rows.filter((r) => r.stream).length / rows.length) * 100) : 0;
  const visible = view === 'all' ? rows : view === 'ok' ? okRows : rows.filter((r) => r.error);

  return (
    <div>
      <PageHeader title="请求历史" desc="每次请求的实际渠道、耗时与尝试序列；失败行整行标红，便于排查。" />
      {history.isError ? (
        <Alert
          type="error"
          showIcon
          message="请求历史加载失败"
          description="服务可能正在重启；稍候重试，或用状态栏的刷新按钮。"
          action={
            <Button size="small" onClick={() => void history.refetch()}>
              重试
            </Button>
          }
        />
      ) : history.isLoading && !history.data ? (
        <Skeleton active paragraph={{ rows: 8 }} />
      ) : (
        <>
          {rows.length > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 32, marginBottom: 16, flexWrap: 'wrap' }}>
              <Space size={32} wrap>
                <Stat label="成功" value={String(okRows.length)} tone={token.colorSuccess} />
                <Stat label="失败" value={String(failed)} tone={failed ? token.colorError : undefined} />
                <Stat label="平均耗时" value={`${avgMs}ms`} />
                <Stat label="流式占比" value={`${streamPct}%`} />
              </Space>
              <Segmented
                style={{ marginLeft: 'auto' }}
                value={view}
                onChange={(v) => setView(v as typeof view)}
                options={[
                  { value: 'all', label: '全部' },
                  { value: 'ok', label: '成功' },
                  { value: 'fail', label: '失败' },
                ]}
              />
            </div>
          )}
          <Table<HistoryEntry>
            rowKey={(r) => `${r.ts}-${r.model}-${r.attempts.join('|')}`}
            size="small"
            sticky
            loading={history.isLoading}
            dataSource={visible}
            locale={{
              emptyText: (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无请求记录：agent 发出请求后会出现在这里" />
              ),
            }}
            pagination={{ pageSize: 20, hideOnSinglePage: true }}
            onRow={(r) => ({ style: r.error ? { background: token.colorErrorBg } : undefined })}
            columns={[
              {
                title: '时间',
                width: 100,
                render: (_, r) => (
                  <Tooltip title={new Date(r.ts).toLocaleString()}>
                    <Typography.Text type="secondary">{relTime(r.ts)}</Typography.Text>
                  </Tooltip>
                ),
              },
              {
                title: '模型',
                dataIndex: 'model',
                width: 240,
                render: (v: string) => <Typography.Text code>{v}</Typography.Text>,
              },
              { title: '账号', width: 84, render: (_, r) => (r.account ? <Tag color="blue">{r.account}</Tag> : '—') },
              {
                title: '实际渠道',
                width: 140,
                render: (_, r) => (
                  <Space size={4} wrap>
                    {r.provider ? <Tag color="geekblue">{r.provider}</Tag> : '—'}
                    {r.pinMismatch && (
                      <Tooltip title="strict 钉住未生效：网关实际由别的渠道提供服务（流式只能标记，不能撤回）">
                        <Tag color="red">钉住未生效</Tag>
                      </Tooltip>
                    )}
                  </Space>
                ),
              },
              {
                title: '耗时',
                width: 88,
                align: 'right',
                render: (_, r) =>
                  r.ms != null ? (
                    <Typography.Text style={{ fontVariantNumeric: 'tabular-nums' }}>{r.ms} ms</Typography.Text>
                  ) : (
                    '—'
                  ),
              },
              { title: '方式', width: 66, render: (_, r) => (r.stream ? '流式' : '非流式') },
              {
                title: '尝试序列',
                render: (_, r) =>
                  r.error ? (
                    <Typography.Text type="danger" style={{ fontSize: 12 }}>
                      {r.error.slice(0, 90)}
                    </Typography.Text>
                  ) : (
                    <TraceChain trace={r.trace} attempts={r.attempts} />
                  ),
              },
              {
                title: '',
                width: 44,
                render: (_, r) => (
                  <Tooltip title="复制这条请求的完整信息（排查时贴给别人看）">
                    <Button
                      size="small"
                      type="text"
                      icon={<CopyOutlined />}
                      aria-label="复制请求详情"
                      onClick={() => {
                        void navigator.clipboard.writeText(JSON.stringify(r, null, 2)).then(
                          () => message.success('已复制到剪贴板'),
                          () => message.error('复制失败（剪贴板不可用）'),
                        );
                      }}
                    />
                  </Tooltip>
                ),
              },
            ]}
          />
        </>
      )}
    </div>
  );
}

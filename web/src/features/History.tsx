import { Table, Tag, Typography } from 'antd';

import { useHistory } from '../api/hooks.ts';
import type { HistoryEntry } from '../api/types.ts';

const time = (ts: number): string => new Date(ts).toLocaleTimeString();

export default function History() {
  const history = useHistory();
  const rows = history.data?.history ?? [];

  return (
    <Table<HistoryEntry>
      rowKey={(r) => `${r.ts}-${r.model}-${r.attempts.join('|')}`}
      size="small"
      loading={history.isLoading}
      dataSource={rows}
      pagination={{ pageSize: 20, hideOnSinglePage: true }}
      columns={[
        {
          title: '时间',
          width: 90,
          render: (_, r) => <Typography.Text type="secondary">{time(r.ts)}</Typography.Text>,
        },
        {
          title: '模型',
          dataIndex: 'model',
          width: 200,
          render: (v: string) => <Typography.Text code>{v}</Typography.Text>,
        },
        { title: '账号', width: 90, render: (_, r) => (r.account ? <Tag color="blue">{r.account}</Tag> : '—') },
        {
          title: '实际上游',
          width: 110,
          render: (_, r) => (r.provider ? <Tag color="purple">{r.provider}</Tag> : '—'),
        },
        {
          title: '背后模型',
          width: 180,
          render: (_, r) => (
            <Typography.Text type="secondary" code style={{ fontSize: 11 }}>
              {r.canonical ?? '—'}
            </Typography.Text>
          ),
        },
        { title: '耗时', width: 90, render: (_, r) => (r.ms != null ? `${r.ms} ms` : '—') },
        { title: '方式', width: 70, render: (_, r) => (r.stream ? '流式' : '非流式') },
        {
          title: '尝试序列',
          render: (_, r) => {
            if (r.error) {
              return (
                <Typography.Text type="danger" style={{ fontSize: 12 }}>
                  ✘ {r.error.slice(0, 80)}
                </Typography.Text>
              );
            }
            const trace = r.trace?.length
              ? r.trace
              : (r.attempts ?? []).map((u) => ({ upstream: u === 'auto' ? null : u, status: 200, ms: 0, note: '' }));
            if (!trace.length) return '—';
            return (
              <span style={{ fontSize: 11, fontFamily: 'monospace' }}>
                {trace.map((t) => `${t.upstream ?? 'auto'}${t.status === 200 ? '✔' : `✗${t.status}`}`).join(' → ')}
              </span>
            );
          },
        },
      ]}
    />
  );
}

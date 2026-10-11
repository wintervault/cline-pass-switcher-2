import { CopyOutlined, ReloadOutlined } from '@ant-design/icons';
import {
  Alert,
  Badge,
  Button,
  Empty,
  Segmented,
  Select,
  Skeleton,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
  theme,
} from 'antd';
import { useEffect, useState } from 'react';

import { useHistory } from '../api/hooks.ts';
import type { HistoryEntry, TraceEntry } from '../api/types.ts';
import { useFeedback } from '../feedback.ts';
import { PageHeader } from '../pageHeader.tsx';
import { Panel } from '../panel.tsx';

/** 自动刷新间隔（毫秒）；0 = 关闭。 */
const REFRESH_OPTIONS = [
  { value: 0, label: '自动刷新：关' },
  { value: 5_000, label: '每 5 秒' },
  { value: 15_000, label: '每 15 秒' },
  { value: 30_000, label: '每 30 秒' },
];

/** 相对时间：一眼知道「多久之前」，悬停看完整时间。 */
function relTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

/** 账号：邮箱太长只留首段 + 域名，完整值进悬停。纯文本呈现——
 *  行为列里已经有渠道标签，再来一个标签就成了两种「块」，扫读时互相抢。 */
function AccountCell({ account }: { account: string | null }) {
  const { token } = theme.useToken();
  if (!account) return <Typography.Text type="secondary">—</Typography.Text>;
  const at = account.indexOf('@');
  const name = at > 0 ? account.slice(0, at) : account;
  const domain = at > 0 ? account.slice(at) : '';
  const head = name.length > 10 ? `${name.slice(0, 9)}…` : name;
  return (
    <Tooltip title={account}>
      <span className="cps-cell-text">
        {head}
        {domain && <span style={{ color: token.colorTextTertiary }}>{domain}</span>}
      </span>
    </Tooltip>
  );
}

/** 毫秒的紧凑写法：不足 1 秒保留毫秒，超过用秒（8534ms → 8.5s）。
 *  尝试链里每个候选都要带耗时，短一截就能多放下一个候选。 */
function fmtMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** 尝试状态 → 圆点语义。 */
const dotStatus = (status: number): 'success' | 'warning' | 'error' | 'default' =>
  status === 200 ? 'success' : status === 429 ? 'warning' : status >= 500 || status === 402 ? 'error' : 'default';

/**
 * 尝试链：渠道 + 状态点 + 耗时，**压成一行**。
 *
 * 原来用 `Space wrap`，两次尝试的失败行会折成两行，行高从 43 变成 72——
 * 整张表因此「不平整」（真实反馈）。现在单行排布，放不下就整体省略，
 * 完整信息进悬停。
 */
function TraceChain({ trace, attempts }: { trace?: TraceEntry[]; attempts: string[] }) {
  const { token } = theme.useToken();
  const list = trace?.length
    ? trace
    : (attempts ?? []).map((u) => ({ upstream: u === 'auto' ? null : u, status: 200, ms: 0, note: '' }));
  if (!list.length) return <Typography.Text type="secondary">—</Typography.Text>;
  return (
    <Tooltip
      title={
        <div style={{ display: 'grid', gap: 2 }}>
          {list.map((t) => (
            <div key={`${t.upstream ?? 'auto'}|${t.status}|${t.ms}|${t.note}`}>
              {t.upstream ?? '自动'} · {fmtMs(t.ms)} · HTTP {t.status}
              {t.note && t.note !== 'ok' ? ` · ${t.note}` : ''}
            </div>
          ))}
        </div>
      }
    >
      <div className="cps-trace">
        {list.map((t, i) => (
          <span key={`${t.upstream ?? 'auto'}|${t.status}|${t.ms}|${t.note}`} className="cps-trace-item">
            {i > 0 && <span style={{ color: token.colorTextQuaternary }}>›</span>}
            <Badge status={dotStatus(t.status)} />
            <span className="cps-mono">{t.upstream ?? 'auto'}</span>
            <span style={{ color: token.colorTextTertiary, fontVariantNumeric: 'tabular-nums' }}>{fmtMs(t.ms)}</span>
          </span>
        ))}
      </div>
    </Tooltip>
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
  const { token } = theme.useToken();
  const fb = useFeedback();
  const history = useHistory();
  const rows = history.data?.history ?? [];
  /** 排查场景的快捷筛选：全部 / 成功 / 失败。 */
  const [view, setView] = useState<'all' | 'ok' | 'fail'>('all');
  /**
   * 自动刷新默认开（5 秒）：这一页是排查用的，边改配置边看请求效果时，
   * 手动刷新纯属浪费动作。想安静看历史就切「关」。
   */
  const [interval, setIntervalMs] = useState(5_000);

  // 自动刷新：轮询时保持上一次数据可见（isFetching 而非 isLoading），不闪白
  useEffect(() => {
    if (!interval) return;
    const timer = window.setInterval(() => void history.refetch(), interval);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [interval, history.refetch]);

  const okRows = rows.filter((r) => !r.error);
  const failed = rows.length - okRows.length;
  const msList = okRows.map((r) => r.ms).filter((m): m is number => typeof m === 'number');
  const avgMs = msList.length ? Math.round(msList.reduce((a, b) => a + b, 0) / msList.length) : 0;
  const streamPct = rows.length ? Math.round((rows.filter((r) => r.stream).length / rows.length) * 100) : 0;
  const visible = view === 'all' ? rows : view === 'ok' ? okRows : rows.filter((r) => r.error);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
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
        <Panel
          flush
          title={
            <Space size={32} wrap>
              <Stat label="成功" value={String(okRows.length)} tone={token.colorSuccess} />
              <Stat label="失败" value={String(failed)} tone={failed ? token.colorError : undefined} />
              <Stat label="平均耗时" value={`${avgMs}ms`} />
              <Stat label="流式占比" value={`${streamPct}%`} />
            </Space>
          }
          extra={
            /* 刷新控制：手动一次 / 按间隔自动（失败排查时开着它最省事） */
            <Space size={8}>
              <Tooltip title="立即刷新">
                <Button
                  size="small"
                  icon={<ReloadOutlined spin={history.isFetching} />}
                  onClick={() => {
                    void history.refetch().then((r) => {
                      if (r.isError) fb.fail('刷新失败', r.error);
                      else fb.ok(`已刷新：共 ${r.data?.history.length ?? 0} 条记录`);
                    });
                  }}
                />
              </Tooltip>
              <Select
                size="small"
                style={{ width: 132 }}
                value={interval}
                onChange={setIntervalMs}
                options={REFRESH_OPTIONS}
              />
              <Segmented
                size="small"
                value={view}
                onChange={(v) => setView(v as typeof view)}
                options={[
                  { value: 'all', label: `全部 ${rows.length}` },
                  { value: 'ok', label: `成功 ${okRows.length}` },
                  { value: 'fail', label: `失败 ${failed}` },
                ]}
              />
            </Space>
          }
        >
          <Table<HistoryEntry>
            rowKey={(r) => `${r.ts}-${r.model}-${r.attempts.join('|')}`}
            size="small"
            sticky
            loading={history.isLoading}
            dataSource={visible}
            /* 940 = 各定宽列之和 + 尝试序列的下限。定在 1000 时，用户那台
               （125% 缩放后内容区约 998px）会为 2px 溢出一条横向滚动条。 */
            scroll={{ x: 900 }}
            locale={{
              emptyText: (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无请求记录：agent 发出请求后会出现在这里" />
              ),
            }}
            pagination={{ pageSize: 20, hideOnSinglePage: true, showSizeChanger: false }}
            onRow={(r) => ({ style: r.error ? { background: token.colorErrorBg } : undefined })}
            columns={[
              {
                title: '时间',
                width: 84,
                render: (_, r) => (
                  <Tooltip title={new Date(r.ts).toLocaleString()}>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {relTime(r.ts)}
                    </Typography.Text>
                  </Tooltip>
                ),
              },
              {
                title: '模型',
                dataIndex: 'model',
                width: 232,
                /* 纯等宽文字，不用内联 code 芯片：芯片自带内边距与描边，一行里
                   和标签/数字混在一起很碎；复制走行尾那个按钮（复制整条记录）。 */
                render: (v: string) => (
                  <Tooltip title={v}>
                    <span className="cps-mono cps-cell-ellipsis">{v}</span>
                  </Tooltip>
                ),
              },
              { title: '账号', width: 132, render: (_, r) => <AccountCell account={r.account} /> },
              {
                title: '实际渠道',
                width: 128,
                render: (_, r) => (
                  <Space size={4}>
                    {r.provider ? <Tag color="geekblue">{r.provider}</Tag> : '—'}
                    {r.pinMismatch && (
                      <Tooltip title="strict 钉住未生效：网关实际由别的渠道提供服务（流式只能标记，不能撤回）">
                        <Tag color="red">未生效</Tag>
                      </Tooltip>
                    )}
                  </Space>
                ),
              },
              {
                title: '耗时',
                width: 76,
                align: 'right',
                render: (_, r) =>
                  r.ms != null ? (
                    <Typography.Text className="cps-num">{r.ms} ms</Typography.Text>
                  ) : (
                    <Typography.Text type="secondary">—</Typography.Text>
                  ),
              },
              {
                title: '方式',
                width: 58,
                render: (_, r) => (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {r.stream ? '流式' : '非流式'}
                  </Typography.Text>
                ),
              },
              {
                title: '尝试序列',
                render: (_, r) =>
                  r.error ? (
                    <Tooltip title={r.error}>
                      <span className="cps-cell-ellipsis" style={{ color: token.colorError, fontSize: 12 }}>
                        {r.error}
                      </span>
                    </Tooltip>
                  ) : (
                    <TraceChain trace={r.trace} attempts={r.attempts} />
                  ),
              },
              {
                title: '',
                width: 40,
                render: (_, r) => (
                  <Tooltip title="复制这条请求的完整信息（排查时贴给别人看）">
                    <Button
                      size="small"
                      type="text"
                      icon={<CopyOutlined />}
                      aria-label="复制请求详情"
                      onClick={() => {
                        void navigator.clipboard.writeText(JSON.stringify(r, null, 2)).then(
                          () => fb.copy('这条请求的完整信息'),
                          () => fb.fail('复制失败', '剪贴板不可用'),
                        );
                      }}
                    />
                  </Tooltip>
                ),
              },
            ]}
          />
        </Panel>
      )}
    </div>
  );
}

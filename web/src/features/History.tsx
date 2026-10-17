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
import { useGatewayScope } from '../gatewayScope.tsx';
import { type MsgKey, useI18n } from '../i18n/index.tsx';
import { PageHeader } from '../pageHeader.tsx';
import { Panel } from '../panel.tsx';

/** 自动刷新间隔（毫秒）；0 = 关闭。 */
const REFRESH_OPTIONS: Array<{ value: number; labelKey: MsgKey }> = [
  { value: 0, labelKey: 'history.interval.off' },
  { value: 5_000, labelKey: 'history.interval.5s' },
  { value: 15_000, labelKey: 'history.interval.15s' },
  { value: 30_000, labelKey: 'history.interval.30s' },
];

/** 相对时间：一眼知道「多久之前」，悬停看完整时间。 */
function relTime(ts: number, t: (key: MsgKey, params?: Record<string, string | number>) => string): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return t('history.rel.now');
  if (diff < 3_600_000) return t('history.rel.minutes', { count: Math.floor(diff / 60_000) });
  if (diff < 86_400_000) return t('history.rel.hours', { count: Math.floor(diff / 3_600_000) });
  return t('history.rel.days', { count: Math.floor(diff / 86_400_000) });
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
  const { t: tr } = useI18n();
  const list = trace?.length
    ? trace
    : (attempts ?? []).map((u) => ({ upstream: u === 'auto' ? null : u, status: 200, ms: 0, note: '' }));
  if (!list.length) return <Typography.Text type="secondary">—</Typography.Text>;
  return (
    <Tooltip
      title={
        <div style={{ display: 'grid', gap: 2 }}>
          {list.map((entry) => (
            <div key={`${entry.upstream ?? 'auto'}|${entry.status}|${entry.ms}|${entry.note}`}>
              {entry.upstream ?? tr('history.trace.auto')} · {fmtMs(entry.ms)} · HTTP {entry.status}
              {entry.note && entry.note !== 'ok' ? ` · ${entry.note}` : ''}
            </div>
          ))}
        </div>
      }
    >
      <div className="cps-trace">
        {list.map((entry, i) => (
          <span
            key={`${entry.upstream ?? 'auto'}|${entry.status}|${entry.ms}|${entry.note}`}
            className="cps-trace-item"
          >
            {i > 0 && <span style={{ color: token.colorTextQuaternary }}>›</span>}
            <Badge status={dotStatus(entry.status)} />
            <span className="cps-mono">{entry.upstream ?? 'auto'}</span>
            <span style={{ color: token.colorTextTertiary, fontVariantNumeric: 'tabular-nums' }}>
              {fmtMs(entry.ms)}
            </span>
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
  const { t } = useI18n();
  const fb = useFeedback();
  const history = useHistory();
  const rows = history.data?.history ?? [];
  /** 排查场景的快捷筛选：全部 / 成功 / 失败。 */
  const [view, setView] = useState<'all' | 'ok' | 'fail'>('all');
  /** 网关筛选：所有网关 / 某一个（多网关下排查必须能分开看）。 */
  const { gateways } = useGatewayScope();
  const [gatewayFilter, setGatewayFilter] = useState<string>('all');
  const gatewayName = (id: string): string => gateways.find((g) => g.id === id)?.name ?? id;
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
  const byView = view === 'all' ? rows : view === 'ok' ? okRows : rows.filter((r) => r.error);
  const visible = gatewayFilter === 'all' ? byView : byView.filter((r) => r.gateway === gatewayFilter);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <PageHeader title={t('history.title')} desc={t('history.desc')} />
      {history.isError ? (
        <Alert
          type="error"
          showIcon
          message={t('history.loadFailed')}
          description={t('history.loadFailed.desc')}
          action={
            <Button size="small" onClick={() => void history.refetch()}>
              {t('common.retry')}
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
              <Stat label={t('history.stat.ok')} value={String(okRows.length)} tone={token.colorSuccess} />
              <Stat
                label={t('history.stat.failed')}
                value={String(failed)}
                tone={failed ? token.colorError : undefined}
              />
              <Stat label={t('history.stat.avg')} value={`${avgMs}ms`} />
              <Stat label={t('history.stat.stream')} value={`${streamPct}%`} />
            </Space>
          }
          extra={
            /* 刷新控制：手动一次 / 按间隔自动（失败排查时开着它最省事） */
            <Space size={8}>
              <Tooltip title={t('history.refresh')}>
                <Button
                  size="small"
                  icon={<ReloadOutlined spin={history.isFetching} />}
                  onClick={() => {
                    void history.refetch().then((r) => {
                      if (r.isError) fb.fail(t('history.refreshFailed'), r.error);
                      else fb.ok(t('history.refreshed', { count: r.data?.history.length ?? 0 }));
                    });
                  }}
                />
              </Tooltip>
              <Select
                size="small"
                style={{ width: 132 }}
                value={interval}
                onChange={setIntervalMs}
                options={REFRESH_OPTIONS.map((o) => ({ value: o.value, label: t(o.labelKey) }))}
              />
              {gateways.length > 1 && (
                <Select
                  size="small"
                  style={{ width: 140 }}
                  value={gatewayFilter}
                  onChange={setGatewayFilter}
                  options={[
                    { value: 'all', label: t('history.gateway.all') },
                    ...gateways.map((g) => ({ value: g.id, label: g.name })),
                  ]}
                />
              )}
              <Segmented
                size="small"
                value={view}
                onChange={(v) => setView(v as typeof view)}
                options={[
                  { value: 'all', label: t('history.view.all', { count: rows.length }) },
                  { value: 'ok', label: t('history.view.ok', { count: okRows.length }) },
                  { value: 'fail', label: t('history.view.fail', { count: failed }) },
                ]}
              />
            </Space>
          }
        >
          <Table<HistoryEntry>
            className="cps-table-center"
            rowKey={(r) => `${r.ts}-${r.model}-${r.attempts.join('|')}`}
            size="small"
            sticky
            loading={history.isLoading}
            dataSource={visible}
            /* 表的最小宽度 = 定宽列之和 + 尝试序列的下限：
               72+76+190+110+116+72+54 = 690（前七列）+ 56（复制列）+ 124（尝试序列）= 870。
               这个数不是随手填的——定得比「窄窗口下的内容列宽」大一点，就会为
               一两个像素溢出一条横向滚动条（1165 宽的窗口下内容列 899，原来定 900
               正好溢出）；定得比下限小，尝试序列就会被压到看不清。再窄就横向滚动，
               而不是继续压缩每一列。 */
            scroll={{ x: 870 }}
            locale={{
              emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('history.empty')} />,
            }}
            pagination={{ pageSize: 20, hideOnSinglePage: true, showSizeChanger: false }}
            onRow={(r) => ({ style: r.error ? { background: token.colorErrorBg } : undefined })}
            columns={[
              {
                title: t('history.col.time'),
                width: 72,
                render: (_, r) => (
                  <Tooltip title={new Date(r.ts).toLocaleString()}>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {relTime(r.ts, t)}
                    </Typography.Text>
                  </Tooltip>
                ),
              },
              {
                title: t('history.col.gateway'),
                width: 76,
                render: (_, r) => (
                  <Tooltip title={gatewayName(r.gateway)}>
                    <span className="cps-cell-ellipsis" style={{ fontSize: 12 }}>
                      {gatewayName(r.gateway)}
                    </span>
                  </Tooltip>
                ),
              },
              {
                title: t('history.col.model'),
                dataIndex: 'model',
                width: 190,
                /* 纯等宽文字，不用内联 code 芯片：芯片自带内边距与描边，一行里
                   和标签/数字混在一起很碎；复制走行尾那个按钮（复制整条记录）。 */
                render: (v: string) => (
                  <Tooltip title={v}>
                    <span className="cps-mono cps-cell-ellipsis">{v}</span>
                  </Tooltip>
                ),
              },
              { title: t('history.col.account'), width: 110, render: (_, r) => <AccountCell account={r.account} /> },
              {
                title: t('history.col.provider'),
                width: 116,
                render: (_, r) => (
                  <Space size={4}>
                    {r.provider ? <Tag color="geekblue">{r.provider}</Tag> : '—'}
                    {r.pinMismatch && (
                      <Tooltip title={t('history.pinMismatch')}>
                        <Tag color="red">{t('history.pinMismatch.tag')}</Tag>
                      </Tooltip>
                    )}
                  </Space>
                ),
              },
              {
                title: t('history.col.ms'),
                width: 72,
                render: (_, r) =>
                  r.ms != null ? (
                    <Typography.Text className="cps-num">{r.ms} ms</Typography.Text>
                  ) : (
                    <Typography.Text type="secondary">—</Typography.Text>
                  ),
              },
              {
                title: t('history.col.mode'),
                width: 54,
                render: (_, r) => (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {r.stream ? t('history.stream') : t('history.nonStream')}
                  </Typography.Text>
                ),
              },
              {
                title: t('history.col.trace'),
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
                /* 操作列：宽度必须容得下按钮本身（24）与单元格内边距（两侧各 16），
                   否则按钮会被挤在 24px 的框里——这就是反馈里「复制按钮被挤压变形」。
                   `fixed: 'right'` 让它永远贴在表格右侧：表格横向滚动时它不会
                   跟着滑走，也就不会被切掉一半。 */
                title: t('history.col.actions'),
                width: 56,
                fixed: 'right',
                render: (_, r) => (
                  <Tooltip title={t('history.copy.tip')}>
                    <Button
                      size="small"
                      type="text"
                      icon={<CopyOutlined />}
                      aria-label={t('history.copy.tip')}
                      onClick={() => {
                        void navigator.clipboard.writeText(JSON.stringify(r, null, 2)).then(
                          () => fb.copy(t('history.copy')),
                          () => fb.fail(t('common.copyFailed'), t('common.clipboardUnavailable')),
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

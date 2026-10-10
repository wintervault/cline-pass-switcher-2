import { ArrowDownOutlined, ArrowUpOutlined, DownloadOutlined } from '@ant-design/icons';
import { useQueryClient } from '@tanstack/react-query';
import { Alert, App, Badge, Button, Select, Space, Table, Tag, Tooltip, Typography, theme } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useState } from 'react';
import { qk, useFetchOfficial, useModels, useProbe, useSaveModelConfig, useTest, useValidate } from '../api/hooks.ts';
import {
  type ModelMeta,
  type ModelsResponse,
  type PerModelConfig,
  type SortKey,
  STATUS_RANK,
  STATUS_TAG,
  type SubscriptionRow,
  type UpstreamStatusKind,
} from '../api/types.ts';
import { PageHeader } from '../pageHeader.tsx';

const EMPTY_CFG: PerModelConfig = { upstreams: [], exclude: [], pinMode: 'strict', sort: null };

/** 按校验状态排序的渠道列表（可用优先），供面板与测试台共用。 */
export function sortedUpstreams(meta: ModelMeta | null): string[] {
  const statusOf = (u: string): UpstreamStatusKind => meta?.upstreamStatus[u]?.status ?? 'unknown';
  return [...(meta?.upstreams ?? [])].sort((a, b) => (STATUS_RANK[statusOf(a)] ?? 2) - (STATUS_RANK[statusOf(b)] ?? 2));
}

const statusTag = (kind: UpstreamStatusKind) => {
  const s = STATUS_TAG[kind];
  return <Tag color={s.color}>{s.label}</Tag>;
};

function SummaryChips({ cfg }: { cfg: PerModelConfig }) {
  if (!cfg.upstreams.length && !cfg.exclude.length) {
    return <Typography.Text type="secondary">自动 · 网关智能选择</Typography.Text>;
  }
  return (
    <Space size={4} wrap>
      {cfg.upstreams.slice(0, 4).map((u, i) => (
        <Tag key={u} color="blue">
          {i + 1} {u}
        </Tag>
      ))}
      {cfg.upstreams.length > 4 && <Tag>+{cfg.upstreams.length - 4}</Tag>}
      {cfg.exclude.length > 0 && <Tag color="red">排除 {cfg.exclude.length}</Tag>}
    </Space>
  );
}

function UpstreamRow({
  upstream,
  cfg,
  meta,
  onSave,
}: {
  upstream: string;
  cfg: PerModelConfig;
  meta: ModelMeta | null;
  onSave: (patch: Partial<PerModelConfig>) => void;
}) {
  const { token } = theme.useToken();
  const selected = cfg.upstreams.includes(upstream);
  const excluded = cfg.exclude.includes(upstream);
  const order = cfg.upstreams.indexOf(upstream);
  const detail = meta?.upstreamDetail[upstream];
  const status = meta?.upstreamStatus[upstream]?.status;

  const toggleSelect = () => {
    if (selected) {
      onSave({ upstreams: cfg.upstreams.filter((x) => x !== upstream) });
    } else {
      onSave({
        upstreams: [...cfg.upstreams.filter((x) => !cfg.exclude.includes(x)), upstream],
        exclude: cfg.exclude.filter((x) => x !== upstream),
      });
    }
  };
  const toggleExclude = () => {
    if (excluded) {
      onSave({ exclude: cfg.exclude.filter((x) => x !== upstream) });
    } else {
      onSave({ upstreams: cfg.upstreams.filter((x) => x !== upstream), exclude: [...cfg.exclude, upstream] });
    }
  };
  const move = (dir: -1 | 1) => {
    const list = [...cfg.upstreams];
    const i = list.indexOf(upstream);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return;
    const a = list[i];
    const b = list[j];
    if (a === undefined || b === undefined) return;
    list[i] = b;
    list[j] = a;
    onSave({ upstreams: list });
  };

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '6px 0',
        borderBottom: `1px dashed ${token.colorBorderSecondary}`,
        opacity: excluded ? 0.55 : 1,
      }}
    >
      <span style={{ width: 22, textAlign: 'center' }}>
        {selected ? <Badge count={order + 1} color={token.colorPrimary} overflowCount={99} /> : null}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <Typography.Text code style={{ fontSize: 12 }}>
          {upstream}
        </Typography.Text>
        <div style={{ fontSize: 11, color: token.colorTextTertiary, overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {detail?.name ?? ''}
          {detail && detail.endpoints !== undefined && detail.endpoints > 1 ? ` ×${detail.endpoints}` : ''}
        </div>
      </div>
      <div style={{ width: 76, textAlign: 'right' }}>
        {excluded ? <Tag color="red">已排除</Tag> : status ? statusTag(status) : null}
      </div>
      <Button size="small" type={selected ? 'primary' : 'default'} onClick={toggleSelect}>
        优先
      </Button>
      <Button size="small" danger={excluded} onClick={toggleExclude}>
        排除
      </Button>
      {selected && (
        <Space size={2}>
          <Button size="small" variant="outlined" icon={<ArrowUpOutlined />} onClick={() => move(-1)} />
          <Button size="small" variant="outlined" icon={<ArrowDownOutlined />} onClick={() => move(1)} />
        </Space>
      )}
    </div>
  );
}

function UpstreamPanel({ row, onSave }: { row: SubscriptionRow; onSave: (patch: Partial<PerModelConfig>) => void }) {
  const cfg = row.config ?? EMPTY_CFG;
  const meta = row.meta;
  const ups = sortedUpstreams(meta);

  return (
    <div style={{ padding: '4px 0' }}>
      {meta?.pinState === 'ignored' && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 8 }}
          message="网关已忽略钉住参数（账号风控或策略变更）"
          description={
            meta.pinDisabledReason ??
            '钉住/排除/排序均不生效；勾选仅保留意图，网关恢复执行后自动生效。换个账号或稍后重新探测可能恢复。'
          }
        />
      )}
      {ups.map((u) => (
        <UpstreamRow key={u} upstream={u} cfg={cfg} meta={meta} onSave={onSave} />
      ))}
      {ups.length === 0 && <Typography.Text type="secondary">尚未探测到上游，先点「探测」</Typography.Text>}
      <Space style={{ marginTop: 10 }}>
        <Button
          size="small"
          onClick={() => onSave({ upstreams: ups.filter((u) => !cfg.exclude.includes(u)), exclude: cfg.exclude })}
        >
          全选优先
        </Button>
        <Button size="small" onClick={() => onSave({ upstreams: [], exclude: [] })}>
          清空
        </Button>
        <Typography.Text type="secondary" style={{ fontSize: 11 }}>
          「优先」按序尝试（异常自动顺切）；「排除」永不使用
        </Typography.Text>
      </Space>
    </div>
  );
}

export default function Models() {
  const { message } = App.useApp();
  const {
    token: { colorTextTertiary: tokenColorTextTertiary },
  } = theme.useToken();
  const models = useModels();
  const qc = useQueryClient();
  const save = useSaveModelConfig();
  const probe = useProbe();
  const validate = useValidate();
  const test = useTest();
  const fetchOfficial = useFetchOfficial();
  const [fetchNote, setFetchNote] = useState<string | null>(null);

  const rows = models.data?.subscription ?? [];
  const official = models.data?.officialFetch ?? null;

  const saveConfig = (modelId: string, patch: Partial<PerModelConfig>) => {
    const current = rows.find((r) => r.id === modelId)?.config ?? EMPTY_CFG;
    const merged: PerModelConfig = { ...current, ...patch };
    // 乐观更新：面板立刻反映，onSuccess 的失效会拉回服务端真实状态
    qc.setQueryData<ModelsResponse>(qk.models, (old) =>
      old
        ? { ...old, subscription: old.subscription.map((s) => (s.id === modelId ? { ...s, config: merged } : s)) }
        : old,
    );
    save.mutate({ modelId, config: merged });
  };

  const columns: ColumnsType<SubscriptionRow> = [
    {
      title: '模型',
      dataIndex: 'id',
      width: 240,
      render: (_, row) => (
        <>
          <Typography.Text code>{row.id}</Typography.Text>
          <div style={{ marginTop: 4 }}>
            {row.meta?.pinnable ? (
              <Tag color="green">可钉住 · {row.meta.pipeline === 'planner' ? 'Vercel' : 'OpenRouter'}</Tag>
            ) : (
              <Tag color="orange">请先探测</Tag>
            )}
            {row.meta?.pinState === 'ignored' && (
              <Tooltip title={row.meta.pinDisabledReason ?? '网关忽略钉住参数，钉住/排除/排序均不生效'}>
                <Tag color="red">钉住参数被网关忽略</Tag>
              </Tooltip>
            )}
          </div>
          {row.meta?.tier0?.length ? (
            <Typography.Text type="secondary" style={{ fontSize: 11 }}>
              tier-0: {row.meta.tier0.join(', ')}
            </Typography.Text>
          ) : null}
        </>
      ),
    },
    {
      title: '背后模型',
      width: 170,
      render: (_, row) =>
        row.meta?.canonicalSlug ? (
          <Typography.Text type="secondary" code style={{ fontSize: 12 }}>
            {row.meta.canonicalSlug}
          </Typography.Text>
        ) : (
          '—'
        ),
    },
    { title: '上游数', width: 70, render: (_, row) => row.meta?.upstreams?.length ?? '—' },
    {
      title: '最近实际上游',
      width: 130,
      render: (_, row) => (
        <>
          {row.meta?.lastProvider ? (
            <Tag color="geekblue">{row.meta.lastProvider}</Tag>
          ) : (
            <Typography.Text type="secondary">未探测</Typography.Text>
          )}
          {row.meta?.lastMs ? (
            <div style={{ fontSize: 11, color: tokenColorTextTertiary }}>{row.meta.lastMs} ms</div>
          ) : null}
        </>
      ),
    },
    {
      title: '上游优先级 / 排除（多选）',
      render: (_, row) => <SummaryChips cfg={row.config ?? EMPTY_CFG} />,
    },
    {
      title: '模式 / 排序',
      width: 150,
      render: (_, row) => {
        const cfg = row.config ?? EMPTY_CFG;
        return (
          <div>
            <Select
              size="small"
              style={{ width: '100%' }}
              value={cfg.pinMode}
              onChange={(v) => saveConfig(row.id, { pinMode: v })}
              options={[
                { value: 'strict', label: '严格钉住' },
                { value: 'preferred', label: '优先+回退' },
              ]}
            />
            <Select
              size="small"
              style={{ width: '100%', marginTop: 4 }}
              value={cfg.sort ?? ''}
              onChange={(v) => saveConfig(row.id, { sort: (v || null) as SortKey | null })}
              options={[
                { value: '', label: '网关智能选' },
                { value: 'cost', label: '最低成本' },
                { value: 'ttft', label: '最快首字' },
                { value: 'tps', label: '最高吞吐' },
              ]}
            />
          </div>
        );
      },
    },
    {
      title: '操作',
      width: 190,
      render: (_, row) => (
        <Space size={4}>
          <Button
            size="small"
            loading={probe.isPending && probe.variables === row.id}
            onClick={() =>
              probe.mutate(row.id, {
                onSuccess: (r) =>
                  r.ok
                    ? message.success(`${row.id} 探测完成：上游 ${r.upstreams.length} 个`)
                    : message.error(`探测失败：${r.error ?? '未知错误'}`),
                onError: (e) => message.error(String(e)),
              })
            }
          >
            探测
          </Button>
          <Button
            size="small"
            onClick={() =>
              test.mutate(
                { model: row.id, upstreams: row.config?.upstreams ?? [], exclude: row.config?.exclude ?? [] },
                {
                  onSuccess: (r) =>
                    r.ok
                      ? message.success(`测试通过：命中 ${r.actual ?? '未知'}（${r.ms ?? 0}ms）`)
                      : message.error(`测试失败：${r.error ?? '未知错误'}`),
                  onError: (e) => message.error(String(e)),
                },
              )
            }
          >
            测试
          </Button>
          <Tooltip
            title={
              row.meta?.pinState === 'ignored'
                ? '网关已忽略钉住参数：钉不住时每个渠道都会“成功”，校验结果不可信（先重新探测）'
                : '把每个上游渠道各钉一次最小请求，标出可用/限流/不可钉'
            }
          >
            <Button
              size="small"
              disabled={row.meta?.pinState === 'ignored'}
              loading={validate.isPending && validate.variables === row.id}
              onClick={() =>
                validate.mutate(row.id, {
                  onSuccess: (r) =>
                    message.success(
                      `校验完成：可用 ${r.summary.ok ?? 0} · 限流 ${r.summary.limited ?? 0} · 不可钉 ${r.summary.bad ?? 0} · key错 ${r.summary.auth ?? 0}`,
                    ),
                  onError: () => message.error('校验失败'),
                })
              }
            >
              校验
            </Button>
          </Tooltip>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <PageHeader title="订阅模型" desc="先「探测」拿到渠道清单，再配置优先级与排除；「校验」逐渠道实测可用性。" />
      <Space style={{ marginBottom: 16 }} wrap>
        <Button
          loading={fetchOfficial.isPending}
          onClick={() =>
            fetchOfficial.mutate(undefined, {
              onSuccess: (r) =>
                setFetchNote(
                  r.added.length
                    ? `✔ 新增 ${r.added.length} 个：${r.added.join('、')}`
                    : `✔ 清单已是最新（官方 ${r.found} 个，现有 ${r.knownModels.length} 个）`,
                ),
              onError: () => setFetchNote('拉取失败，请稍后重试'),
            })
          }
        >
          <DownloadOutlined /> 拉取官方最新模型
        </Button>
        {official && (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            上次拉取 {new Date(official.ts).toLocaleString()}（{official.sources.join('+')}，新增{' '}
            {official.added.length}）
          </Typography.Text>
        )}
        {fetchNote && <Typography.Text style={{ fontSize: 12 }}>{fetchNote}</Typography.Text>}
      </Space>

      <Table
        rowKey="id"
        size="small"
        loading={models.isLoading}
        dataSource={rows}
        columns={columns}
        pagination={false}
        expandable={{
          expandedRowRender: (row) => <UpstreamPanel row={row} onSave={(patch) => saveConfig(row.id, patch)} />,
        }}
        scroll={{ x: 1160 }}
      />
    </div>
  );
}

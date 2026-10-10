import { ArrowDownOutlined, ArrowUpOutlined, DownloadOutlined } from '@ant-design/icons';
import { useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  App,
  Badge,
  Button,
  Card,
  Descriptions,
  Empty,
  Select,
  Space,
  Tag,
  Tooltip,
  Typography,
  theme,
} from 'antd';
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

/** 按校验状态排序的渠道列表（可用优先），供详情面板与测试台共用。 */
export function sortedUpstreams(meta: ModelMeta | null): string[] {
  const statusOf = (u: string): UpstreamStatusKind => meta?.upstreamStatus[u]?.status ?? 'unknown';
  return [...(meta?.upstreams ?? [])].sort((a, b) => (STATUS_RANK[statusOf(a)] ?? 2) - (STATUS_RANK[statusOf(b)] ?? 2));
}

const statusTag = (kind: UpstreamStatusKind) => {
  const s = STATUS_TAG[kind];
  return <Tag color={s.color}>{s.label}</Tag>;
};

const fmtTime = (ts: number | null | undefined): string =>
  ts
    ? new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    : '—';

/** 左侧模型列表项：一眼看清该模型的状态（渠道数/优先配置/被忽略/最近路由）。 */
function ModelItem({ row, active, onClick }: { row: SubscriptionRow; active: boolean; onClick: () => void }) {
  const { token } = theme.useToken();
  const meta = row.meta;
  const cfg = row.config ?? EMPTY_CFG;
  const probed = (meta?.upstreams?.length ?? 0) > 0;
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        textAlign: 'left',
        cursor: 'pointer',
        border: `1px solid ${active ? token.colorPrimaryBorder : token.colorBorderSecondary}`,
        background: active ? token.colorPrimaryBg : token.colorBgContainer,
        borderRadius: token.borderRadius,
        padding: '10px 12px',
        display: 'grid',
        gap: 6,
        font: 'inherit',
      }}
    >
      <Typography.Text code style={{ fontSize: 12 }} ellipsis>
        {row.id}
      </Typography.Text>
      <Space size={4} wrap>
        {meta?.pinState === 'ignored' ? (
          <Tag color="red" style={{ margin: 0 }}>
            参数被忽略
          </Tag>
        ) : probed ? (
          <Tag color="geekblue" style={{ margin: 0 }}>
            {meta?.upstreams?.length ?? 0} 渠道
          </Tag>
        ) : (
          <Tag style={{ margin: 0 }}>未探测</Tag>
        )}
        {cfg.upstreams.length > 0 && (
          <Tag color="blue" style={{ margin: 0 }}>
            优先 {cfg.upstreams.length}
          </Tag>
        )}
        {cfg.exclude.length > 0 && (
          <Tag color="red" style={{ margin: 0 }}>
            排除 {cfg.exclude.length}
          </Tag>
        )}
      </Space>
      {meta?.lastProvider && (
        <Typography.Text type="secondary" style={{ fontSize: 11 }}>
          最近 {meta.lastProvider}
          {meta.lastMs ? ` · ${meta.lastMs}ms` : ''}
        </Typography.Text>
      )}
    </button>
  );
}

/** 渠道清单的一行：序号 / 渠道 / 状态 / 优先·排除 / 排序。 */
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
        gap: 12,
        padding: '7px 12px',
        borderRadius: token.borderRadius,
        background: selected ? token.colorPrimaryBg : undefined,
        opacity: excluded ? 0.5 : 1,
      }}
    >
      <span style={{ width: 26, display: 'flex', justifyContent: 'center' }}>
        {selected ? (
          <Badge count={order + 1} color={token.colorPrimary} overflowCount={99} />
        ) : (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            —
          </Typography.Text>
        )}
      </span>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <Typography.Text code style={{ fontSize: 12 }}>
          {upstream}
        </Typography.Text>
        {detail?.name && (
          <Typography.Text type="secondary" style={{ fontSize: 11 }} ellipsis>
            {detail.name}
            {detail.endpoints !== undefined && detail.endpoints > 1 ? ` ×${detail.endpoints}` : ''}
          </Typography.Text>
        )}
      </div>
      {excluded ? <Tag color="red">已排除</Tag> : status ? statusTag(status) : null}
      <Button size="small" type={selected ? 'primary' : 'default'} onClick={toggleSelect}>
        优先
      </Button>
      <Button size="small" danger={excluded} onClick={toggleExclude}>
        排除
      </Button>
      {selected ? (
        <Space size={2}>
          <Button size="small" type="text" icon={<ArrowUpOutlined />} disabled={order <= 0} onClick={() => move(-1)} />
          <Button
            size="small"
            type="text"
            icon={<ArrowDownOutlined />}
            disabled={order < 0 || order >= cfg.upstreams.length - 1}
            onClick={() => move(1)}
          />
        </Space>
      ) : (
        <span style={{ width: 48 }} />
      )}
    </div>
  );
}

export default function Models() {
  const { message } = App.useApp();
  const models = useModels();
  const qc = useQueryClient();
  const save = useSaveModelConfig();
  const probe = useProbe();
  const validate = useValidate();
  const test = useTest();
  const fetchOfficial = useFetchOfficial();
  const [fetchNote, setFetchNote] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const rows = models.data?.subscription ?? [];
  const official = models.data?.officialFetch ?? null;
  const current = rows.find((r) => r.id === selectedId) ?? rows[0] ?? null;

  const saveConfig = (modelId: string, patch: Partial<PerModelConfig>) => {
    const currentCfg = rows.find((r) => r.id === modelId)?.config ?? EMPTY_CFG;
    const merged: PerModelConfig = { ...currentCfg, ...patch };
    // 乐观更新：面板立刻反映，onSuccess 的失效会拉回服务端真实状态
    qc.setQueryData<ModelsResponse>(qk.models, (old) =>
      old
        ? { ...old, subscription: old.subscription.map((s) => (s.id === modelId ? { ...s, config: merged } : s)) }
        : old,
    );
    save.mutate({ modelId, config: merged });
  };

  const cfg = current?.config ?? EMPTY_CFG;
  const meta = current?.meta ?? null;
  const ups = sortedUpstreams(meta);
  const pinIgnored = meta?.pinState === 'ignored';

  const runProbe = (): void => {
    if (!current) return;
    probe.mutate(current.id, {
      onSuccess: (r) =>
        r.ok
          ? message.success(`${current.id} 探测完成：上游 ${r.upstreams.length} 个`)
          : message.error(`探测失败：${r.error ?? '未知错误'}`),
      onError: (e) => message.error(String(e)),
    });
  };
  const runTest = (): void => {
    if (!current) return;
    test.mutate(
      { model: current.id, upstreams: cfg.upstreams, exclude: cfg.exclude },
      {
        onSuccess: (r) =>
          r.ok
            ? message.success(`测试通过：命中 ${r.actual ?? '未知'}（${r.ms ?? 0}ms）`)
            : message.error(`测试失败：${r.error ?? '未知错误'}`),
        onError: (e) => message.error(String(e)),
      },
    );
  };
  const runValidate = (): void => {
    if (!current) return;
    validate.mutate(current.id, {
      onSuccess: (r) =>
        message.success(
          `校验完成：可用 ${r.summary.ok ?? 0} · 限流 ${r.summary.limited ?? 0} · 不可钉 ${r.summary.bad ?? 0} · key错 ${r.summary.auth ?? 0}`,
        ),
      onError: () => message.error('校验失败'),
    });
  };

  return (
    <div>
      <PageHeader
        title="订阅模型"
        desc="先「探测」拿到渠道清单，再配置优先级与排除；「校验」逐渠道实测可用性。"
        actions={
          <Space size={8} wrap>
            <Button
              icon={<DownloadOutlined />}
              loading={fetchOfficial.isPending}
              onClick={() =>
                fetchOfficial.mutate(undefined, {
                  onSuccess: (r) =>
                    setFetchNote(
                      r.added.length
                        ? `新增 ${r.added.length} 个：${r.added.join('、')}`
                        : `清单已是最新（官方 ${r.found} 个）`,
                    ),
                  onError: () => setFetchNote('拉取失败，请稍后重试'),
                })
              }
            >
              拉取官方最新模型
            </Button>
            {official && (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                上次拉取 {fmtTime(official.ts)}（{official.sources.join('+')}，新增 {official.added.length}）
              </Typography.Text>
            )}
            {fetchNote && (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {fetchNote}
              </Typography.Text>
            )}
          </Space>
        }
      />

      {rows.length === 0 ? (
        <Empty description="暂无订阅模型：点右上角「拉取官方最新模型」同步清单" />
      ) : (
        <div style={{ display: 'flex', gap: 20, alignItems: 'flex-start' }}>
          {/* 左：模型列表（常驻可见，状态一屏扫完） */}
          <div style={{ width: 292, flexShrink: 0, display: 'grid', gap: 6, position: 'sticky', top: 0 }}>
            {rows.map((r) => (
              <ModelItem key={r.id} row={r} active={current?.id === r.id} onClick={() => setSelectedId(r.id)} />
            ))}
          </div>

          {/* 右：详情与渠道配置 */}
          {current && (
            <div style={{ flex: 1, minWidth: 0, display: 'grid', gap: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                <Typography.Title level={4} style={{ margin: 0 }}>
                  {current.id}
                </Typography.Title>
                {meta?.pinnable && (
                  <Tag color="green">{meta.pipeline === 'planner' ? '规划器 · Vercel' : '直连 · OpenRouter'}</Tag>
                )}
                <Space size={8} style={{ marginLeft: 'auto' }}>
                  <Button size="small" loading={probe.isPending} onClick={runProbe}>
                    探测
                  </Button>
                  <Button size="small" loading={test.isPending} onClick={runTest}>
                    测试
                  </Button>
                  <Tooltip
                    title={
                      pinIgnored
                        ? '网关已忽略钉住参数：钉不住时每个渠道都会“成功”，校验结果不可信（先重新探测）'
                        : '把每个上游渠道各钉一次最小请求，标出可用/限流/不可钉'
                    }
                  >
                    <Button size="small" disabled={pinIgnored} loading={validate.isPending} onClick={runValidate}>
                      校验
                    </Button>
                  </Tooltip>
                </Space>
              </div>

              {pinIgnored && (
                <Alert
                  type="warning"
                  showIcon
                  message="网关已忽略钉住参数（账号风控或策略变更）"
                  description={
                    meta?.pinDisabledReason ??
                    '钉住/排除/排序均不生效；勾选仅保留意图，网关恢复执行后自动生效。换个账号或稍后重新探测可能恢复。'
                  }
                />
              )}

              <Descriptions
                size="small"
                column={{ xs: 1, sm: 2, lg: 4 }}
                items={[
                  {
                    key: 'canonical',
                    label: '背后模型',
                    children: meta?.canonicalSlug ? <Typography.Text code>{meta.canonicalSlug}</Typography.Text> : '—',
                  },
                  {
                    key: 'last',
                    label: '最近实际上游',
                    children: meta?.lastProvider ? (
                      <Space size={6}>
                        <Tag color="geekblue" style={{ margin: 0 }}>
                          {meta.lastProvider}
                        </Tag>
                        {meta.lastMs ? (
                          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                            {meta.lastMs}ms
                          </Typography.Text>
                        ) : null}
                      </Space>
                    ) : (
                      '—'
                    ),
                  },
                  { key: 'tier0', label: 'tier-0', children: meta?.tier0?.length ? meta.tier0.join('、') : '—' },
                  {
                    key: 'probedAt',
                    label: '探测 / 校验',
                    children: (
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        {fmtTime(meta?.probedAt)} / {fmtTime(meta?.validatedAt)}
                      </Typography.Text>
                    ),
                  },
                ]}
              />

              <Card
                size="small"
                title={`渠道优先级（${ups.length}）`}
                extra={
                  <Space size={8}>
                    <Button
                      size="small"
                      onClick={() =>
                        saveConfig(current.id, {
                          upstreams: ups.filter((u) => !cfg.exclude.includes(u)),
                          exclude: cfg.exclude,
                        })
                      }
                    >
                      全选优先
                    </Button>
                    <Button size="small" onClick={() => saveConfig(current.id, { upstreams: [], exclude: [] })}>
                      清空
                    </Button>
                  </Space>
                }
              >
                {ups.length ? (
                  <div style={{ display: 'grid', gap: 2 }}>
                    {ups.map((u) => (
                      <UpstreamRow
                        key={u}
                        upstream={u}
                        cfg={cfg}
                        meta={meta}
                        onSave={(patch) => saveConfig(current.id, patch)}
                      />
                    ))}
                  </div>
                ) : (
                  <Empty
                    image={Empty.PRESENTED_IMAGE_SIMPLE}
                    description={pinIgnored ? '钉住参数被忽略，渠道清单不可信' : '尚未探测到渠道，点上方「探测」'}
                  />
                )}
              </Card>

              <Card size="small" title="路由策略">
                <Space size={12} wrap align="center">
                  <Select
                    style={{ width: 160 }}
                    value={cfg.pinMode}
                    onChange={(v) => saveConfig(current.id, { pinMode: v })}
                    options={[
                      { value: 'strict', label: '严格钉住' },
                      { value: 'preferred', label: '优先 + 回退' },
                    ]}
                  />
                  <Select
                    style={{ width: 160 }}
                    value={cfg.sort ?? ''}
                    onChange={(v) => saveConfig(current.id, { sort: (v || null) as SortKey | null })}
                    options={[
                      { value: '', label: '网关智能选' },
                      { value: 'cost', label: '最低成本' },
                      { value: 'ttft', label: '最快首字' },
                      { value: 'tps', label: '最高吞吐' },
                    ]}
                  />
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    「优先」按序尝试（异常自动顺切）；「排除」永不使用。 严格钉住 =
                    只走清单内渠道，网关不听话视为失败并切换；优先 + 回退 = 仅最后一个候选放开网关选择。
                  </Typography.Text>
                </Space>
              </Card>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

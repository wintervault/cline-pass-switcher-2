import {
  ArrowDownOutlined,
  ArrowUpOutlined,
  DownloadOutlined,
  ExclamationCircleFilled,
  HolderOutlined,
  SearchOutlined,
  StopOutlined,
} from '@ant-design/icons';
import { useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Empty,
  Input,
  Select,
  Skeleton,
  Space,
  Tag,
  Tooltip,
  Typography,
  theme,
} from 'antd';
import { useEffect, useState } from 'react';
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
      className="cps-ghost"
      style={{
        textAlign: 'left',
        cursor: 'pointer',
        border: active ? `1px solid ${token.colorPrimaryBorder}` : undefined,
        background: active ? token.colorPrimaryBg : undefined,
        borderRadius: token.borderRadius,
        padding: 12,
        display: 'grid',
        gap: 8,
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
            使用 {cfg.upstreams.length}
          </Tag>
        )}
        {cfg.exclude.length > 0 && (
          <Tag color="red" style={{ margin: 0 }}>
            排除 {cfg.exclude.length}
          </Tag>
        )}
      </Space>
      {meta?.lastProvider && (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          最近 {meta.lastProvider}
          {meta.lastMs ? ` · ${meta.lastMs}ms` : ''}
        </Typography.Text>
      )}
    </button>
  );
}

/** 行内拖拽排序的回调集合（状态在父级，跨行共享）。 */
interface RowDragProps {
  isDragging: boolean;
  isDropTarget: boolean;
  onDragStartRow: (order: number) => void;
  onDragOverRow: (order: number) => void;
  onDropRow: (order: number) => void;
  onDragEndRow: () => void;
}

/** 渠道清单的一行：序号 / 渠道 / 状态 / 优先·排除 / 排序。 */
function UpstreamRow({
  upstream,
  cfg,
  meta,
  onSave,
  drag,
}: {
  upstream: string;
  cfg: PerModelConfig;
  meta: ModelMeta | null;
  /** note 是给用户看的回执文案（每类改动说清做了什么） */
  onSave: (patch: Partial<PerModelConfig>, note: string) => void;
  drag: RowDragProps;
}) {
  const { token } = theme.useToken();
  const selected = cfg.upstreams.includes(upstream);
  const excluded = cfg.exclude.includes(upstream);
  const order = cfg.upstreams.indexOf(upstream);
  const detail = meta?.upstreamDetail[upstream];
  const status = meta?.upstreamStatus[upstream]?.status;

  const toggleSelect = () => {
    if (selected) {
      onSave({ upstreams: cfg.upstreams.filter((x) => x !== upstream) }, `已移出清单：${upstream}`);
    } else {
      onSave(
        {
          upstreams: [...cfg.upstreams.filter((x) => !cfg.exclude.includes(x)), upstream],
          exclude: cfg.exclude.filter((x) => x !== upstream),
        },
        `已加入清单（第 ${cfg.upstreams.filter((x) => !cfg.exclude.includes(x)).length + 1} 位）：${upstream}`,
      );
    }
  };
  const toggleExclude = () => {
    if (excluded) {
      onSave({ exclude: cfg.exclude.filter((x) => x !== upstream) }, `已取消排除：${upstream}`);
    } else {
      onSave(
        { upstreams: cfg.upstreams.filter((x) => x !== upstream), exclude: [...cfg.exclude, upstream] },
        `已排除（网关回退也不会用到）：${upstream}`,
      );
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
    onSave({ upstreams: list }, `${upstream} 已调到第 ${j + 1} 位`);
  };

  return (
    <li
      className={`cps-chain-row${drag.isDragging ? ' cps-dragging' : ''}${drag.isDropTarget ? ' cps-drop-target' : ''}`}
      data-state={excluded ? 'excluded' : selected ? 'on' : 'off'}
      onDragOver={
        selected
          ? (e) => {
              e.preventDefault();
              drag.onDragOverRow(order);
            }
          : undefined
      }
      onDrop={
        selected
          ? (e) => {
              e.preventDefault();
              drag.onDropRow(order);
            }
          : undefined
      }
    >
      <span className="cps-chain-node">{selected ? order + 1 : null}</span>
      {selected ? (
        <button
          type="button"
          className="cps-grip"
          draggable
          aria-label="拖拽调整顺序（键盘可用右侧箭头按钮）"
          onDragStart={(e) => {
            e.dataTransfer.effectAllowed = 'move';
            drag.onDragStartRow(order);
          }}
          onDragEnd={() => drag.onDragEndRow()}
        >
          <HolderOutlined />
        </button>
      ) : (
        <span style={{ width: 16 }} />
      )}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <Typography.Text code style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
          {upstream}
        </Typography.Text>
        {detail?.name && (
          <Typography.Text type="secondary" style={{ fontSize: 12 }} ellipsis>
            {detail.name}
            {detail.endpoints !== undefined && detail.endpoints > 1 ? ` ×${detail.endpoints}` : ''}
          </Typography.Text>
        )}
      </div>
      {status ? statusTag(status) : null}
      <Tooltip title="纳入渠道清单：按序号顺序尝试，异常自动顺切">
        <Checkbox checked={selected} disabled={excluded} onChange={toggleSelect}>
          使用
        </Checkbox>
      </Tooltip>
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
      <Tooltip title={excluded ? '取消排除' : '排除：即使网关回退也不使用'}>
        <Button
          size="small"
          type="text"
          icon={<StopOutlined />}
          style={{ color: excluded ? token.colorError : undefined }}
          onClick={toggleExclude}
        />
      </Tooltip>
    </li>
  );
}

export default function Models() {
  const models = useModels();
  const qc = useQueryClient();
  const save = useSaveModelConfig();
  const probe = useProbe();
  const validate = useValidate();
  const test = useTest();
  const fetchOfficial = useFetchOfficial();
  const [fetchNote, setFetchNote] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [modelFilter, setModelFilter] = useState('');
  /** 管线拖拽排序：源行/落点行的 upstreams 索引（null = 未拖拽）。 */
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dragTo, setDragTo] = useState<number | null>(null);

  const rows = models.data?.subscription ?? [];
  const official = models.data?.officialFetch ?? null;
  const current = rows.find((r) => r.id === selectedId) ?? rows[0] ?? null;
  const filteredRows = rows.filter((r) => !modelFilter || r.id.toLowerCase().includes(modelFilter.toLowerCase()));

  const saveConfig = (modelId: string, patch: Partial<PerModelConfig>, note: string) => {
    const currentCfg = rows.find((r) => r.id === modelId)?.config ?? EMPTY_CFG;
    const merged: PerModelConfig = { ...currentCfg, ...patch };
    // 乐观更新：面板立刻反映，onSuccess 的失效会拉回服务端真实状态
    qc.setQueryData<ModelsResponse>(qk.models, (old) =>
      old
        ? { ...old, subscription: old.subscription.map((s) => (s.id === modelId ? { ...s, config: merged } : s)) }
        : old,
    );
    save.mutate({ modelId, config: merged, note });
  };

  // 校验进行中时轮询：服务端每批校验会渐进写入渠道状态，2 秒一拉让进度可见
  useEffect(() => {
    if (!validate.isPending) return;
    const timer = setInterval(() => void qc.invalidateQueries({ queryKey: qk.models }), 2000);
    return () => clearInterval(timer);
  }, [validate.isPending, qc]);

  const cfg = current?.config ?? EMPTY_CFG;
  const meta = current?.meta ?? null;
  const ups = sortedUpstreams(meta);
  /** 管线渲染顺序：链上（按优先级序号）在前，离线（按状态排序）在后。 */
  const chainRows = [...cfg.upstreams.filter((u) => ups.includes(u)), ...ups.filter((u) => !cfg.upstreams.includes(u))];
  const pinIgnored = meta?.pinState === 'ignored';

  const runProbe = (): void => {
    if (!current) return;
    probe.mutate(current.id);
  };
  const runTest = (): void => {
    if (!current) return;
    test.mutate({ model: current.id, upstreams: cfg.upstreams, exclude: cfg.exclude });
  };
  const runValidate = (): void => {
    if (!current) return;
    validate.mutate(current.id);
  };

  /** 拉取官方模型清单（页头按钮与首屏引导共用）。结果回执由 mutation 统一给出。 */
  const runFetchOfficial = (): void => {
    fetchOfficial.mutate(undefined, {
      onSuccess: (r) =>
        setFetchNote(
          r.added.length ? `新增 ${r.added.length} 个：${r.added.join('、')}` : `已是最新（官方 ${r.found} 个）`,
        ),
    });
  };

  return (
    <div>
      <PageHeader
        title="订阅模型"
        desc="先「探测渠道」列出可用渠道，勾选「使用」并排好顺序；「校验」逐渠道体检可用性。"
        actions={
          <Space size={8} wrap>
            <Button icon={<DownloadOutlined />} loading={fetchOfficial.isPending} onClick={runFetchOfficial}>
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

      {models.isError ? (
        <Alert
          type="error"
          showIcon
          message="订阅模型加载失败"
          description="服务可能正在重启；稍候重试，或用状态栏的刷新按钮。"
          action={
            <Button size="small" onClick={() => void models.refetch()}>
              重试
            </Button>
          }
        />
      ) : models.isLoading && !models.data ? (
        <Skeleton active paragraph={{ rows: 8 }} />
      ) : rows.length === 0 ? (
        <Card style={{ maxWidth: 560, margin: '48px auto 0' }}>
          <Typography.Title level={5} style={{ marginTop: 0 }}>
            开始使用
          </Typography.Title>
          <div style={{ display: 'grid', gap: 14 }}>
            <Space size={10}>
              <Tag style={{ margin: 0 }}>第 1 步</Tag>
              <Typography.Text>在「账号池」添加 Cline Pass API Key</Typography.Text>
              <Button
                size="small"
                onClick={() => window.dispatchEvent(new CustomEvent('cps:navigate', { detail: 'accounts' }))}
              >
                去账号池
              </Button>
            </Space>
            <Space size={10}>
              <Tag style={{ margin: 0 }}>第 2 步</Tag>
              <Typography.Text>拉取官方订阅模型清单</Typography.Text>
              <Button size="small" loading={fetchOfficial.isPending} onClick={runFetchOfficial}>
                拉取
              </Button>
            </Space>
            <Space size={10}>
              <Tag style={{ margin: 0 }}>第 3 步</Tag>
              <Typography.Text type="secondary">对模型点「探测渠道」，把可用渠道勾选「使用」</Typography.Text>
            </Space>
          </div>
        </Card>
      ) : (
        <div style={{ display: 'flex', gap: 24, alignItems: 'flex-start' }}>
          {/* 左：模型列表（常驻可见，状态一屏扫完；多项可过滤、超出高度自滚） */}
          <div className="cps-model-list" style={{ flexShrink: 0, position: 'sticky', top: 0 }}>
            <Input
              style={{ marginBottom: 8 }}
              prefix={<SearchOutlined />}
              allowClear
              placeholder="过滤模型…"
              value={modelFilter}
              onChange={(e) => setModelFilter(e.target.value)}
            />
            <div style={{ display: 'grid', gap: 8, maxHeight: 'calc(100vh - 250px)', overflow: 'auto' }}>
              {filteredRows.map((r) => (
                <ModelItem key={r.id} row={r} active={current?.id === r.id} onClick={() => setSelectedId(r.id)} />
              ))}
              {filteredRows.length === 0 && (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  无匹配模型
                </Typography.Text>
              )}
            </div>
          </div>

          {/* 右：详情与渠道配置 */}
          {current && (
            <div style={{ flex: 1, minWidth: 0, display: 'grid', gap: 24 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                <Typography.Title
                  level={4}
                  style={{ margin: 0 }}
                  copyable={{ text: current.id, tooltips: ['复制模型 ID', '已复制'] }}
                >
                  {current.id}
                </Typography.Title>
                {meta?.pinnable && (
                  <Tag color="green">{meta.pipeline === 'planner' ? '规划器 · Vercel' : '直连 · OpenRouter'}</Tag>
                )}
                <Space size={8} style={{ marginLeft: 'auto' }}>
                  <Tooltip title="发一次探针请求：判断网关是否接受钉住参数，并列出该模型的可用渠道">
                    <Button size="small" type="primary" loading={probe.isPending} onClick={runProbe}>
                      探测渠道
                    </Button>
                  </Tooltip>
                  <Tooltip title="按当前配置发一次最小请求，看实际命中哪个渠道">
                    <Button size="small" loading={test.isPending} onClick={runTest}>
                      试发一次
                    </Button>
                  </Tooltip>
                  <Tooltip
                    title={
                      pinIgnored
                        ? '网关已忽略钉住参数：钉不住时每个渠道都会“成功”，校验结果不可信（先重新探测）'
                        : `对清单内每个渠道各发一次最小请求（消耗 ${ups.length} 次最小额度），标注可用 / 限流 / 不可钉`
                    }
                  >
                    <Button
                      size="small"
                      disabled={pinIgnored || ups.length === 0}
                      loading={validate.isPending}
                      onClick={runValidate}
                    >
                      {validate.isPending ? '校验中…' : `校验${ups.length ? ` ${ups.length} 个渠道` : ''}`}
                    </Button>
                  </Tooltip>
                </Space>
              </div>

              {/*
                钉住被网关忽略：一行紧凑提示（此前用 Alert，占掉四行高度，
                把「渠道优先级」挤到首屏之外）。原因放进悬停，需要时再看。
              */}
              {pinIgnored && (
                <Tooltip
                  title={
                    meta?.pinDisabledReason ??
                    '钉住/排除/排序均不生效；勾选仅保留意图，网关恢复执行后自动生效。换个账号或稍后重新探测可能恢复。'
                  }
                >
                  <div className="cps-notice cps-notice-warn">
                    <ExclamationCircleFilled />
                    <span>网关已忽略钉住参数：当前按网关默认路由，勾选与排序暂不生效</span>
                  </div>
                </Tooltip>
              )}

              {/* 元信息行：自由折行，窄窗口下自动换行而不互相挤压 */}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 28px', fontSize: 12 }}>
                {meta?.canonicalSlug && (
                  <span>
                    <Typography.Text type="secondary">背后模型 </Typography.Text>
                    <Typography.Text code style={{ fontSize: 12 }}>
                      {meta.canonicalSlug}
                    </Typography.Text>
                  </span>
                )}
                {meta?.lastProvider && (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <Typography.Text type="secondary">最近命中 </Typography.Text>
                    <Tag color="geekblue" style={{ margin: 0 }}>
                      {meta.lastProvider}
                    </Tag>
                    {meta.lastMs ? (
                      <Typography.Text type="secondary" style={{ fontVariantNumeric: 'tabular-nums' }}>
                        {meta.lastMs}ms
                      </Typography.Text>
                    ) : null}
                  </span>
                )}
                {meta?.tier0?.length ? (
                  <span>
                    <Typography.Text type="secondary">tier-0 </Typography.Text>
                    {meta.tier0.join('、')}
                  </span>
                ) : null}
                <span>
                  <Typography.Text type="secondary">探测 </Typography.Text>
                  {fmtTime(meta?.probedAt)}
                  {meta?.validatedAt ? (
                    <>
                      <Typography.Text type="secondary"> · 校验 </Typography.Text>
                      {fmtTime(meta.validatedAt)}
                    </>
                  ) : null}
                </span>
              </div>

              <section>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                  <Typography.Text strong style={{ fontSize: 14 }}>
                    渠道优先级
                  </Typography.Text>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {ups.length} 个渠道
                  </Typography.Text>
                  <Space size={8} style={{ marginLeft: 'auto' }}>
                    <Button
                      size="small"
                      onClick={() => {
                        const list = ups.filter((u) => !cfg.exclude.includes(u));
                        saveConfig(
                          current.id,
                          { upstreams: list, exclude: cfg.exclude },
                          `已把 ${list.length} 个渠道全部加入清单`,
                        );
                      }}
                    >
                      全部使用
                    </Button>
                    <Button
                      size="small"
                      onClick={() =>
                        saveConfig(current.id, { upstreams: [], exclude: [] }, '已清空渠道清单（改为完全由网关选择）')
                      }
                    >
                      清空清单
                    </Button>
                  </Space>
                </div>
                {ups.length ? (
                  <>
                    <ul className="cps-chain">
                      {chainRows.map((u) => {
                        const rowOrder = cfg.upstreams.indexOf(u);
                        return (
                          <UpstreamRow
                            key={u}
                            upstream={u}
                            cfg={cfg}
                            meta={meta}
                            onSave={(patch, note) => saveConfig(current.id, patch, note)}
                            drag={{
                              isDragging: dragFrom !== null && dragFrom === rowOrder,
                              isDropTarget: dragTo !== null && dragTo === rowOrder && dragFrom !== rowOrder,
                              onDragStartRow: (o) => setDragFrom(o),
                              onDragOverRow: (o) => setDragTo((cur) => (cur === o ? cur : o)),
                              onDropRow: (o) => {
                                if (dragFrom !== null && dragFrom !== o) {
                                  const list = [...cfg.upstreams];
                                  const [item] = list.splice(dragFrom, 1);
                                  if (item) {
                                    list.splice(o, 0, item);
                                    saveConfig(current.id, { upstreams: list }, `${item} 已拖到第 ${o + 1} 位`);
                                  }
                                }
                                setDragFrom(null);
                                setDragTo(null);
                              },
                              onDragEndRow: () => {
                                setDragFrom(null);
                                setDragTo(null);
                              },
                            }}
                          />
                        );
                      })}
                    </ul>
                    <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 12 }}>
                      勾选「使用」的渠道按序号依次尝试，异常自动顺切；标「排除」的渠道即使网关回退也不使用。
                    </Typography.Text>
                  </>
                ) : (
                  <Empty
                    image={Empty.PRESENTED_IMAGE_SIMPLE}
                    description={pinIgnored ? '钉住参数被忽略，渠道清单不可信' : '尚未探测到渠道，点上方「探测渠道」'}
                  />
                )}
              </section>

              <section>
                <Typography.Text strong style={{ fontSize: 14, display: 'block', marginBottom: 12 }}>
                  路由策略
                </Typography.Text>
                <div style={{ display: 'grid', gap: 12 }}>
                  <Space size={12} align="center" wrap>
                    <Typography.Text type="secondary" style={{ width: 72, textAlign: 'right' }}>
                      钉住模式
                    </Typography.Text>
                    <Select
                      style={{ width: 180 }}
                      value={cfg.pinMode}
                      onChange={(v) =>
                        saveConfig(
                          current.id,
                          { pinMode: v },
                          `钉住模式已改为「${v === 'strict' ? '严格钉住' : '优先 + 回退'}」`,
                        )
                      }
                      options={[
                        { value: 'strict', label: '严格钉住' },
                        { value: 'preferred', label: '优先 + 回退' },
                      ]}
                    />
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      严格钉住：只走清单内渠道，网关不听话视为失败并切换；优先 + 回退：仅最后一个候选放开网关选择
                    </Typography.Text>
                  </Space>
                  <Space size={12} align="center" wrap>
                    <Typography.Text type="secondary" style={{ width: 72, textAlign: 'right' }}>
                      渠道排序
                    </Typography.Text>
                    <Select
                      style={{ width: 180 }}
                      value={cfg.sort ?? ''}
                      onChange={(v) => {
                        const label = { '': '网关智能选', cost: '最低成本', ttft: '最快首字', tps: '最高吞吐' }[v] ?? v;
                        saveConfig(
                          current.id,
                          { sort: (v || null) as SortKey | null },
                          `渠道排序偏好已改为「${label}」`,
                        );
                      }}
                      options={[
                        { value: '', label: '网关智能选' },
                        { value: 'cost', label: '最低成本' },
                        { value: 'ttft', label: '最快首字' },
                        { value: 'tps', label: '最高吞吐' },
                      ]}
                    />
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      多个可用渠道之间的执行顺序偏好
                    </Typography.Text>
                  </Space>
                </div>
              </section>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

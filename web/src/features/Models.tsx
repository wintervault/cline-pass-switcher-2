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
import { Alert, Button, Card, Checkbox, Empty, Input, Skeleton, Space, Tag, Tooltip, Typography, theme } from 'antd';
import { useEffect, useState } from 'react';
import { qk, useFetchOfficial, useModels, useProbe, useSaveModelConfig, useTest, useValidate } from '../api/hooks.ts';
import {
  type ModelMeta,
  type ModelsResponse,
  type PerModelConfig,
  STATUS_RANK,
  STATUS_TAG,
  type SubscriptionRow,
  type UpstreamStatusKind,
} from '../api/types.ts';
import { PageHeader } from '../pageHeader.tsx';
import { Panel, PanelHint } from '../panel.tsx';
import { RoutingFields } from './routingFields.tsx';

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

/**
 * 左侧模型列表项。
 *
 * 版式压到最少行数：**第一行 = 模型 ID + 状态**，第二行只在真有信息时才出现
 * （使用数 / 最近路由）。原来状态永远独占一行，18 个模型里一屏只看得到 4 个。
 */
function ModelItem({
  row,
  prefix,
  active,
  onClick,
}: {
  row: SubscriptionRow;
  /** 列表里所有模型共有的前缀（如 `cline-pass/`）——显示时去掉，完整 ID 进悬停 */
  prefix: string;
  active: boolean;
  onClick: () => void;
}) {
  const { token } = theme.useToken();
  const meta = row.meta;
  const cfg = row.config ?? EMPTY_CFG;
  const probed = (meta?.upstreams?.length ?? 0) > 0;
  const ignored = meta?.pinState === 'ignored';
  const hasSecondLine = cfg.upstreams.length > 0 || cfg.exclude.length > 0 || !!meta?.lastProvider;
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
        padding: '10px 12px',
        display: 'grid',
        gap: 6,
        font: 'inherit',
        width: '100%',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
        <Tooltip title={row.id}>
          <span className="cps-mono cps-cell-ellipsis" style={{ flex: 1, minWidth: 0 }}>
            {row.id.slice(prefix.length)}
          </span>
        </Tooltip>
        {/* 状态跟着 ID 同行：它是扫读这一列时最需要看到的东西 */}
        {ignored ? (
          <Tag color="red" style={{ margin: 0, flex: '0 0 auto' }}>
            参数被忽略
          </Tag>
        ) : probed ? (
          <Tag color="geekblue" style={{ margin: 0, flex: '0 0 auto' }}>
            {meta?.upstreams?.length ?? 0} 渠道
          </Tag>
        ) : (
          <Typography.Text type="secondary" style={{ fontSize: 12, flex: '0 0 auto' }}>
            未探测
          </Typography.Text>
        )}
      </div>
      {hasSecondLine && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          {cfg.upstreams.length > 0 && (
            <Tag color="blue" style={{ margin: 0, flex: '0 0 auto' }}>
              使用 {cfg.upstreams.length}
            </Tag>
          )}
          {cfg.exclude.length > 0 && (
            <Tag color="red" style={{ margin: 0, flex: '0 0 auto' }}>
              排除 {cfg.exclude.length}
            </Tag>
          )}
          {meta?.lastProvider && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }} className="cps-cell-ellipsis">
              最近 {meta.lastProvider}
              {meta.lastMs ? ` · ${meta.lastMs}ms` : ''}
            </Typography.Text>
          )}
        </div>
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
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [modelFilter, setModelFilter] = useState('');
  /** 管线拖拽排序：源行/落点行的 upstreams 索引（null = 未拖拽）。 */
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dragTo, setDragTo] = useState<number | null>(null);

  const rows = models.data?.subscription ?? [];
  const official = models.data?.officialFetch ?? null;
  const current = rows.find((r) => r.id === selectedId) ?? rows[0] ?? null;
  const filteredRows = rows.filter((r) => !modelFilter || r.id.toLowerCase().includes(modelFilter.toLowerCase()));

  /**
   * 列表里所有模型共有的 `xxx/` 前缀。订阅模型的 ID 全都是同一个前缀
   * （如 `cline-pass/`），列在每一行里纯属噪音、还挤掉了真正的区分部分
   * （「模型显示不全」）。去掉它，完整 ID 仍在悬停与右侧面板标题里。
   */
  const sharedPrefix = (() => {
    if (rows.length === 0) return '';
    const first = rows[0]?.id ?? '';
    const slash = first.indexOf('/');
    if (slash <= 0) return '';
    const candidate = first.slice(0, slash + 1);
    return rows.every((r) => r.id.startsWith(candidate)) ? candidate : '';
  })();

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

  /** 拉取官方模型清单（页头按钮与首屏引导共用）。结果回执由 mutation 统一给气泡。 */
  const runFetchOfficial = (): void => {
    fetchOfficial.mutate(undefined);
  };

  return (
    /* 填满内容列：两栏吃满剩余高度，路由策略贴底，底部只留内容区内边距。
       之前用 calc(100vh - 448px) 的魔法数字，默认窗口下会空出 97px（实测）。 */
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, height: '100%' }}>
      <PageHeader
        title="订阅模型"
        desc="先「探测渠道」列出可用渠道，勾选「使用」并排好顺序；「校验」逐渠道体检可用性。"
        actions={
          /* 页头只放主操作。上次拉取的时间与来源塞进悬停——
             原来它们是一长串内联文字，会把页头挤成两行，于是本页的区块比别的页
             低 40px（切页时「布局偏移」的一部分）。 */
          <Tooltip
            title={
              official
                ? `上次拉取：${new Date(official.ts).toLocaleString()}（来源 ${official.sources.join(' + ')}，新增 ${official.added.length}）`
                : '还没有拉取过官方清单'
            }
          >
            <Button icon={<DownloadOutlined />} loading={fetchOfficial.isPending} onClick={runFetchOfficial}>
              拉取官方最新模型
            </Button>
          </Tooltip>
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
        /* 用 Fragment 而不是再包一层 div：页面根已经是 flex 列容器，
           多一层不带 flex 的 div 会把「剩余高度」截断在那里，两栏就只涨到
           minHeight（实测 300，底部空 185px）。区块直接作为页面根的子元素。 */
        <>
          {/*
            两列主体：**吃满剩余高度、各自内部滚动**。
            页面本身不滚（右侧那条多余的滚动条随之消失），路由策略贴底整行。
            高度不再用「扣掉固定件」的魔法数字——页头/路由策略的尺寸一变它就失准；
            现在由父级 flex 分配，底部只剩内容区的内边距。
          */}
          <div style={{ display: 'flex', gap: 16, flex: '1 1 0', minHeight: 300 }}>
            {/* 左：模型列表（区域一） */}
            <Panel
              title="模型列表"
              extra={<PanelHint>{filteredRows.length} 个</PanelHint>}
              style={{ width: 292, flex: '0 0 292px' }}
            >
              <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, gap: 8 }}>
                <Input
                  prefix={<SearchOutlined />}
                  allowClear
                  placeholder="过滤模型…"
                  value={modelFilter}
                  onChange={(e) => setModelFilter(e.target.value)}
                />
                {/* 唯一的滚动容器：只有列表滚，搜索框钉在上面 */}
                <div
                  className="cps-model-list-scroll"
                  style={{ flex: 1, minHeight: 0, display: 'grid', gap: 6, alignContent: 'start' }}
                >
                  {filteredRows.map((r) => (
                    <ModelItem
                      key={r.id}
                      row={r}
                      prefix={sharedPrefix}
                      active={current?.id === r.id}
                      onClick={() => setSelectedId(r.id)}
                    />
                  ))}
                  {filteredRows.length === 0 && (
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      无匹配模型
                    </Typography.Text>
                  )}
                </div>
              </div>
            </Panel>

            {/* 右：所选模型的渠道清单（区域二） */}
            {current && (
              <Panel
                style={{ flex: 1, minWidth: 0 }}
                title={
                  <>
                    <Typography.Text
                      code
                      style={{ fontSize: 13 }}
                      copyable={{ text: current.id, tooltips: ['复制模型 ID', '已复制'] }}
                    >
                      {current.id}
                    </Typography.Text>
                    {meta?.pinnable && (
                      <Tag color="green" style={{ margin: 0 }}>
                        {meta.pipeline === 'planner' ? '规划器 · Vercel' : '直连 · OpenRouter'}
                      </Tag>
                    )}
                  </>
                }
                extra={
                  <Space size={8}>
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
                        {validate.isPending ? '校验中…' : '校验'}
                      </Button>
                    </Tooltip>
                  </Space>
                }
              >
                <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, gap: 12 }}>
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

                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: '0 0 auto' }}>
                    <Typography.Text strong style={{ fontSize: 13 }}>
                      渠道优先级
                    </Typography.Text>
                    <PanelHint>{ups.length} 个渠道</PanelHint>
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
                  {/* 渠道链自己滚：右栏唯一的滚动条（列表长，但不该带着整页一起滚） */}
                  <div style={{ flex: 1, minHeight: 0, overflow: 'auto', overscrollBehavior: 'contain' }}>
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
                        description={
                          pinIgnored ? '钉住参数被忽略，渠道清单不可信' : '尚未探测到渠道，点上方「探测渠道」'
                        }
                      />
                    )}
                  </div>
                </div>
              </Panel>
            )}
          </div>

          {/* 路由策略：整行放在两列之下 —— 右侧那一列因此不再需要任何外层滚动条 */}
          {current && (
            <Panel title="路由策略" extra={<PanelHint>改动即时保存</PanelHint>}>
              <RoutingFields cfg={cfg} onChange={(patch, note) => saveConfig(current.id, patch, note)} />
            </Panel>
          )}
        </>
      )}
    </div>
  );
}

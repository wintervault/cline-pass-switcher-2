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
  type SubscriptionRow,
  type UpstreamStatusKind,
} from '../api/types.ts';
import { GatewaySwitcher, useGatewayScope } from '../gatewayScope.tsx';
import { type Lang, type MsgKey, useI18n, useT } from '../i18n/index.tsx';
import { STATUS_TAG } from '../labels.ts';
import { PageHeader } from '../pageHeader.tsx';
import { Panel, PanelHint } from '../panel.tsx';
import { RoutingFields } from './routingFields.tsx';

const EMPTY_CFG: PerModelConfig = { upstreams: [], exclude: [], pinMode: 'strict', sort: null };

/** 按校验状态排序的渠道列表（可用优先），供详情面板与测试台共用。 */
export function sortedUpstreams(meta: ModelMeta | null): string[] {
  const statusOf = (u: string): UpstreamStatusKind => meta?.upstreamStatus[u]?.status ?? 'unknown';
  return [...(meta?.upstreams ?? [])].sort((a, b) => (STATUS_RANK[statusOf(a)] ?? 2) - (STATUS_RANK[statusOf(b)] ?? 2));
}

const statusTag = (kind: UpstreamStatusKind, t: (key: MsgKey) => string) => {
  const s = STATUS_TAG[kind];
  return <Tag color={s.color}>{t(s.labelKey)}</Tag>;
};

const fmtTime = (ts: number | null | undefined, lang: Lang): string =>
  ts
    ? new Date(ts).toLocaleString(lang, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
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
  const { t } = useI18n();
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
            {t('models.tag.ignored')}
          </Tag>
        ) : probed ? (
          <Tag color="geekblue" style={{ margin: 0, flex: '0 0 auto' }}>
            {t('models.tag.channels', { count: meta?.upstreams?.length ?? 0 })}
          </Tag>
        ) : (
          <Typography.Text type="secondary" style={{ fontSize: 12, flex: '0 0 auto' }}>
            {t('models.tag.untested')}
          </Typography.Text>
        )}
      </div>
      {hasSecondLine && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          {cfg.upstreams.length > 0 && (
            <Tag color="blue" style={{ margin: 0, flex: '0 0 auto' }}>
              {t('models.tag.using', { count: cfg.upstreams.length })}
            </Tag>
          )}
          {cfg.exclude.length > 0 && (
            <Tag color="red" style={{ margin: 0, flex: '0 0 auto' }}>
              {t('models.tag.excluded', { count: cfg.exclude.length })}
            </Tag>
          )}
          {meta?.lastProvider && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }} className="cps-cell-ellipsis">
              {t('models.item.last', {
                provider: meta.lastProvider,
                suffix: meta.lastMs ? t('models.item.lastSuffix', { ms: meta.lastMs }) : '',
              })}
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
  const t = useT();
  const selected = cfg.upstreams.includes(upstream);
  const excluded = cfg.exclude.includes(upstream);
  const order = cfg.upstreams.indexOf(upstream);
  const detail = meta?.upstreamDetail[upstream];
  const status = meta?.upstreamStatus[upstream]?.status;

  const toggleSelect = () => {
    if (selected) {
      onSave(
        { upstreams: cfg.upstreams.filter((x) => x !== upstream) },
        t('models.note.unselected', { name: upstream }),
      );
    } else {
      onSave(
        {
          upstreams: [...cfg.upstreams.filter((x) => !cfg.exclude.includes(x)), upstream],
          exclude: cfg.exclude.filter((x) => x !== upstream),
        },
        t('models.note.selected', {
          index: cfg.upstreams.filter((x) => !cfg.exclude.includes(x)).length + 1,
          name: upstream,
        }),
      );
    }
  };
  const toggleExclude = () => {
    if (excluded) {
      onSave({ exclude: cfg.exclude.filter((x) => x !== upstream) }, t('models.note.unexcluded', { name: upstream }));
    } else {
      onSave(
        { upstreams: cfg.upstreams.filter((x) => x !== upstream), exclude: [...cfg.exclude, upstream] },
        t('models.note.excluded', { name: upstream }),
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
    onSave({ upstreams: list }, t('models.note.moved', { name: upstream, index: j + 1 }));
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
          aria-label={t('models.upstream.drag.aria')}
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
      {status ? statusTag(status, t) : null}
      <Tooltip title={t('models.upstream.use.tip')}>
        <Checkbox checked={selected} disabled={excluded} onChange={toggleSelect}>
          {t('models.upstream.use')}
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
      <Tooltip title={excluded ? t('models.upstream.unexclude.tip') : t('models.upstream.exclude.tip')}>
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
  const { gatewayId } = useGatewayScope();
  const { t, lang } = useI18n();
  const models = useModels(gatewayId);
  const qc = useQueryClient();
  const save = useSaveModelConfig(gatewayId);
  const probe = useProbe(gatewayId);
  const validate = useValidate(gatewayId);
  const test = useTest(gatewayId);
  const fetchOfficial = useFetchOfficial(gatewayId);
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
    qc.setQueryData<ModelsResponse>(qk.models(gatewayId), (old) =>
      old
        ? { ...old, subscription: old.subscription.map((s) => (s.id === modelId ? { ...s, config: merged } : s)) }
        : old,
    );
    save.mutate({ modelId, config: merged, note });
  };

  // 校验进行中时轮询：服务端每批校验会渐进写入渠道状态，2 秒一拉让进度可见
  useEffect(() => {
    if (!validate.isPending) return;
    const timer = setInterval(() => void qc.invalidateQueries({ queryKey: qk.models(gatewayId) }), 2000);
    return () => clearInterval(timer);
  }, [validate.isPending, qc, gatewayId]);

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
        title={t('models.title')}
        desc={t('models.desc')}
        actions={
          /* 页头只放主操作。上次拉取的时间与来源塞进悬停——
             原来它们是一长串内联文字，会把页头挤成两行，于是本页的区块比别的页
             低 40px（切页时「布局偏移」的一部分）。 */
          <Space size={8}>
            <GatewaySwitcher />
            <Tooltip
              title={
                official
                  ? t('models.official.last', {
                      time: new Date(official.ts).toLocaleString(lang),
                      sources: official.sources.join(' + '),
                      added: official.added.length,
                    })
                  : t('models.official.none')
              }
            >
              <Button icon={<DownloadOutlined />} loading={fetchOfficial.isPending} onClick={runFetchOfficial}>
                {t('models.pull')}
              </Button>
            </Tooltip>
          </Space>
        }
      />

      {models.isError ? (
        <Alert
          type="error"
          showIcon
          message={t('models.loadFailed')}
          description={t('models.loadFailed.desc')}
          action={
            <Button size="small" onClick={() => void models.refetch()}>
              {t('common.retry')}
            </Button>
          }
        />
      ) : models.isLoading && !models.data ? (
        <Skeleton active paragraph={{ rows: 8 }} />
      ) : rows.length === 0 ? (
        <Card style={{ maxWidth: 560, margin: '48px auto 0' }}>
          <Typography.Title level={5} style={{ marginTop: 0 }}>
            {t('models.onboarding.title')}
          </Typography.Title>
          <div style={{ display: 'grid', gap: 14 }}>
            <Space size={10}>
              <Tag style={{ margin: 0 }}>{t('models.onboarding.step', { index: 1 })}</Tag>
              <Typography.Text>{t('models.onboarding.step1')}</Typography.Text>
              <Button
                size="small"
                onClick={() => window.dispatchEvent(new CustomEvent('cps:navigate', { detail: 'accounts' }))}
              >
                {t('models.onboarding.step1.action')}
              </Button>
            </Space>
            <Space size={10}>
              <Tag style={{ margin: 0 }}>{t('models.onboarding.step', { index: 2 })}</Tag>
              <Typography.Text>{t('models.onboarding.step2')}</Typography.Text>
              <Button size="small" loading={fetchOfficial.isPending} onClick={runFetchOfficial}>
                {t('models.onboarding.step2.action')}
              </Button>
            </Space>
            <Space size={10}>
              <Tag style={{ margin: 0 }}>{t('models.onboarding.step', { index: 3 })}</Tag>
              <Typography.Text type="secondary">{t('models.onboarding.step3')}</Typography.Text>
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
              title={t('models.list.title')}
              extra={<PanelHint>{t('common.count', { count: filteredRows.length })}</PanelHint>}
              style={{ width: 292, flex: '0 0 292px' }}
            >
              <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, gap: 8 }}>
                <Input
                  prefix={<SearchOutlined />}
                  allowClear
                  placeholder={t('models.list.filter')}
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
                      {t('models.list.noMatch')}
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
                      copyable={{ text: current.id, tooltips: [t('models.detail.copyId'), t('common.copied')] }}
                    >
                      {current.id}
                    </Typography.Text>
                    {meta?.pinnable && (
                      <Tag color="green" style={{ margin: 0 }}>
                        {meta.pipeline === 'planner' ? t('models.pipeline.planner') : t('models.pipeline.direct')}
                      </Tag>
                    )}
                  </>
                }
                extra={
                  <Space size={8}>
                    <Tooltip title={t('models.action.probe.tip')}>
                      <Button size="small" type="primary" loading={probe.isPending} onClick={runProbe}>
                        {t('models.action.probe')}
                      </Button>
                    </Tooltip>
                    <Tooltip title={t('models.action.test.tip')}>
                      <Button size="small" loading={test.isPending} onClick={runTest}>
                        {t('models.action.test')}
                      </Button>
                    </Tooltip>
                    <Tooltip
                      title={
                        pinIgnored
                          ? t('models.action.validate.tip.ignored')
                          : t('models.action.validate.tip', { count: ups.length })
                      }
                    >
                      <Button
                        size="small"
                        disabled={pinIgnored || ups.length === 0}
                        loading={validate.isPending}
                        onClick={runValidate}
                      >
                        {validate.isPending ? t('models.action.validating') : t('models.action.validate')}
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
                        meta?.lastProvider
                          ? `${t('models.pin.ignored.tip')} ${t('models.pin.ignored.routed', { provider: meta.lastProvider })}`
                          : t('models.pin.ignored.tip')
                      }
                    >
                      <div className="cps-notice cps-notice-warn">
                        <ExclamationCircleFilled />
                        <span>{t('models.pin.ignored.notice')}</span>
                      </div>
                    </Tooltip>
                  )}

                  {/* 元信息行：自由折行，窄窗口下自动换行而不互相挤压 */}
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 28px', fontSize: 12 }}>
                    {meta?.canonicalSlug && (
                      <span>
                        <Typography.Text type="secondary">{t('models.meta.canonical')} </Typography.Text>
                        <Typography.Text code style={{ fontSize: 12 }}>
                          {meta.canonicalSlug}
                        </Typography.Text>
                      </span>
                    )}
                    {meta?.lastProvider && (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        <Typography.Text type="secondary">{t('models.meta.lastHit')} </Typography.Text>
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
                        <Typography.Text type="secondary">{t('models.meta.tier0')} </Typography.Text>
                        {meta.tier0.join(t('models.meta.listSeparator'))}
                      </span>
                    ) : null}
                    <span>
                      <Typography.Text type="secondary">{t('models.meta.probed')} </Typography.Text>
                      {fmtTime(meta?.probedAt, lang)}
                      {meta?.validatedAt ? (
                        <>
                          <Typography.Text type="secondary">{t('models.meta.validated')} </Typography.Text>
                          {fmtTime(meta.validatedAt, lang)}
                        </>
                      ) : null}
                    </span>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: '0 0 auto' }}>
                    <Typography.Text strong style={{ fontSize: 13 }}>
                      {t('models.chain.title')}
                    </Typography.Text>
                    <PanelHint>{t('models.chain.count', { count: ups.length })}</PanelHint>
                    <Space size={8} style={{ marginLeft: 'auto' }}>
                      <Button
                        size="small"
                        onClick={() => {
                          const list = ups.filter((u) => !cfg.exclude.includes(u));
                          saveConfig(
                            current.id,
                            { upstreams: list, exclude: cfg.exclude },
                            t('models.note.allAdded', { count: list.length }),
                          );
                        }}
                      >
                        {t('models.chain.all')}
                      </Button>
                      <Button
                        size="small"
                        onClick={() => saveConfig(current.id, { upstreams: [], exclude: [] }, t('models.note.cleared'))}
                      >
                        {t('models.chain.clear')}
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
                                        saveConfig(
                                          current.id,
                                          { upstreams: list },
                                          t('models.note.dragged', { name: item, index: o + 1 }),
                                        );
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
                          {t('models.chain.footer')}
                        </Typography.Text>
                      </>
                    ) : (
                      <Empty
                        image={Empty.PRESENTED_IMAGE_SIMPLE}
                        description={pinIgnored ? t('models.chain.emptyIgnored') : t('models.chain.empty')}
                      />
                    )}
                  </div>
                </div>
              </Panel>
            )}
          </div>

          {/* 路由策略：整行放在两列之下 —— 右侧那一列因此不再需要任何外层滚动条 */}
          {current && (
            <Panel title={t('models.routing.title')} extra={<PanelHint>{t('models.routing.hint')}</PanelHint>}>
              <RoutingFields cfg={cfg} onChange={(patch, note) => saveConfig(current.id, patch, note)} />
            </Panel>
          )}
        </>
      )}
    </div>
  );
}

import {
  CopyOutlined,
  ExclamationCircleFilled,
  InfoCircleOutlined,
  PlayCircleOutlined,
  SettingOutlined,
} from '@ant-design/icons';
import {
  Alert,
  Badge,
  Button,
  Descriptions,
  InputNumber,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import { useState } from 'react';

import { useModels, useSaveModelConfig, useTest } from '../api/hooks.ts';
import type { ModelMeta, PerModelConfig, TestResult, TraceEntry } from '../api/types.ts';
import { useFeedback } from '../feedback.ts';
import { GatewaySwitcher, useGatewayScope } from '../gatewayScope.tsx';
import { useI18n, useT } from '../i18n/index.tsx';
import { STATUS_TAG } from '../labels.ts';
import { PageHeader } from '../pageHeader.tsx';
import { Panel, PanelHint } from '../panel.tsx';
import { RoutingFields } from './routingFields.tsx';

/**
 * 当前路由策略面板。
 *
 * 测试台要回答的问题是「这个模型现在会怎么走」——钉住模式、渠道顺序、每个
 * 候选的可用性必须和「发送测试」同屏可见，否则测完还得滚回去对答案。
 * 改动即时保存（与订阅模型页同一套配置，改哪边都生效）。
 */
function RoutingPanel({ model, cfg, meta }: { model: string; cfg: PerModelConfig; meta: ModelMeta | null }) {
  const { gatewayId } = useGatewayScope();
  const t = useT();
  const save = useSaveModelConfig(gatewayId);

  const patch = (next: Partial<PerModelConfig>, note: string): void => {
    save.mutate({ modelId: model, config: { ...cfg, ...next }, note });
  };

  const order = cfg.upstreams;
  const rows = order.map((name, i) => ({
    key: name,
    index: i + 1,
    name,
    status: meta?.upstreamStatus?.[name],
    detail: meta?.upstreamDetail?.[name],
    enabled: !cfg.exclude.includes(name),
  }));

  return (
    <Panel
      title={
        <Space size={8}>
          <SettingOutlined />
          <span>{t('playground.routing.title')}</span>
          <Typography.Text type="secondary" style={{ fontSize: 12, fontWeight: 400 }}>
            {cfg.pinMode === 'strict' ? t('playground.routing.strict') : t('playground.routing.preferred')}
          </Typography.Text>
        </Space>
      }
    >
      <RoutingFields cfg={cfg} onChange={patch} />
      {rows.length === 0 ? (
        <div className="cps-notice" style={{ marginTop: 12 }}>
          <ExclamationCircleFilled style={{ color: 'var(--ant-color-warning-text)' }} />
          <span>{t('playground.routing.empty')}</span>
        </div>
      ) : (
        <Table
          size="small"
          rowKey="key"
          pagination={false}
          dataSource={rows}
          columns={[
            {
              title: t('playground.col.order'),
              width: 64,
              render: (_, r) => (
                <Typography.Text
                  type={r.enabled ? undefined : 'secondary'}
                  style={{ fontVariantNumeric: 'tabular-nums' }}
                >
                  {r.index}
                </Typography.Text>
              ),
            },
            {
              title: t('playground.col.channel'),
              dataIndex: 'name',
              render: (v: string, r) => (
                <Space size={6}>
                  <Typography.Text
                    code
                    copyable={{ text: v, tooltips: [t('playground.copyChannel'), t('common.copied')] }}
                    style={r.enabled ? undefined : { opacity: 0.5 }}
                  >
                    {v}
                  </Typography.Text>
                  {r.detail?.context ? (
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {t('playground.channel.context', { k: Math.round(r.detail.context / 1000) })}
                    </Typography.Text>
                  ) : null}
                </Space>
              ),
            },
            {
              title: t('playground.col.health'),
              width: 130,
              render: (_, r) => {
                const s = r.status;
                if (!s) return <Typography.Text type="secondary">{t('labels.upstream.unknown')}</Typography.Text>;
                const tag = STATUS_TAG[s.status];
                return (
                  <Tooltip title={s.note ?? undefined}>
                    <Tag color={tag.color} style={{ margin: 0 }}>
                      {t(tag.labelKey)}
                    </Tag>
                  </Tooltip>
                );
              },
            },
            {
              title: t('playground.col.lastMs'),
              width: 104,
              align: 'right',
              /* 来自「校验渠道」的实测往返（那是小请求，只用于渠道之间的相对比较）。
                 以前这里恒为「—」——列头写着耗时却没有数据，等于没有这一列。 */
              render: (_, r) =>
                r.status?.ms != null ? (
                  <Typography.Text className="cps-num">{r.status.ms} ms</Typography.Text>
                ) : (
                  <Typography.Text type="secondary">—</Typography.Text>
                ),
            },
            {
              title: t('playground.col.enabled'),
              width: 88,
              render: (_, r) => (
                <Switch
                  size="small"
                  checked={r.enabled}
                  loading={save.isPending}
                  onChange={(v) =>
                    patch(
                      { exclude: v ? cfg.exclude.filter((x) => x !== r.name) : [...cfg.exclude, r.name] },
                      v
                        ? t('playground.note.enabled', { name: r.name })
                        : t('playground.note.excluded', { name: r.name }),
                    )
                  }
                />
              ),
            },
          ]}
        />
      )}
    </Panel>
  );
}

function TraceTable({ trace, targets }: { trace?: TraceEntry[]; targets: string[] }) {
  const t = useT();
  const list = trace ?? [];
  if (!list.length) {
    return (
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {targets.length
          ? t('playground.trace.emptyTargets', { targets: targets.join(' → ') })
          : t('playground.trace.empty')}
      </Typography.Text>
    );
  }
  return (
    <Table<TraceEntry>
      className="cps-table-center"
      size="small"
      rowKey={(r, i) => `${r.upstream ?? 'auto'}-${i}`}
      pagination={false}
      dataSource={list}
      columns={[
        {
          title: t('playground.col.order'),
          width: 64,
          render: (_, __, i) => (
            <Typography.Text type="secondary" className="cps-num">
              {i + 1}
            </Typography.Text>
          ),
        },
        {
          title: t('playground.col.channel'),
          dataIndex: 'upstream',
          render: (v: string | null) =>
            v ? (
              <span className="cps-mono">{v}</span>
            ) : (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {t('playground.trace.auto')}
              </Typography.Text>
            ),
        },
        {
          title: t('playground.col.result'),
          width: 120,
          render: (_, r) => (
            <Badge status={r.status === 200 ? 'success' : 'error'} text={t('playground.http', { status: r.status })} />
          ),
        },
        {
          title: t('playground.col.lastMs'),
          width: 100,
          render: (_, r) => <Typography.Text className="cps-num">{r.ms} ms</Typography.Text>,
        },
        {
          title: t('playground.col.note'),
          dataIndex: 'note',
          render: (v: string) =>
            v ? (
              <span className="cps-cell-ellipsis" style={{ fontSize: 12 }}>
                {v}
              </span>
            ) : (
              <Typography.Text type="secondary">—</Typography.Text>
            ),
        },
      ]}
    />
  );
}

export default function Playground() {
  const { gatewayId } = useGatewayScope();
  const { t } = useI18n();
  const models = useModels(gatewayId);
  const test = useTest(gatewayId);
  const fb = useFeedback();
  const [model, setModel] = useState('');
  const [upstream, setUpstream] = useState('');
  const [maxTokens, setMaxTokens] = useState(256);
  const [result, setResult] = useState<TestResult | null>(null);

  const rows = models.data?.subscription ?? [];
  const active = model || rows[0]?.id || '';
  const activeRow = rows.find((r) => r.id === active);
  const cfg: PerModelConfig = activeRow?.config ?? { upstreams: [], exclude: [], pinMode: 'preferred', sort: null };

  const upstreamOptions = [
    { value: '', label: t('playground.field.channel.auto') },
    ...cfg.upstreams.map((u) => ({ value: u, label: u })),
  ];

  const run = (): void => {
    if (!active) {
      fb.fail(t('playground.validate.key'));
      return;
    }
    // 成功/失败的回执由 useTest 统一给出，这里只负责把结果放进结果区
    test.mutate({ model: active, upstreams: upstream ? [upstream] : [], exclude: [] }, { onSuccess: setResult });
  };

  const hit =
    result?.ok &&
    (!result.targets.length || result.actual === result.targets[0] || result.actualName === result.targets[0]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <PageHeader title={t('playground.title')} desc={t('playground.desc')} actions={<GatewaySwitcher />} />

      <Panel title={t('playground.params.title')} extra={<PanelHint>{t('playground.params.hint')}</PanelHint>}>
        <Space wrap size={16} align="center">
          <Space size={6} align="center">
            <Typography.Text type="secondary" style={{ fontSize: 13 }}>
              {t('playground.field.model')}
            </Typography.Text>
            <Select
              showSearch
              /* 280 而不是 320：这一行的控件在 890 宽的内容列里必须排成一行。
                 放不下就会折成两行，整页凭空长高 48px——正好把「不出现纵向滚动条」
                 的余量吃掉。 */
              style={{ width: 280, fontFamily: 'var(--cps-font-mono)' }}
              placeholder={t('playground.field.model.placeholder')}
              value={active || undefined}
              onChange={(v) => {
                setModel(v);
                setUpstream('');
                setResult(null);
              }}
              options={rows.map((r) => ({ value: r.id, label: r.id }))}
            />
          </Space>
          <Space size={6} align="center">
            <Typography.Text type="secondary" style={{ fontSize: 13 }}>
              {t('playground.field.channel')}
            </Typography.Text>
            <Select style={{ width: 200 }} value={upstream} onChange={setUpstream} options={upstreamOptions} />
          </Space>
          <Space size={6} align="center">
            <Tooltip title={t('playground.field.maxTokens.tip')}>
              <Typography.Text type="secondary" style={{ fontSize: 13 }}>
                {t('playground.field.maxTokens')}
              </Typography.Text>
            </Tooltip>
            <InputNumber
              min={16}
              max={4096}
              step={64}
              value={maxTokens}
              onChange={(v) => setMaxTokens(v ?? 256)}
              style={{ width: 104 }}
            />
          </Space>
          <Button
            type="primary"
            icon={<PlayCircleOutlined />}
            loading={test.isPending}
            onClick={run}
            style={{ marginLeft: 'auto' }}
          >
            {t('playground.send')}
          </Button>
        </Space>
      </Panel>

      {active && <RoutingPanel model={active} cfg={cfg} meta={activeRow?.meta ?? null} />}

      {/* 结果区：始终在位（空态也属于这块区域），避免「点完才长出一块」的跳动 */}
      <Panel
        title={
          result ? (
            <Space size={8}>
              {result.ok ? (
                <Tag color="green">{t('playground.result.success')}</Tag>
              ) : (
                <Tag color="red">{t('playground.result.failed')}</Tag>
              )}
              <Typography.Text code style={{ fontSize: 13 }}>
                {active}
              </Typography.Text>
              {result.ok && (
                <Tag color={hit ? 'green' : 'orange'}>
                  {hit ? t('playground.result.hit') : t('playground.result.miss')}
                </Tag>
              )}
              {result.degraded && (
                <Tooltip title={t('playground.result.degraded.tip')}>
                  <Tag color="gold">{t('playground.result.degraded')}</Tag>
                </Tooltip>
              )}
            </Space>
          ) : (
            <span>{t('playground.result.title')}</span>
          )
        }
        extra={
          result ? (
            <Tooltip title={t('playground.result.copy.tip')}>
              <Button
                size="small"
                type="text"
                icon={<CopyOutlined />}
                aria-label={t('playground.result.copy')}
                onClick={() =>
                  void navigator.clipboard.writeText(JSON.stringify(result, null, 2)).then(
                    () => fb.copy(t('playground.result.title')),
                    () => fb.fail(t('common.copyFailed'), t('common.clipboardUnavailable')),
                  )
                }
              />
            </Tooltip>
          ) : undefined
        }
      >
        {!result ? (
          /* 空态压成一行。占满一块的 antd Empty（大插图 + 两行字）让这一页在
             默认窗口下几乎顶到滚动条——空态本来只是「还没测过」这一句，
             没有资格占掉一百多像素。 */
          <div className="cps-notice">
            <InfoCircleOutlined style={{ color: 'var(--ant-color-text-tertiary)' }} />
            <span>{t('playground.result.empty')}</span>
          </div>
        ) : !result.ok ? (
          <Alert
            type="error"
            showIcon
            message={t('playground.result.error', { error: result.error ?? t('playground.result.unknownError') })}
          />
        ) : (
          <div style={{ display: 'grid', gap: 16 }}>
            <Descriptions
              size="small"
              column={3}
              items={[
                {
                  key: 'actual',
                  label: t('playground.desc.actual'),
                  children: result.actual ?? result.actualName ?? '—',
                },
                {
                  key: 'ms',
                  label: t('playground.desc.ms'),
                  children: result.ms != null ? t('common.ms', { value: result.ms }) : '—',
                },
                { key: 'account', label: t('playground.desc.account'), children: result.account ?? '—' },
                {
                  key: 'targets',
                  label: t('playground.desc.targets'),
                  children: result.targets.length ? result.targets.join(' → ') : t('playground.desc.targets.auto'),
                },
                {
                  key: 'pipeline',
                  label: t('playground.desc.pipeline'),
                  children: result.pipeline ? `/${result.pipeline}` : t('playground.desc.pipeline.unknown'),
                },
                {
                  key: 'pin',
                  label: t('playground.desc.pinnable'),
                  children:
                    result.pinnable == null
                      ? t('playground.desc.unknown')
                      : result.pinnable
                        ? t('playground.desc.yes')
                        : t('playground.desc.no'),
                },
              ]}
            />
            {result.content && (
              <div>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {t('playground.content')}
                </Typography.Text>
                <pre className="cps-pre">{result.content}</pre>
              </div>
            )}
            <div>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {t('playground.trace')}
              </Typography.Text>
              <div style={{ marginTop: 6 }}>
                <TraceTable trace={result.trace} targets={result.targets} />
              </div>
            </div>
          </div>
        )}
      </Panel>
    </div>
  );
}

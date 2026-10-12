import { CopyOutlined, ExclamationCircleFilled, PlayCircleOutlined, SettingOutlined } from '@ant-design/icons';
import {
  Alert,
  Badge,
  Button,
  Descriptions,
  Empty,
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
import { STATUS_TAG } from '../api/types.ts';
import { useFeedback } from '../feedback.ts';
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
  const save = useSaveModelConfig();

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
          <span>该模型当前的路由策略</span>
          <Typography.Text type="secondary" style={{ fontSize: 12, fontWeight: 400 }}>
            {cfg.pinMode === 'strict'
              ? '严格钉住：只走清单内渠道；网关未按清单路由时按失败处理'
              : '优先 + 回退：逐个严格尝试，仅最后一个候选放开网关'}
          </Typography.Text>
        </Space>
      }
    >
      <RoutingFields cfg={cfg} onChange={patch} />
      {rows.length === 0 ? (
        <div className="cps-notice" style={{ marginTop: 12 }}>
          <ExclamationCircleFilled style={{ color: 'var(--ant-color-warning-text)' }} />
          <span>该模型尚未探测到渠道：去「订阅模型」页点「探测渠道」，回来这里就能看到候选</span>
        </div>
      ) : (
        <Table
          size="small"
          rowKey="key"
          pagination={false}
          dataSource={rows}
          columns={[
            {
              title: '顺序',
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
              title: '渠道',
              dataIndex: 'name',
              render: (v: string, r) => (
                <Space size={6}>
                  <Typography.Text
                    code
                    copyable={{ text: v, tooltips: ['复制渠道名', '已复制'] }}
                    style={r.enabled ? undefined : { opacity: 0.5 }}
                  >
                    {v}
                  </Typography.Text>
                  {r.detail?.context ? (
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {Math.round(r.detail.context / 1000)}K 上下文
                    </Typography.Text>
                  ) : null}
                </Space>
              ),
            },
            {
              title: '健康状态',
              width: 130,
              render: (_, r) => {
                const s = r.status;
                if (!s) return <Typography.Text type="secondary">未判定</Typography.Text>;
                const tag = STATUS_TAG[s.status];
                return (
                  <Tooltip title={s.note ?? undefined}>
                    <Tag color={tag.color} style={{ margin: 0 }}>
                      {tag.label}
                    </Tag>
                  </Tooltip>
                );
              },
            },
            {
              title: '最近耗时',
              width: 104,
              align: 'right',
              render: () => <Typography.Text type="secondary">—</Typography.Text>,
            },
            {
              title: '参与路由',
              width: 88,
              render: (_, r) => (
                <Switch
                  size="small"
                  checked={r.enabled}
                  loading={save.isPending}
                  onChange={(v) =>
                    patch(
                      { exclude: v ? cfg.exclude.filter((x) => x !== r.name) : [...cfg.exclude, r.name] },
                      v ? `已启用 ${r.name}` : `已排除 ${r.name}`,
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
  const list = trace ?? [];
  if (!list.length) {
    return (
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        没有候选尝试记录{targets.length ? `（目标：${targets.join(' → ')}）` : ''}
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
          title: '顺序',
          width: 64,
          render: (_, __, i) => (
            <Typography.Text type="secondary" className="cps-num">
              {i + 1}
            </Typography.Text>
          ),
        },
        {
          title: '渠道',
          dataIndex: 'upstream',
          render: (v: string | null) =>
            v ? (
              <span className="cps-mono">{v}</span>
            ) : (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                网关默认
              </Typography.Text>
            ),
        },
        {
          title: '结果',
          width: 120,
          render: (_, r) => <Badge status={r.status === 200 ? 'success' : 'error'} text={`HTTP ${r.status}`} />,
        },
        {
          title: '耗时',
          width: 100,
          render: (_, r) => <Typography.Text className="cps-num">{r.ms} ms</Typography.Text>,
        },
        {
          title: '备注',
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
  const models = useModels();
  const test = useTest();
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
    { value: '', label: '自动（按该模型的路由策略）' },
    ...cfg.upstreams.map((u) => ({ value: u, label: u })),
  ];

  const run = (): void => {
    if (!active) {
      fb.fail('请先选择模型');
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
      <PageHeader
        title="测试台"
        desc="任选模型与渠道发一次最小请求，看网关实际路由到哪个渠道、每个候选花了多久。不指定渠道时按该模型的路由策略走。"
      />

      <Panel title="测试参数" extra={<PanelHint>发一次最小请求，看网关实际怎么走</PanelHint>}>
        <Space wrap size={16} align="center">
          <Space size={6} align="center">
            <Typography.Text type="secondary" style={{ fontSize: 13 }}>
              模型
            </Typography.Text>
            <Select
              showSearch
              style={{ width: 320, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}
              placeholder="选择模型"
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
              渠道
            </Typography.Text>
            <Select style={{ width: 240 }} value={upstream} onChange={setUpstream} options={upstreamOptions} />
          </Space>
          <Space size={6} align="center">
            <Tooltip title="写入请求体的 max_tokens。太小会让推理模型在推理阶段就耗尽预算、返回空内容">
              <Typography.Text type="secondary" style={{ fontSize: 13 }}>
                最大输出
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
            发送测试
          </Button>
        </Space>
      </Panel>

      {active && <RoutingPanel model={active} cfg={cfg} meta={activeRow?.meta ?? null} />}

      {/* 结果区：始终在位（空态也属于这块区域），避免「点完才长出一块」的跳动 */}
      <Panel
        title={
          result ? (
            <Space size={8}>
              {result.ok ? <Tag color="green">成功</Tag> : <Tag color="red">失败</Tag>}
              <Typography.Text code style={{ fontSize: 13 }}>
                {active}
              </Typography.Text>
              {result.ok && <Tag color={hit ? 'green' : 'orange'}>{hit ? '命中首个目标' : '未命中首个目标'}</Tag>}
              {result.degraded && (
                <Tooltip title="本地清单与网关实际可用渠道不一致，已按降级策略处理">
                  <Tag color="gold">降级</Tag>
                </Tooltip>
              )}
            </Space>
          ) : (
            <span>测试结果</span>
          )
        }
        extra={
          result ? (
            <Tooltip title="复制完整结果（含每次尝试）">
              <Button
                size="small"
                type="text"
                icon={<CopyOutlined />}
                aria-label="复制测试结果"
                onClick={() =>
                  void navigator.clipboard.writeText(JSON.stringify(result, null, 2)).then(
                    () => fb.copy('测试结果'),
                    () => fb.fail('复制失败', '剪贴板不可用'),
                  )
                }
              />
            </Tooltip>
          ) : undefined
        }
      >
        {!result ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              <Space direction="vertical" size={2}>
                <span>还没有测试结果</span>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  点「发送测试」发一次真实请求（消耗极小额度）
                </Typography.Text>
              </Space>
            }
          />
        ) : !result.ok ? (
          <Alert type="error" showIcon message={`请求失败：${result.error ?? '未知错误'}`} />
        ) : (
          <div style={{ display: 'grid', gap: 16 }}>
            <Descriptions
              size="small"
              column={3}
              items={[
                { key: 'actual', label: '实际渠道', children: result.actual ?? result.actualName ?? '—' },
                { key: 'ms', label: '总耗时', children: result.ms != null ? `${result.ms} ms` : '—' },
                { key: 'account', label: '使用账号', children: result.account ?? '—' },
                {
                  key: 'targets',
                  label: '目标渠道',
                  children: result.targets.length ? result.targets.join(' → ') : '未指定（按策略）',
                },
                {
                  key: 'pipeline',
                  label: '管道',
                  children: result.pipeline ? `/${result.pipeline}` : '未识别',
                },
                {
                  key: 'pin',
                  label: '可钉住',
                  children: result.pinnable == null ? '未知' : result.pinnable ? '是' : '否',
                },
              ]}
            />
            {result.content && (
              <div>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  响应内容
                </Typography.Text>
                <pre className="cps-pre">{result.content}</pre>
              </div>
            )}
            <div>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                候选尝试序列
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

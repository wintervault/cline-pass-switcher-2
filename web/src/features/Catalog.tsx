import { SearchOutlined } from '@ant-design/icons';
import { Alert, App, Button, Empty, Input, Skeleton, Space, Table, Tag, Tooltip, Typography } from 'antd';
import { useState } from 'react';

import { useModels, useProbe } from '../api/hooks.ts';
import type { PinState, Pipeline } from '../api/types.ts';
import { PageHeader } from '../pageHeader.tsx';
import { Panel } from '../panel.tsx';

/** 本页探测的结果（失败也留痕）。目录模型多半不在订阅清单里，结果就地展示，不再「存了却无处可看」。 */
interface ProbeOutcome {
  ok: boolean;
  error?: string;
  pipeline?: Pipeline | null;
  upstreams?: string[];
  pinState?: PinState;
}

/** 探测结果标签：管线 + **探测到的渠道名**。
 *  只显示「2 渠道」等于没说——用户探测就是为了知道背后是哪几个渠道。 */
function ProbeTags({ p }: { p: ProbeOutcome }) {
  if (!p.ok) {
    return (
      <Tooltip title={p.error}>
        <Tag color="red" style={{ margin: 0 }}>
          探测失败
        </Tag>
      </Tooltip>
    );
  }
  const ups = p.upstreams ?? [];
  const shown = ups.slice(0, 3);
  return (
    <Space size={4} wrap>
      <Tag color="green" style={{ margin: 0 }}>
        {p.pipeline === 'planner' ? '规划器 · Vercel' : '直连 · OpenRouter'}
      </Tag>
      {shown.map((u) => (
        <Tag key={u} color="geekblue" style={{ margin: 0 }}>
          {u}
        </Tag>
      ))}
      {ups.length > shown.length && (
        <Tooltip title={ups.join('、')}>
          <Tag style={{ margin: 0 }}>+{ups.length - shown.length}</Tag>
        </Tooltip>
      )}
      {ups.length === 0 && <Tag style={{ margin: 0 }}>无可用渠道</Tag>}
      {p.pinState === 'ignored' && (
        <Tooltip title="网关忽略钉住参数：该模型的渠道清单不可信">
          <Tag color="orange" style={{ margin: 0 }}>
            参数被忽略
          </Tag>
        </Tooltip>
      )}
    </Space>
  );
}

export default function Catalog() {
  const { message } = App.useApp();
  const models = useModels();
  const probe = useProbe();
  const [filter, setFilter] = useState('');
  const [probes, setProbes] = useState<Record<string, ProbeOutcome>>({});

  const catalog = models.data?.catalog ?? [];
  const matched = catalog.filter((id) => !filter || id.toLowerCase().includes(filter.toLowerCase()));
  const filtered = matched.slice(0, 400);

  const runProbe = (id: string): void => {
    probe.mutate(id, {
      onSuccess: (r) => {
        setProbes((prev) => ({
          ...prev,
          [id]: { ok: r.ok, error: r.error, pipeline: r.pipeline, upstreams: r.upstreams, pinState: r.pinState },
        }));
        if (!r.ok) message.error(`${id} 探测失败：${r.error ?? '未知错误'}`);
      },
      onError: (e) => {
        const err = String(e);
        setProbes((prev) => ({ ...prev, [id]: { ok: false, error: err } }));
        message.error(`${id} 探测失败：${err}`);
      },
    });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <PageHeader title="完整目录" desc="Cline 公开目录的全部模型；:free 变体可精确钉住上游。探测结果就地显示。" />
      {/* 区域：目录（搜索与计数属于这块区域的头，表格是它的体） */}
      <Panel
        flush
        title={
          <Input
            style={{ width: 320 }}
            prefix={<SearchOutlined />}
            allowClear
            placeholder="过滤… 如 free / glm / anthropic"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        }
        extra={
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {filter
              ? `匹配 ${matched.length} / ${models.data?.catalogCount ?? 0} 个（显示前 400 条）`
              : `共 ${models.data?.catalogCount ?? 0} 个目录模型（显示前 400 条）`}
          </Typography.Text>
        }
      >
        {models.isError ? (
          <Alert
            type="error"
            showIcon
            message="目录加载失败"
            description="服务可能正在重启；稍候重试，或用状态栏的刷新按钮。"
            action={
              <Button size="small" onClick={() => void models.refetch()}>
                重试
              </Button>
            }
          />
        ) : models.isLoading && !models.data ? (
          <Skeleton active paragraph={{ rows: 8 }} />
        ) : (
          <Table
            className="cps-table-center"
            rowKey="id"
            size="small"
            sticky
            loading={models.isLoading}
            dataSource={filtered.map((id) => ({ id }))}
            locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有匹配的模型" /> }}
            pagination={false}
            columns={[
              {
                title: '模型',
                dataIndex: 'id',
                /* 纯等宽文字（不用 code 芯片）：这一列是 400 行同样的标识，
                   每行一个带内边距与描边的芯片会变成一片栅格噪点。 */
                render: (v: string) => (
                  <Tooltip title={v}>
                    <span className="cps-mono cps-cell-ellipsis">{v}</span>
                  </Tooltip>
                ),
              },
              {
                title: '类型 / 探测结果',
                width: 320,
                render: (_, r) => {
                  const id = String(r.id);
                  const p = probes[id];
                  if (!p) {
                    return id.includes(':free') ? <Tag color="green">:free 可精确钉住</Tag> : <Tag>规划器管理</Tag>;
                  }
                  return <ProbeTags p={p} />;
                },
              },
              {
                title: '操作',
                width: 76,
                render: (_, r) => (
                  <Button
                    size="small"
                    loading={probe.isPending && probe.variables === r.id}
                    onClick={() => runProbe(String(r.id))}
                  >
                    探测
                  </Button>
                ),
              },
            ]}
          />
        )}
      </Panel>
    </div>
  );
}

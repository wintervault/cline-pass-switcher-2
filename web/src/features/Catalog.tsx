import { SearchOutlined } from '@ant-design/icons';
import { Alert, App, Button, Empty, Input, Skeleton, Space, Table, Tag, Tooltip, Typography } from 'antd';
import { useState } from 'react';

import { useModels, useProbe } from '../api/hooks.ts';
import type { PinState, Pipeline } from '../api/types.ts';
import { GAP_SECTION } from '../layout.ts';
import { PageHeader } from '../pageHeader.tsx';

/** 本页探测的结果（失败也留痕）。目录模型多半不在订阅清单里，结果就地展示，不再「存了却无处可看」。 */
interface ProbeOutcome {
  ok: boolean;
  error?: string;
  pipeline?: Pipeline | null;
  upstreams?: string[];
  pinState?: PinState;
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
    <div>
      <PageHeader title="完整目录" desc="Cline 公开目录的全部模型；:free 变体可精确钉住上游。探测结果就地显示。" />
      {/* 工具栏：搜索 + 计数同高一行，计数靠右——以前两者挤在一起，长宽比也不一致 */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          marginBottom: GAP_SECTION,
          flexWrap: 'wrap',
        }}
      >
        <Input
          style={{ width: 320 }}
          prefix={<SearchOutlined />}
          allowClear
          placeholder="过滤… 如 free / glm / anthropic"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <Typography.Text type="secondary" style={{ fontSize: 12, marginLeft: 'auto' }}>
          {filter
            ? `匹配 ${matched.length} / ${models.data?.catalogCount ?? 0} 个（显示前 400 条）`
            : `共 ${models.data?.catalogCount ?? 0} 个目录模型（显示前 400 条）`}
        </Typography.Text>
      </div>
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
          rowKey="id"
          size="small"
          sticky
          loading={models.isLoading}
          dataSource={filtered.map((id) => ({ id }))}
          locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有匹配的模型" /> }}
          pagination={false}
          columns={[
            { title: '模型', dataIndex: 'id', render: (v: string) => <Typography.Text code>{v}</Typography.Text> },
            {
              title: '类型 / 探测结果',
              width: 260,
              render: (_, r) => {
                const id = String(r.id);
                const p = probes[id];
                if (!p) {
                  return id.includes(':free') ? <Tag color="green">:free 可精确钉住</Tag> : <Tag>规划器管理</Tag>;
                }
                if (!p.ok) {
                  return (
                    <Tooltip title={p.error}>
                      <Tag color="red">探测失败</Tag>
                    </Tooltip>
                  );
                }
                return (
                  <Space size={4} wrap>
                    <Tag color="green">{p.pipeline === 'planner' ? '规划器 · Vercel' : '直连 · OpenRouter'}</Tag>
                    <Tag color="geekblue">{p.upstreams?.length ?? 0} 渠道</Tag>
                    {p.pinState === 'ignored' && <Tag color="red">参数被忽略</Tag>}
                  </Space>
                );
              },
            },
            {
              title: '操作',
              width: 90,
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
    </div>
  );
}

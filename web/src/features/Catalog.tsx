import { Button, Input, Space, Table, Tag, Typography } from 'antd';
import { useState } from 'react';

import { useModels, useProbe } from '../api/hooks.ts';

export default function Catalog() {
  const models = useModels();
  const probe = useProbe();
  const [filter, setFilter] = useState('');

  const catalog = models.data?.catalog ?? [];
  const filtered = catalog.filter((id) => !filter || id.toLowerCase().includes(filter.toLowerCase())).slice(0, 400);

  return (
    <div>
      <Space style={{ marginBottom: 12 }} wrap>
        <Input
          style={{ width: 320 }}
          placeholder="过滤… 如 free / glm / anthropic"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          共 {models.data?.catalogCount ?? 0} 个目录模型（显示前 400 条）
        </Typography.Text>
      </Space>
      <Table
        rowKey="id"
        size="small"
        loading={models.isLoading}
        dataSource={filtered.map((id) => ({ id }))}
        pagination={false}
        columns={[
          { title: '模型', dataIndex: 'id', render: (v: string) => <Typography.Text code>{v}</Typography.Text> },
          {
            title: '钉住',
            width: 160,
            render: (_, r) =>
              String(r.id).includes(':free') ? (
                <Tag color="green">:free 可精确钉住</Tag>
              ) : (
                <Tag color="orange">规划器管理</Tag>
              ),
          },
          {
            title: '操作',
            width: 90,
            render: (_, r) => (
              <Button
                size="small"
                loading={probe.isPending && probe.variables === r.id}
                onClick={() => probe.mutate(String(r.id))}
              >
                探测
              </Button>
            ),
          },
        ]}
      />
    </div>
  );
}

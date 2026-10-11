import { SearchOutlined } from '@ant-design/icons';
import { Alert, Button, Empty, Input, Skeleton, Space, Table, Tag, Typography } from 'antd';
import { useState } from 'react';

import { useModels, useProbe } from '../api/hooks.ts';
import { PageHeader } from '../pageHeader.tsx';

export default function Catalog() {
  const models = useModels();
  const probe = useProbe();
  const [filter, setFilter] = useState('');

  const catalog = models.data?.catalog ?? [];
  const filtered = catalog.filter((id) => !filter || id.toLowerCase().includes(filter.toLowerCase())).slice(0, 400);

  return (
    <div>
      <PageHeader title="完整目录" desc="Cline 公开目录的全部模型；:free 变体可精确钉住上游。" />
      <Space style={{ marginBottom: 16 }} wrap>
        <Input
          style={{ width: 320 }}
          prefix={<SearchOutlined />}
          placeholder="过滤… 如 free / glm / anthropic"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          共 {models.data?.catalogCount ?? 0} 个目录模型（显示前 400 条）
        </Typography.Text>
      </Space>
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
      )}
    </div>
  );
}

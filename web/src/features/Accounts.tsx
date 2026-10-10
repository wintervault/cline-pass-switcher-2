import { App, Button, Input, Radio, Select, Space, Switch, Table, Tag, Typography } from 'antd';
import { useState } from 'react';

import { useAccounts, useSaveAccounts, useTestAccount } from '../api/hooks.ts';
import type { AccountMode } from '../api/types.ts';

interface EditRow {
  name: string;
  /** 空串 = 保持原 key（服务端拿不到明文） */
  key: string;
  enabled: boolean;
}

export default function Accounts() {
  const { message } = App.useApp();
  const accounts = useAccounts();
  const save = useSaveAccounts();
  const testKey = useTestAccount();
  const [showKeys, setShowKeys] = useState(false);
  const [editing, setEditing] = useState<EditRow[] | null>(null);
  const [mode, setMode] = useState<AccountMode | null>(null);
  const [active, setActive] = useState<number | null>(null);

  const data = accounts.data;
  const rows: EditRow[] =
    editing ?? (data?.accounts.map((a) => ({ name: a.name, key: '', enabled: a.enabled })) ?? []);
  const currentMode = mode ?? data?.mode ?? 'sticky';
  const currentActive = active ?? data?.active ?? 0;

  const startEdit = (): void => {
    setEditing(rows.map((r) => ({ ...r })));
    setMode(currentMode);
    setActive(currentActive);
  };
  const discard = (): void => {
    setEditing(null);
    setMode(null);
    setActive(null);
  };

  const persist = (): void => {
    const effective = rows.filter((r) => r.key || data?.accounts[rows.indexOf(r)]?.hasKey);
    if (!effective.length) {
      message.warning('至少需要一个账号');
      return;
    }
    save.mutate(
      { accounts: rows, mode: currentMode, active: currentActive },
      {
        onSuccess: () => {
          message.success('账号配置已保存');
          discard();
        },
        onError: (e) => message.error(`保存失败：${String(e)}`),
      },
    );
  };

  const testRow = (index: number): void => {
    const key = rows[index]?.key || data?.accounts[index]?.keyTail;
    if (!rows[index]?.key) {
      message.warning('请先填写该账号的 key（保存后才能用已存的 key 测试）');
      return;
    }
    testKey.mutate(rows[index]?.key ?? '', {
      onSuccess: (r) =>
        r.ok
          ? message.success(`✔ ${rows[index]?.name} 可用（${r.ms}ms）${r.note ?? ''}`)
          : message.error(`✘ ${rows[index]?.name} 不可用：${r.error}`),
      onError: (e) => message.error(String(e)),
    });
  };

  return (
    <div>
      <Space style={{ marginBottom: 12 }} wrap>
        <Typography.Text type="secondary">模式：</Typography.Text>
        <Select
          style={{ width: 200 }}
          value={currentMode}
          disabled={!editing}
          onChange={(v) => setMode(v)}
          options={[
            { value: 'sticky', label: '粘性（推荐 · 保 prompt cache）' },
            { value: 'single', label: '单账号（手动指定）' },
            { value: 'roundrobin', label: '每请求轮转（牺牲缓存）' },
          ]}
        />
        <Switch
          checkedChildren="显示密钥"
          unCheckedChildren="隐藏密钥"
          checked={showKeys}
          onChange={setShowKeys}
          disabled={!editing}
        />
        {editing ? (
          <>
            <Button type="primary" loading={save.isPending} onClick={persist}>
              保存
            </Button>
            <Button onClick={discard}>取消</Button>
          </>
        ) : (
          <Button type="primary" onClick={startEdit}>
            编辑账号
          </Button>
        )}
      </Space>

      <Table
        rowKey={(_, i) => String(i)}
        size="small"
        loading={accounts.isLoading}
        dataSource={rows}
        pagination={false}
        columns={[
          {
            title: '使用',
            width: 60,
            render: (_, __, i) => (
              <Radio
                checked={currentActive === i}
                disabled={!editing || currentMode !== 'single'}
                onChange={() => setActive(i)}
              />
            ),
          },
          {
            title: '名称',
            render: (_, row, i) =>
              editing ? (
                <Input
                  size="small"
                  style={{ width: 140 }}
                  value={row.name}
                  onChange={(e) => setEditing(rows.map((r, j) => (j === i ? { ...r, name: e.target.value } : r)))}
                />
              ) : (
                row.name
              ),
          },
          {
            title: 'API Key',
            render: (_, row, i) => {
              const saved = data?.accounts[i];
              if (!editing) return <Typography.Text code>{saved?.keyMasked ?? '—'}</Typography.Text>;
              return (
                <Input.Password
                  size="small"
                  visibilityToggle={{ visible: showKeys }}
                  placeholder={saved?.hasKey ? `已保存（末 4 位 ${saved.keyTail}），留空保持不变` : 'sk_...'}
                  value={row.key}
                  onChange={(e) => setEditing(rows.map((r, j) => (j === i ? { ...r, key: e.target.value } : r)))}
                />
              );
            },
          },
          {
            title: '启用',
            width: 70,
            render: (_, row, i) => (
              <Switch
                size="small"
                checked={row.enabled}
                disabled={!editing}
                onChange={(v) => setEditing(rows.map((r, j) => (j === i ? { ...r, enabled: v } : r)))}
              />
            ),
          },
          {
            title: '请求数',
            width: 90,
            render: (_, __, i) => {
              const st = data?.stats[data?.accounts[i]?.name ?? ''];
              return (
                <>
                  {st?.requests ?? 0}
                  {st?.lastError ? (
                    <div>
                      <Tag color="red">最近有错误</Tag>
                    </div>
                  ) : null}
                </>
              );
            },
          },
          {
            title: '最近使用',
            width: 120,
            render: (_, __, i) => {
              const st = data?.stats[data?.accounts[i]?.name ?? ''];
              return st?.lastUsed ? new Date(st.lastUsed).toLocaleString() : '—';
            },
          },
          {
            title: '操作',
            width: 140,
            render: (_, __, i) => (
              <Space size={4}>
                <Button size="small" disabled={!editing} loading={testKey.isPending} onClick={() => testRow(i)}>
                  测试
                </Button>
                <Button
                  size="small"
                  danger
                  disabled={!editing}
                  onClick={() => setEditing(rows.filter((_, j) => j !== i))}
                >
                  删除
                </Button>
              </Space>
            ),
          },
        ]}
      />
      <div style={{ marginTop: 8 }}>
        {editing && (
          <Button size="small" onClick={() => setEditing([...rows, { name: `账号${rows.length + 1}`, key: '', enabled: true }])}>
            ＋ 添加账号
          </Button>
        )}
        {currentMode === 'sticky' && (
          <Typography.Text type="secondary" style={{ marginLeft: 12, fontSize: 12 }}>
            粘性模式：持续使用当前账号，只有账号级错误（key 失效/额度用完）才轮转到下一个——保住上游 prompt cache。
          </Typography.Text>
        )}
      </div>
    </div>
  );
}

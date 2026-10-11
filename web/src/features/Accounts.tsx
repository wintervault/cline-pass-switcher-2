import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import {
  Alert,
  App,
  Button,
  Card,
  Input,
  Radio,
  Select,
  Skeleton,
  Space,
  Switch,
  Tooltip,
  Typography,
  theme,
} from 'antd';
import { useState } from 'react';

import { useAccounts, useSaveAccounts, useTestAccount } from '../api/hooks.ts';
import type { AccountMode } from '../api/types.ts';
import { PageHeader } from '../pageHeader.tsx';

interface EditRow {
  name: string;
  /** 空串 = 保持原 key（服务端拿不到明文） */
  key: string;
  enabled: boolean;
  /**
   * 编辑开始时该行在已存列表里的下标；新增行为 null。
   * key 的归属由它指定——**不能按当前行号对位**：删除一行会让后面的行
   * 错位继承别人的密钥（服务端按 existingIndex 取旧 key）。
   */
  existingIndex: number | null;
}

/** 最近使用时间：当天只显示时刻，跨天带日期。 */
function fmtUsed(ts: number): string {
  const d = new Date(ts);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString()
    : `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export default function Accounts() {
  const { message } = App.useApp();
  const { token } = theme.useToken();
  const accounts = useAccounts();
  const save = useSaveAccounts();
  const testKey = useTestAccount();
  const [showKeys, setShowKeys] = useState(false);
  const [editing, setEditing] = useState<EditRow[] | null>(null);
  const [mode, setMode] = useState<AccountMode | null>(null);
  const [active, setActive] = useState<number | null>(null);

  const data = accounts.data;
  const rows: EditRow[] =
    editing ?? data?.accounts.map((a, i) => ({ name: a.name, key: '', enabled: a.enabled, existingIndex: i })) ?? [];
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

  const patch = (i: number, p: Partial<EditRow>): void => {
    setEditing(rows.map((r, j) => (j === i ? { ...r, ...p } : r)));
  };

  const persist = (): void => {
    if (!rows.some((r) => r.key || (r.existingIndex !== null && data?.accounts[r.existingIndex]?.hasKey))) {
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
    const row = rows[index];
    if (!row) return;
    // 填了新 key 就测新 key；否则用已存的 key（服务端按下标取，前端拿不到明文）
    const payload = row.key ? { key: row.key } : row.existingIndex !== null ? { index: row.existingIndex } : null;
    if (!payload) {
      message.warning('该账号还没有 key：请填写，或先保存过一次');
      return;
    }
    testKey.mutate(payload, {
      onSuccess: (r) =>
        r.ok
          ? message.success(`${row.name} 可用（${r.ms}ms）${r.note ?? ''}`)
          : message.error(`${row.name} 不可用：${r.error}`),
      onError: (e) => message.error(String(e)),
    });
  };

  return (
    <div style={{ maxWidth: 960, margin: '0 auto' }}>
      <PageHeader
        title="账号池"
        desc="粘性模式保住上游 prompt cache：只有账号级错误（key 失效 / 额度用完）才轮转到下一账号。"
        actions={
          editing ? (
            <Space>
              <Button type="primary" loading={save.isPending} onClick={persist}>
                保存
              </Button>
              <Button onClick={discard}>取消</Button>
            </Space>
          ) : (
            <Button type="primary" onClick={startEdit}>
              编辑账号
            </Button>
          )
        }
      />

      <Space size={12} wrap style={{ marginBottom: 16 }}>
        <Typography.Text type="secondary" style={{ fontSize: 14 }}>
          选择策略
        </Typography.Text>
        <Select
          style={{ width: 250 }}
          value={currentMode}
          disabled={!editing}
          onChange={(v) => setMode(v)}
          options={[
            { value: 'sticky', label: '粘性（推荐 · 保 prompt cache）' },
            { value: 'single', label: '单账号（手动指定）' },
            { value: 'roundrobin', label: '每请求轮转（牺牲缓存）' },
          ]}
        />
        <Tooltip title="编辑时以明文显示输入框内容">
          <Switch
            checkedChildren="显示密钥"
            unCheckedChildren="隐藏密钥"
            checked={showKeys}
            onChange={setShowKeys}
            disabled={!editing}
          />
        </Tooltip>
      </Space>

      {accounts.isError ? (
        <Alert
          type="error"
          showIcon
          message="账号池加载失败"
          description="服务可能正在重启；稍候重试，或用状态栏的刷新按钮。"
          action={
            <Button size="small" onClick={() => void accounts.refetch()}>
              重试
            </Button>
          }
        />
      ) : accounts.isLoading && !data ? (
        <Skeleton active paragraph={{ rows: 4 }} />
      ) : (
        <div style={{ display: 'grid', gap: 12 }}>
          {rows.map((row, i) => {
            const saved = row.existingIndex !== null ? data?.accounts[row.existingIndex] : undefined;
            const st =
              row.existingIndex !== null ? data?.stats[data?.accounts[row.existingIndex]?.name ?? ''] : undefined;
            const isActive = currentActive === i && currentMode === 'single';
            return (
              <Card
                key={String(i)}
                size="small"
                style={{ borderColor: isActive ? token.colorPrimaryBorder : undefined }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                  <Tooltip title={currentMode === 'single' ? '单账号模式使用的账号' : '「单账号」模式下才能指定'}>
                    <Radio
                      checked={isActive}
                      disabled={!editing || currentMode !== 'single'}
                      onChange={() => setActive(i)}
                    />
                  </Tooltip>

                  <div style={{ flex: 1, minWidth: 0, display: 'grid', gap: 8 }}>
                    {editing ? (
                      <Input
                        size="small"
                        style={{ maxWidth: 220 }}
                        value={row.name}
                        placeholder="账号名称"
                        onChange={(e) => patch(i, { name: e.target.value })}
                      />
                    ) : (
                      <Typography.Text strong>{row.name || '（未命名）'}</Typography.Text>
                    )}
                    {editing ? (
                      <Input.Password
                        size="small"
                        style={{ maxWidth: 400 }}
                        visibilityToggle={{ visible: showKeys }}
                        placeholder={saved?.hasKey ? `已保存（末 4 位 ${saved.keyTail}），留空保持不变` : 'sk_...'}
                        value={row.key}
                        onChange={(e) => patch(i, { key: e.target.value })}
                      />
                    ) : (
                      <Typography.Text code style={{ fontSize: 12 }}>
                        {saved?.keyMasked ?? '—'}
                      </Typography.Text>
                    )}
                  </div>

                  <div style={{ display: 'grid', gap: 4, justifyItems: 'end', minWidth: 118 }}>
                    <Typography.Text style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>
                      请求 {st?.requests ?? 0}
                    </Typography.Text>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {st?.lastUsed ? fmtUsed(st.lastUsed) : '未使用'}
                    </Typography.Text>
                    {st?.lastError && (
                      <Typography.Text type="danger" style={{ fontSize: 12 }} ellipsis={{ tooltip: st.lastError }}>
                        最近有错误
                      </Typography.Text>
                    )}
                  </div>

                  <Tooltip title="停用后不参与选择">
                    <Switch
                      size="small"
                      checked={row.enabled}
                      disabled={!editing}
                      onChange={(v) => patch(i, { enabled: v })}
                    />
                  </Tooltip>

                  <Space size={4}>
                    <Button size="small" disabled={!editing} loading={testKey.isPending} onClick={() => testRow(i)}>
                      测试
                    </Button>
                    {editing && (
                      <Button
                        size="small"
                        type="text"
                        danger
                        icon={<DeleteOutlined />}
                        aria-label="删除账号"
                        onClick={() => setEditing(rows.filter((_, j) => j !== i))}
                      />
                    )}
                  </Space>
                </div>
              </Card>
            );
          })}

          {editing && (
            <Button
              type="dashed"
              icon={<PlusOutlined />}
              style={{ height: 48 }}
              onClick={() =>
                setEditing([...rows, { name: `账号${rows.length + 1}`, key: '', enabled: true, existingIndex: null }])
              }
            >
              添加账号
            </Button>
          )}

          {!editing && rows.length === 0 && (
            <Typography.Text type="secondary">还没有账号：点右上角「编辑账号」→「添加账号」。</Typography.Text>
          )}
        </div>
      )}
    </div>
  );
}

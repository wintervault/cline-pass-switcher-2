import { DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons';
import { useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  App,
  Button,
  Card,
  Empty,
  Input,
  Modal,
  Popconfirm,
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

import { qk, useAccounts, useSaveAccounts, useTestAccount } from '../api/hooks.ts';
import type { AccountMode, AccountsResponse } from '../api/types.ts';
import { PageHeader } from '../pageHeader.tsx';

/** 提交给服务端的账号行；key 空串 = 保持原 key（服务端拿不到明文）。 */
interface DraftAccount {
  name: string;
  key: string;
  enabled: boolean;
  /**
   * 该行在已存列表里的下标；新增行为 null。
   * key 的归属由它指定——**不能按当前行号对位**：删除一行会让后面的行
   * 错位继承别人的密钥（服务端按 existingIndex 取旧 key）。
   */
  existingIndex: number | null;
}

/** 编辑弹窗的状态。 */
interface EditModal {
  /** null = 新增；数字 = 编辑已存账号的下标 */
  index: number | null;
  name: string;
  key: string;
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
  const qc = useQueryClient();
  const accounts = useAccounts();
  const save = useSaveAccounts();
  const testKey = useTestAccount();
  const [modal, setModal] = useState<EditModal | null>(null);

  const data = accounts.data;
  const rows = data?.accounts ?? [];
  const mode = data?.mode ?? 'sticky';
  const active = data?.active ?? 0;

  /** 把服务端当前状态组装成提交数组（key 留空 = 保持不变）。 */
  const draftFromServer = (): DraftAccount[] =>
    rows.map((a, i) => ({ name: a.name, key: '', enabled: a.enabled, existingIndex: i }));

  /** 就地保存：只改传入的字段，其余保持服务端当前值。note 是给用户的回执文案。 */
  const commit = (next: { accounts?: DraftAccount[]; mode?: AccountMode; active?: number }, note: string): void => {
    const nextAccounts = next.accounts ?? draftFromServer();
    const nextMode = next.mode ?? mode;
    const nextActive = next.active ?? active;
    // 乐观更新缓存：连续操作（连点开关 / 连切策略）时，下一次 draftFromServer()
    // 读到的必须包含上一次改动——否则后一次提交会用旧缓存覆盖前一次（丢改动）
    qc.setQueryData<AccountsResponse>(qk.accounts, (old) =>
      old
        ? {
            ...old,
            accounts: nextAccounts.map((a) => {
              const prev = a.existingIndex !== null ? old.accounts[a.existingIndex] : undefined;
              const key = a.key.trim();
              return {
                name: a.name,
                enabled: a.enabled,
                keyMasked: key
                  ? `${'•'.repeat(Math.max(8, key.length - 4))}${key.slice(-4)}`
                  : (prev?.keyMasked ?? '—'),
                keyTail: key ? key.slice(-4) : (prev?.keyTail ?? ''),
                hasKey: !!key || !!prev?.hasKey,
              };
            }),
            mode: nextMode,
            active: nextActive,
          }
        : old,
    );
    save.mutate({ payload: { accounts: nextAccounts, mode: nextMode, active: nextActive }, note });
  };

  const testAccount = (i: number, name: string): void => {
    testKey.mutate({ payload: { index: i }, label: name });
  };

  const submitModal = (): void => {
    if (!modal) return;
    const name = modal.name.trim() || `账号${rows.length + 1}`;
    const key = modal.key.trim();
    if (modal.index === null && !key) {
      message.warning('新账号需要填写 API Key');
      return;
    }
    const draft = draftFromServer();
    const editing = modal.index !== null;
    if (modal.index === null) {
      draft.push({ name, key, enabled: true, existingIndex: null });
    } else {
      draft[modal.index] = { ...(draft[modal.index] as DraftAccount), name, key };
    }
    commit({ accounts: draft }, editing ? `已更新账号「${name}」` : `已添加账号「${name}」`);
    setModal(null);
  };

  const removeAccount = (i: number): void => {
    const name = rows[i]?.name ?? '账号';
    const draft = draftFromServer().filter((_, j) => j !== i);
    // 删除后激活下标可能越界：删的是前面的行或当前行时向前收一位
    const nextActive = i <= active ? Math.max(0, active - 1) : active;
    commit({ accounts: draft, active: nextActive }, `已删除账号「${name}」`);
  };

  return (
    <div style={{ maxWidth: 960, margin: '0 auto' }}>
      <PageHeader
        title="账号池"
        desc="粘性模式保住上游 prompt cache：只有账号级错误（key 失效 / 额度用完）才轮转到下一账号。所有修改即时保存。"
        actions={
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setModal({ index: null, name: '', key: '' })}>
            添加账号
          </Button>
        }
      />

      <Space size={12} wrap style={{ marginBottom: 16 }}>
        <Typography.Text type="secondary" style={{ fontSize: 14 }}>
          选择策略
        </Typography.Text>
        <Select
          style={{ width: 250 }}
          value={mode}
          onChange={(v) =>
            commit(
              { mode: v },
              {
                sticky: '已切换为粘性模式：保住上游 prompt cache',
                single: '已切换为单账号模式：由你手动指定使用哪一个',
                roundrobin: '已切换为每请求轮转（会牺牲 prompt cache）',
              }[v as AccountMode],
            )
          }
          options={[
            { value: 'sticky', label: '粘性（推荐 · 保 prompt cache）' },
            { value: 'single', label: '单账号（手动指定）' },
            { value: 'roundrobin', label: '每请求轮转（牺牲缓存）' },
          ]}
        />
        {mode === 'single' && (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            点账号卡左侧圆点指定使用哪一个
          </Typography.Text>
        )}
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
          {rows.map((a, i) => {
            const st = data?.stats[a.name];
            const isActive = active === i && mode === 'single';
            return (
              <Card
                key={`${a.name}-${a.keyMasked}`}
                size="small"
                style={{ borderColor: isActive ? token.colorPrimaryBorder : undefined }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                  <Tooltip title={mode === 'single' ? '单账号模式使用的账号' : '「单账号」模式下才能指定'}>
                    <Radio
                      checked={isActive}
                      disabled={mode !== 'single'}
                      onChange={() => commit({ active: i }, `已指定「${a.name}」为当前使用的账号`)}
                    />
                  </Tooltip>

                  <div style={{ flex: 1, minWidth: 0, display: 'grid', gap: 8 }}>
                    <Typography.Text strong>{a.name || '（未命名）'}</Typography.Text>
                    <Typography.Text code style={{ fontSize: 12 }}>
                      {a.keyMasked}
                    </Typography.Text>
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

                  <Tooltip title={a.enabled ? '已启用：参与账号选择' : '已停用：不参与账号选择'}>
                    <Switch
                      size="small"
                      checked={a.enabled}
                      onChange={(v) => {
                        const draft = draftFromServer();
                        draft[i] = { ...(draft[i] as DraftAccount), enabled: v };
                        commit({ accounts: draft }, v ? `已启用「${a.name}」` : `已停用「${a.name}」`);
                      }}
                    />
                  </Tooltip>

                  <Space size={4}>
                    <Button
                      size="small"
                      loading={
                        testKey.isPending &&
                        testKey.variables !== undefined &&
                        'index' in testKey.variables.payload &&
                        testKey.variables.payload.index === i
                      }
                      onClick={() => testAccount(i, a.name)}
                    >
                      测试
                    </Button>
                    <Tooltip title="编辑名称与密钥">
                      <Button
                        size="small"
                        type="text"
                        icon={<EditOutlined />}
                        aria-label="编辑账号"
                        onClick={() => setModal({ index: i, name: a.name, key: '' })}
                      />
                    </Tooltip>
                    <Popconfirm
                      title={`删除账号「${a.name}」？`}
                      description="删除后其密钥将从配置中移除，无法恢复。"
                      okText="删除"
                      okButtonProps={{ danger: true }}
                      cancelText="取消"
                      onConfirm={() => removeAccount(i)}
                    >
                      <Button size="small" type="text" danger icon={<DeleteOutlined />} aria-label="删除账号" />
                    </Popconfirm>
                  </Space>
                </div>
              </Card>
            );
          })}

          {rows.length === 0 && (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="还没有账号：添加 Cline Pass 的 API Key 后即可开始代理"
            >
              <Button
                type="primary"
                icon={<PlusOutlined />}
                onClick={() => setModal({ index: null, name: '', key: '' })}
              >
                添加账号
              </Button>
            </Empty>
          )}
        </div>
      )}

      <Modal
        open={modal !== null}
        title={modal?.index === null ? '添加账号' : '编辑账号'}
        okText="保存"
        cancelText="取消"
        onOk={submitModal}
        onCancel={() => setModal(null)}
        destroyOnHidden
      >
        <Space direction="vertical" style={{ width: '100%' }}>
          <div>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              名称
            </Typography.Text>
            <Input
              style={{ marginTop: 4 }}
              placeholder="如：主力 / 备用"
              value={modal?.name ?? ''}
              onChange={(e) => setModal((m) => (m ? { ...m, name: e.target.value } : m))}
            />
          </div>
          <div>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              API Key
            </Typography.Text>
            <Input.Password
              style={{ marginTop: 4 }}
              placeholder={
                modal?.index === null
                  ? 'sk_...'
                  : `留空保持不变（已存：末 4 位 ${rows[modal?.index ?? 0]?.keyTail ?? ''}）`
              }
              value={modal?.key ?? ''}
              onChange={(e) => setModal((m) => (m ? { ...m, key: e.target.value } : m))}
            />
          </div>
        </Space>
      </Modal>
    </div>
  );
}

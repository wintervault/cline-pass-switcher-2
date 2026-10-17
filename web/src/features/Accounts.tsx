import { DeleteOutlined, EditOutlined, MedicineBoxOutlined, PlusOutlined } from '@ant-design/icons';
import { useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  App,
  Button,
  DatePicker,
  Empty,
  Input,
  Modal,
  Popconfirm,
  Radio,
  Select,
  Skeleton,
  Space,
  Switch,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import dayjs from 'dayjs';
import { useState } from 'react';

import { qk, useAccounts, useClassifyAccounts, useModels, useSaveAccounts, useTestAccount } from '../api/hooks.ts';
import type { AccountClassRecord, AccountMode, AccountsResponse, AccountView, ExpiryState } from '../api/types.ts';
import { ACCOUNT_CLASS_TAG } from '../api/types.ts';
import { PageHeader } from '../pageHeader.tsx';
import { Panel, PanelHint } from '../panel.tsx';

/** 提交给服务端的账号行；key 空串 = 保持原 key（服务端拿不到明文）。 */
interface DraftAccount {
  name: string;
  key: string;
  enabled: boolean;
  /** `YYYY-MM-DD`；null = 没有到期时间。 */
  expiresAt: string | null;
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
  expiresAt: string | null;
}

/** 最近使用时间：当天只显示时刻，跨天带日期。 */
function fmtUsed(ts: number): string {
  const d = new Date(ts);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString()
    : `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * 风控分类徽标。
 *
 * 这是**观测值**：同一个账号的默认路由会随时间翻转（docs/pinning.md 第五节），
 * 所以悬停必须给出判定时间，文案也要说清适用范围——它只解释 planner 管线的
 * 默认路由，不代表这个账号「废了」：direct（OpenRouter 类）模型两类账号都能钉。
 */
function ClassifyTag({ record }: { record: AccountClassRecord | null }) {
  const kind = record?.class ?? 'unknown';
  const tag = ACCOUNT_CLASS_TAG[kind];
  const checked = record?.checkedAt ? `判定于 ${fmtUsed(record.checkedAt)}` : '还没有体检过';
  const tip = (
    <span>
      {checked}
      {record?.note ? `；最近一次体检未成功：${record.note}` : ''}
      <br />
      「风控」= 网关默认把这个账号的请求路由到 openai-compatible-private，钉不住 planner 模型； OpenRouter
      类模型（direct）两类账号都能用。
    </span>
  );
  return (
    <Tooltip title={tip}>
      <Tag color={tag.color} style={{ margin: 0 }}>
        {tag.label}
      </Tag>
    </Tooltip>
  );
}

/**
 * 到期徽标。三种形态之外还有一条常被误解的规则：**到期不会自动停用账号**。
 * 日期可能只是没续上，停用是破坏性动作——所以这里只标记，不改变行为。
 */
function ExpiryTag({ expiry, expiresAt }: { expiry: ExpiryState; expiresAt: string | null }) {
  if (expiry.kind === 'none' || !expiresAt) {
    return (
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        未设置到期时间
      </Typography.Text>
    );
  }
  if (expiry.kind === 'expired') {
    return (
      <Tooltip title={`到期日 ${expiresAt}。到期不会自动停用账号，需要你手动处理。`}>
        <Tag color="red" style={{ margin: 0 }}>
          已过期{expiry.days !== null ? ` ${Math.abs(expiry.days)} 天` : ''}
        </Tag>
      </Tooltip>
    );
  }
  if (expiry.kind === 'soon' && expiry.days !== null) {
    return (
      <Tooltip title={`到期日 ${expiresAt}，记得续期`}>
        <Tag color="gold" style={{ margin: 0 }}>
          {expiry.days === 0 ? '今天到期' : `${expiry.days} 天后到期`}
        </Tag>
      </Tooltip>
    );
  }
  return (
    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
      到期 {expiresAt}
    </Typography.Text>
  );
}

export default function Accounts() {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const accounts = useAccounts();
  const models = useModels();
  const save = useSaveAccounts();
  const testKey = useTestAccount();
  const classify = useClassifyAccounts();
  const [modal, setModal] = useState<EditModal | null>(null);

  const data = accounts.data;
  const rows = data?.accounts ?? [];
  const mode = data?.mode ?? 'sticky';
  const active = data?.active ?? 0;
  const classifyModel = data?.classifyModel ?? '';

  const unclassified = rows.filter((a) => (a.classify?.class ?? 'unknown') === 'unknown').length;
  const noExpiry = rows.filter((a) => !a.expiresAt).length;

  /** 判定模型的可选清单：订阅模型 + 当前值（当前值可能已不在清单里，不能因此消失）。 */
  const modelIds = (models.data?.subscription ?? []).map((m) => m.id);
  const classifyOptions = [...new Set([...modelIds, ...(classifyModel ? [classifyModel] : [])])].map((id) => ({
    value: id,
    label: id,
  }));

  /** 把服务端当前状态组装成提交数组（key 留空 = 保持不变）。 */
  const draftFromServer = (): DraftAccount[] =>
    rows.map((a, i) => ({ name: a.name, key: '', enabled: a.enabled, expiresAt: a.expiresAt, existingIndex: i }));

  /** 就地保存：只改传入的字段，其余保持服务端当前值。note 是给用户的回执文案。 */
  const commit = (
    next: { accounts?: DraftAccount[]; mode?: AccountMode; active?: number; classifyModel?: string },
    note: string,
  ): void => {
    const nextAccounts = next.accounts ?? draftFromServer();
    const nextMode = next.mode ?? mode;
    const nextActive = next.active ?? active;
    const nextModel = next.classifyModel ?? classifyModel;
    // 乐观更新缓存：连续操作（连点开关 / 连切策略）时，下一次 draftFromServer()
    // 读到的必须包含上一次改动——否则后一次提交会用旧缓存覆盖前一次（丢改动）
    qc.setQueryData<AccountsResponse>(qk.accounts, (old) =>
      old
        ? {
            ...old,
            accounts: nextAccounts.map((a) => {
              const prev = a.existingIndex !== null ? old.accounts[a.existingIndex] : undefined;
              const key = a.key.trim();
              const expiresAt = a.expiresAt;
              const unchanged = (prev?.expiresAt ?? null) === expiresAt;
              return {
                name: a.name,
                enabled: a.enabled,
                keyMasked: key
                  ? `${'•'.repeat(Math.max(8, key.length - 4))}${key.slice(-4)}`
                  : (prev?.keyMasked ?? '—'),
                keyTail: key ? key.slice(-4) : (prev?.keyTail ?? ''),
                hasKey: !!key || !!prev?.hasKey,
                expiresAt,
                // 日期变了就先按「到期 <日期>」展示，服务端刷新后换成准确的天数
                expiry: unchanged
                  ? (prev?.expiry ?? { kind: 'none', days: null })
                  : { kind: expiresAt ? 'active' : 'none', days: null },
                classify: prev?.classify ?? null,
              } satisfies AccountView;
            }),
            mode: nextMode,
            active: nextActive,
            classifyModel: nextModel,
          }
        : old,
    );
    save.mutate(
      {
        payload: {
          accounts: nextAccounts,
          mode: nextMode,
          active: nextActive,
          classifyModel: nextModel,
        },
        note,
      },
      { onSuccess: () => qc.invalidateQueries({ queryKey: qk.accounts }) },
    );
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
      draft.push({ name, key, enabled: true, expiresAt: modal.expiresAt, existingIndex: null });
    } else {
      draft[modal.index] = { ...(draft[modal.index] as DraftAccount), name, key, expiresAt: modal.expiresAt };
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <PageHeader
        title="账号池"
        desc="只有账号级错误（key 失效 / 额度用完）才轮转到下一账号——频繁切换会让上游缓存失效、成本变高。所有修改即时保存。"
        actions={
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => setModal({ index: null, name: '', key: '', expiresAt: null })}
          >
            添加账号
          </Button>
        }
      />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {/* 区域一：池级设置（策略 + 体检判定模型）。两件都不是「某一个账号」的属性 */}
        <Panel title="账号池设置" extra={<PanelHint>改动即时保存</PanelHint>}>
          <div style={{ display: 'grid', gap: 16 }}>
            <div style={{ display: 'grid', gap: 8 }}>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                选择策略
              </Typography.Text>
              <Select
                style={{ width: 280 }}
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
              <Typography.Text type="secondary" style={{ fontSize: 12, lineHeight: '18px' }}>
                {mode === 'single'
                  ? '点下方账号左侧圆点，指定实际使用哪一个'
                  : mode === 'sticky'
                    ? '持续使用当前账号；只有 key 失效 / 额度用完这类账号级错误才轮转到下一个'
                    : '每个请求都换一个账号——上游 prompt cache 会全部失效，成本明显更高'}
              </Typography.Text>
            </div>

            <div style={{ display: 'grid', gap: 8 }}>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                体检判定模型
              </Typography.Text>
              <Select
                style={{ width: 280, fontFamily: 'var(--cps-font-mono)' }}
                showSearch
                value={classifyModel || undefined}
                onChange={(v: string) => commit({ classifyModel: v }, `已把体检判定模型改为 ${v}`)}
                options={classifyOptions}
              />
              <Typography.Text type="secondary" style={{ fontSize: 12, lineHeight: '18px' }}>
                「体检」向这个模型发一次最小请求，看网关把它默认路由到哪：落到 openai-compatible-private 即风控号。要用
                planner 管线的模型（cline-pass/*）才判得出来；每个账号消耗一次最小额度。
              </Typography.Text>
            </div>
          </div>
        </Panel>

        {/* 区域二：账号名单 */}
        <Panel
          title="账号"
          extra={
            <Space size={12} align="center">
              <PanelHint>{rows.length} 个</PanelHint>
              {unclassified > 0 && <PanelHint>{unclassified} 个未判定</PanelHint>}
              {noExpiry > 0 && <PanelHint>{noExpiry} 个未设置到期</PanelHint>}
              <Button
                size="small"
                icon={<MedicineBoxOutlined />}
                loading={classify.isPending}
                disabled={!rows.some((a) => a.enabled)}
                onClick={() => classify.mutate({})}
              >
                全部体检
              </Button>
            </Space>
          }
          flush
        >
          {accounts.isError ? (
            <Alert
              type="error"
              showIcon
              style={{ margin: 16 }}
              message="账号池加载失败"
              description="服务可能正在重启；稍候重试，或用状态栏的刷新按钮。"
              action={
                <Button size="small" onClick={() => void accounts.refetch()}>
                  重试
                </Button>
              }
            />
          ) : accounts.isLoading && !data ? (
            <div style={{ padding: 16 }}>
              <Skeleton active paragraph={{ rows: 4 }} />
            </div>
          ) : rows.length === 0 ? (
            <div style={{ padding: '32px 16px' }}>
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="还没有账号：添加 Cline Pass 的 API Key 后即可开始代理"
              >
                <Button
                  type="primary"
                  icon={<PlusOutlined />}
                  onClick={() => setModal({ index: null, name: '', key: '', expiresAt: null })}
                >
                  添加账号
                </Button>
              </Empty>
            </div>
          ) : (
            <div>
              {rows.map((a, i) => {
                const st = data?.stats[a.name];
                const isActive = active === i && mode === 'single';
                const testingThis =
                  classify.isPending &&
                  ((classify.variables?.names?.length ?? 0) > 0
                    ? classify.variables?.names?.includes(a.name)
                    : a.enabled);
                return (
                  <div
                    key={`${a.name}-${a.keyMasked}`}
                    className={isActive ? 'cps-list-row cps-list-row-active' : 'cps-list-row'}
                  >
                    {/* width:100% 让名字列（flex:1）吃掉空白，操作按钮才落在右缘 */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 16, width: '100%' }}>
                      <Tooltip title={mode === 'single' ? '单账号模式使用的账号' : '「单账号」模式下才能指定'}>
                        <Radio
                          checked={isActive}
                          disabled={mode !== 'single'}
                          onChange={() => commit({ active: i }, `已指定「${a.name}」为当前使用的账号`)}
                        />
                      </Tooltip>

                      <div style={{ flex: 1, minWidth: 0, display: 'grid', gap: 6 }}>
                        {/* 名称行带两个徽标：扫一眼就知道「这个号能不能用 / 什么时候到期」 */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', minWidth: 0 }}>
                          <Typography.Text strong>{a.name || '（未命名）'}</Typography.Text>
                          <ClassifyTag record={a.classify} />
                          <ExpiryTag expiry={a.expiry} expiresAt={a.expiresAt} />
                        </div>
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
                        <Tooltip title="发一次最小请求，确认这个账号的密钥可用">
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
                        </Tooltip>
                        <Tooltip title="发一次最小请求，判断这个账号是不是风控号（消耗一次最小额度）">
                          <Button
                            size="small"
                            icon={<MedicineBoxOutlined />}
                            aria-label="体检"
                            loading={testingThis}
                            disabled={classify.isPending && !testingThis}
                            onClick={() => classify.mutate({ names: [a.name] })}
                          />
                        </Tooltip>
                        <Tooltip title="编辑名称、密钥与到期时间">
                          <Button
                            size="small"
                            type="text"
                            icon={<EditOutlined />}
                            aria-label="编辑账号"
                            onClick={() => setModal({ index: i, name: a.name, key: '', expiresAt: a.expiresAt })}
                          />
                        </Tooltip>
                        <Popconfirm
                          title={`删除账号「${a.name}」？`}
                          description="删除后其密钥将从配置中移除，用量统计与体检结论一并清除，无法恢复。"
                          okText="删除"
                          okButtonProps={{ danger: true }}
                          cancelText="取消"
                          onConfirm={() => removeAccount(i)}
                        >
                          <Button size="small" type="text" danger icon={<DeleteOutlined />} aria-label="删除账号" />
                        </Popconfirm>
                      </Space>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Panel>
      </div>

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
          <div>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              到期时间
            </Typography.Text>
            <DatePicker
              style={{ marginTop: 4, width: '100%' }}
              placeholder="可选，留空表示未设置"
              value={modal?.expiresAt ? dayjs(modal.expiresAt) : null}
              onChange={(d) => setModal((m) => (m ? { ...m, expiresAt: d ? d.format('YYYY-MM-DD') : null } : m))}
            />
            <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 6 }}>
              只用来提醒，不会自动停用账号。
            </Typography.Text>
          </div>
        </Space>
      </Modal>
    </div>
  );
}

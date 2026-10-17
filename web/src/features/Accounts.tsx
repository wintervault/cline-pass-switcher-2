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

import {
  qk,
  useAccounts,
  useClassifyAccounts,
  useMeta,
  useModels,
  useSaveAccounts,
  useTestAccount,
} from '../api/hooks.ts';
import type { AccountClassRecord, AccountsResponse, AccountView, ExpiryState } from '../api/types.ts';

import { type Lang, useI18n } from '../i18n/index.tsx';
import { ACCOUNT_CLASS_TAG } from '../labels.ts';
import { PageHeader } from '../pageHeader.tsx';
import { Panel, PanelHint } from '../panel.tsx';

/**
 * 账号池是**全局**的：名称/密钥/到期/启停只在这里定义一次。
 * 账号策略（粘性/单账号/轮转）与「哪些账号参与」是**网关级**的，在「网关」页编辑——
 * 同一个账号可以只服务风控网关，也可以同时服务多个网关，但密钥只有一份。
 */

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

/** 最近使用时间：当天只显示时刻，跨天带日期（跟随界面语言）。 */
function fmtUsed(ts: number, lang: Lang): string {
  const d = new Date(ts);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString(lang)
    : d.toLocaleString(lang, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/**
 * 风控分类徽标。
 *
 * 这是**观测值**：同一个账号的默认路由会随时间翻转（docs/pinning.md 第五节），
 * 所以悬停必须给出判定时间，文案也要说清适用范围——它只解释 planner 管线的
 * 默认路由，不代表这个账号「废了」：direct（OpenRouter 类）模型两类账号都能钉。
 */
function ClassifyTag({ record }: { record: AccountClassRecord | null }) {
  const { t, lang } = useI18n();
  const kind = record?.class ?? 'unknown';
  const tag = ACCOUNT_CLASS_TAG[kind];
  const checked = record?.checkedAt
    ? t('accounts.class.checkedAt', { time: fmtUsed(record.checkedAt, lang) })
    : t('accounts.class.neverChecked');
  const tip = (
    <span>
      {checked}
      {record?.note ? t('accounts.class.note', { note: record.note }) : ''}
      <br />
      {t('accounts.class.scope')}
    </span>
  );
  return (
    <Tooltip title={tip}>
      <Tag color={tag.color} style={{ margin: 0 }}>
        {t(tag.labelKey)}
      </Tag>
    </Tooltip>
  );
}

/**
 * 到期徽标。三种形态之外还有一条常被误解的规则：**到期不会自动停用账号**。
 * 日期可能只是没续上，停用是破坏性动作——所以这里只标记，不改变行为。
 */
function ExpiryTag({ expiry, expiresAt }: { expiry: ExpiryState; expiresAt: string | null }) {
  const { t } = useI18n();
  if (expiry.kind === 'none' || !expiresAt) {
    return (
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {t('accounts.expiry.none')}
      </Typography.Text>
    );
  }
  if (expiry.kind === 'expired') {
    return (
      <Tooltip title={t('accounts.expiry.expiredTip', { date: expiresAt })}>
        <Tag color="red" style={{ margin: 0 }}>
          {expiry.days !== null
            ? t('accounts.expiry.expired', { days: Math.abs(expiry.days) })
            : t('accounts.expiry.expiredOnly')}
        </Tag>
      </Tooltip>
    );
  }
  if (expiry.kind === 'soon' && expiry.days !== null) {
    return (
      <Tooltip title={t('accounts.expiry.soonTip', { date: expiresAt })}>
        <Tag color="gold" style={{ margin: 0 }}>
          {expiry.days === 0 ? t('accounts.expiry.today') : t('accounts.expiry.inDays', { days: expiry.days })}
        </Tag>
      </Tooltip>
    );
  }
  return (
    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
      {t('accounts.expiry.on', { date: expiresAt })}
    </Typography.Text>
  );
}

export default function Accounts() {
  const { message } = App.useApp();
  const { t, lang } = useI18n();
  const qc = useQueryClient();
  const accounts = useAccounts();
  const meta = useMeta();
  // 判定模型的下拉选项取控制台网关的订阅清单（判定模型是全局的，与当前查看哪个网关无关）
  const models = useModels(meta.data?.consoleGatewayId ?? '');
  const save = useSaveAccounts();
  const testKey = useTestAccount();
  const classify = useClassifyAccounts();
  const [modal, setModal] = useState<EditModal | null>(null);

  const data = accounts.data;
  const rows = data?.accounts ?? [];
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
  const commit = (next: { accounts?: DraftAccount[]; classifyModel?: string }, note: string): void => {
    const nextAccounts = next.accounts ?? draftFromServer();
    const nextModel = next.classifyModel ?? classifyModel;
    // 乐观更新缓存：连续操作（连点开关）时，下一次 draftFromServer()
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
            classifyModel: nextModel,
          }
        : old,
    );
    save.mutate(
      { payload: { accounts: nextAccounts, classifyModel: nextModel }, note },
      { onSuccess: () => qc.invalidateQueries({ queryKey: qk.accounts }) },
    );
  };

  const testAccount = (name: string): void => {
    testKey.mutate({ payload: { name }, label: name });
  };

  const submitModal = (): void => {
    if (!modal) return;
    const name = modal.name.trim() || `账号${rows.length + 1}`;
    const key = modal.key.trim();
    if (modal.index === null && !key) {
      message.warning(t('accounts.validate.keyRequired'));
      return;
    }
    const draft = draftFromServer();
    const editing = modal.index !== null;
    if (modal.index === null) {
      draft.push({ name, key, enabled: true, expiresAt: modal.expiresAt, existingIndex: null });
    } else {
      draft[modal.index] = { ...(draft[modal.index] as DraftAccount), name, key, expiresAt: modal.expiresAt };
    }
    commit({ accounts: draft }, editing ? t('accounts.note.updated', { name }) : t('accounts.note.added', { name }));
    setModal(null);
  };

  const removeAccount = (i: number): void => {
    const name = rows[i]?.name ?? t('common.none');
    const draft = draftFromServer().filter((_, j) => j !== i);
    commit({ accounts: draft }, t('accounts.note.deleted', { name }));
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <PageHeader
        title={t('accounts.title')}
        desc={t('accounts.desc')}
        actions={
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => setModal({ index: null, name: '', key: '', expiresAt: null })}
          >
            {t('accounts.add')}
          </Button>
        }
      />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {/* 体检设置：判定模型是全局的（判定的是账号，不是网关） */}
        <Panel title={t('accounts.settings.title')} extra={<PanelHint>{t('accounts.settings.hint')}</PanelHint>}>
          <div style={{ display: 'grid', gap: 8 }}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {t('accounts.settings.model')}
            </Typography.Text>
            <Select
              style={{ width: 280, fontFamily: 'var(--cps-font-mono)' }}
              showSearch
              value={classifyModel || undefined}
              onChange={(v: string) => commit({ classifyModel: v }, t('accounts.note.modelChanged', { model: v }))}
              options={classifyOptions}
            />
            <Typography.Text type="secondary" style={{ fontSize: 12, lineHeight: '18px' }}>
              {t('accounts.settings.modelHint')}
            </Typography.Text>
          </div>
        </Panel>

        {/* 账号名单 */}
        <Panel
          title={t('accounts.panel.title')}
          extra={
            <Space size={12} align="center">
              <PanelHint>{t('common.count', { count: rows.length })}</PanelHint>
              {unclassified > 0 && <PanelHint>{t('accounts.panel.unclassified', { count: unclassified })}</PanelHint>}
              {noExpiry > 0 && <PanelHint>{t('accounts.panel.noExpiry', { count: noExpiry })}</PanelHint>}
              <Button
                size="small"
                icon={<MedicineBoxOutlined />}
                loading={classify.isPending}
                disabled={!rows.some((a) => a.enabled)}
                onClick={() => classify.mutate({})}
              >
                {t('accounts.panel.classifyAll')}
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
              message={t('accounts.loadFailed')}
              description={t('accounts.loadFailed.desc')}
              action={
                <Button size="small" onClick={() => void accounts.refetch()}>
                  {t('common.retry')}
                </Button>
              }
            />
          ) : accounts.isLoading && !data ? (
            <div style={{ padding: 16 }}>
              <Skeleton active paragraph={{ rows: 4 }} />
            </div>
          ) : rows.length === 0 ? (
            <div style={{ padding: '32px 16px' }}>
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('accounts.empty')}>
                <Button
                  type="primary"
                  icon={<PlusOutlined />}
                  onClick={() => setModal({ index: null, name: '', key: '', expiresAt: null })}
                >
                  {t('accounts.add')}
                </Button>
              </Empty>
            </div>
          ) : (
            <div>
              {rows.map((a, i) => {
                const st = data?.stats[a.name];
                const testingThis =
                  classify.isPending &&
                  ((classify.variables?.names?.length ?? 0) > 0
                    ? classify.variables?.names?.includes(a.name)
                    : a.enabled);
                return (
                  <div key={`${a.name}-${a.keyMasked}`} className="cps-list-row">
                    {/* width:100% 让名字列（flex:1）吃掉空白，操作按钮才落在右缘 */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 16, width: '100%' }}>
                      <div style={{ flex: 1, minWidth: 0, display: 'grid', gap: 6 }}>
                        {/* 名称行带两个徽标：扫一眼就知道「这个号能不能用 / 什么时候到期」 */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', minWidth: 0 }}>
                          <Typography.Text strong>{a.name || t('accounts.unnamed')}</Typography.Text>
                          <ClassifyTag record={a.classify} />
                          <ExpiryTag expiry={a.expiry} expiresAt={a.expiresAt} />
                        </div>
                        <Typography.Text code style={{ fontSize: 12 }}>
                          {a.keyMasked}
                        </Typography.Text>
                      </div>

                      <div style={{ display: 'grid', gap: 4, justifyItems: 'end', minWidth: 118 }}>
                        <Typography.Text style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>
                          {t('common.requests', { count: st?.requests ?? 0 })}
                        </Typography.Text>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          {st?.lastUsed ? fmtUsed(st.lastUsed, lang) : t('accounts.usage.neverUsed')}
                        </Typography.Text>
                        {st?.lastError && (
                          <Typography.Text type="danger" style={{ fontSize: 12 }} ellipsis={{ tooltip: st.lastError }}>
                            {t('accounts.usage.error')}
                          </Typography.Text>
                        )}
                      </div>

                      <Tooltip title={a.enabled ? t('accounts.switch.on') : t('accounts.switch.off')}>
                        <Switch
                          size="small"
                          checked={a.enabled}
                          onChange={(v) => {
                            const draft = draftFromServer();
                            draft[i] = { ...(draft[i] as DraftAccount), enabled: v };
                            commit(
                              { accounts: draft },
                              v
                                ? t('accounts.note.enabled', { name: a.name })
                                : t('accounts.note.disabled', { name: a.name }),
                            );
                          }}
                        />
                      </Tooltip>

                      <Space size={4}>
                        <Tooltip title={t('accounts.action.test.tip')}>
                          <Button
                            size="small"
                            loading={
                              testKey.isPending &&
                              testKey.variables !== undefined &&
                              'name' in testKey.variables.payload &&
                              testKey.variables.payload.name === a.name
                            }
                            onClick={() => testAccount(a.name)}
                          >
                            {t('accounts.action.test')}
                          </Button>
                        </Tooltip>
                        <Tooltip title={t('accounts.action.classify.tip')}>
                          <Button
                            size="small"
                            icon={<MedicineBoxOutlined />}
                            aria-label={t('accounts.panel.classifyAll')}
                            loading={testingThis}
                            disabled={classify.isPending && !testingThis}
                            onClick={() => classify.mutate({ names: [a.name] })}
                          />
                        </Tooltip>
                        <Tooltip title={t('accounts.action.edit.tip')}>
                          <Button
                            size="small"
                            type="text"
                            icon={<EditOutlined />}
                            aria-label={t('common.edit')}
                            onClick={() => setModal({ index: i, name: a.name, key: '', expiresAt: a.expiresAt })}
                          />
                        </Tooltip>
                        <Popconfirm
                          title={t('accounts.delete.title', { name: a.name })}
                          description={t('accounts.delete.desc')}
                          okText={t('common.delete')}
                          okButtonProps={{ danger: true }}
                          cancelText={t('common.cancel')}
                          onConfirm={() => removeAccount(i)}
                        >
                          <Button
                            size="small"
                            type="text"
                            danger
                            icon={<DeleteOutlined />}
                            aria-label={t('accounts.action.delete.tip')}
                          />
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
        title={modal?.index === null ? t('accounts.modal.add') : t('accounts.modal.edit')}
        okText={t('common.save')}
        cancelText={t('common.cancel')}
        onOk={submitModal}
        onCancel={() => setModal(null)}
        destroyOnHidden
      >
        <Space direction="vertical" style={{ width: '100%' }}>
          <div>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {t('accounts.field.name')}
            </Typography.Text>
            <Input
              style={{ marginTop: 4 }}
              placeholder={t('accounts.field.name.placeholder')}
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
                  : t('accounts.field.key.placeholderKeep', { tail: rows[modal?.index ?? 0]?.keyTail ?? '' })
              }
              value={modal?.key ?? ''}
              onChange={(e) => setModal((m) => (m ? { ...m, key: e.target.value } : m))}
            />
          </div>
          <div>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {t('accounts.field.expiry')}
            </Typography.Text>
            <DatePicker
              style={{ marginTop: 4, width: '100%' }}
              placeholder={t('accounts.field.expiry.placeholder')}
              value={modal?.expiresAt ? dayjs(modal.expiresAt) : null}
              onChange={(d) => setModal((m) => (m ? { ...m, expiresAt: d ? d.format('YYYY-MM-DD') : null } : m))}
            />
            <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 6 }}>
              {t('accounts.field.expiry.hint')}
            </Typography.Text>
          </div>
        </Space>
      </Modal>
    </div>
  );
}

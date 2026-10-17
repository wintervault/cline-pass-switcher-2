import { DeleteOutlined, EditOutlined, PlusOutlined, StarFilled, StarOutlined } from '@ant-design/icons';
import {
  Alert,
  Button,
  Checkbox,
  Drawer,
  Input,
  InputNumber,
  Popconfirm,
  Select,
  Skeleton,
  Space,
  Switch,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import { useState } from 'react';

import { useAccounts, useDeleteGateway, useGateways, useSaveGateway, useSetConsoleGateway } from '../api/hooks.ts';
import type { AccountMode, FailoverConfig, GatewayView } from '../api/types.ts';
import { useFeedback } from '../feedback.ts';
import { type MsgKey, useI18n } from '../i18n/index.tsx';
import { PageHeader } from '../pageHeader.tsx';
import { Panel, PanelHint } from '../panel.tsx';

/**
 * 网关 = 一个独立的接入面（端口 + 密钥 + 账号子集 + 账号策略 + 模型清单与路由配置）。
 *
 * 这一页承担了 3.0 之前「访问与安全」的全部内容：接入地址、API Key、CORS、目录暴露
 * 本来就是接入面的属性，多网关后只能按网关编辑——单独一页会立刻变成「编辑的是哪一个」。
 */

const STATE_TAG: Record<GatewayView['status']['state'], { color: string; labelKey: MsgKey }> = {
  running: { color: 'green', labelKey: 'gateways.state.running' },
  error: { color: 'red', labelKey: 'gateways.state.error' },
  stopped: { color: 'default', labelKey: 'gateways.state.stopped' },
};

const ACCOUNT_MODE_OPTIONS: Array<{ value: AccountMode; labelKey: MsgKey }> = [
  { value: 'sticky', labelKey: 'gateways.mode.sticky' },
  { value: 'single', labelKey: 'gateways.mode.single' },
  { value: 'roundrobin', labelKey: 'gateways.mode.roundrobin' },
];

const MODE_HINT: Record<AccountMode, MsgKey> = {
  sticky: 'gateways.mode.hint.sticky',
  single: 'gateways.mode.hint.single',
  roundrobin: 'gateways.mode.hint.roundrobin',
};

const FAILOVER_FIELDS: Array<{ key: keyof FailoverConfig; labelKey: MsgKey; hintKey: MsgKey; step: number }> = [
  {
    key: 'attemptTimeoutMs',
    labelKey: 'gateways.failover.attemptTimeoutMs',
    hintKey: 'gateways.failover.attemptTimeoutMs.hint',
    step: 1000,
  },
  {
    key: 'idleTimeoutMs',
    labelKey: 'gateways.failover.idleTimeoutMs',
    hintKey: 'gateways.failover.idleTimeoutMs.hint',
    step: 1000,
  },
  { key: 'budgetMs', labelKey: 'gateways.failover.budgetMs', hintKey: 'gateways.failover.budgetMs.hint', step: 1000 },
  {
    key: 'retriesPerChannel',
    labelKey: 'gateways.failover.retriesPerChannel',
    hintKey: 'gateways.failover.retriesPerChannel.hint',
    step: 1,
  },
  {
    key: 'cooldownMs',
    labelKey: 'gateways.failover.cooldownMs',
    hintKey: 'gateways.failover.cooldownMs.hint',
    step: 10000,
  },
  {
    key: 'retryBackoffMs',
    labelKey: 'gateways.failover.retryBackoffMs',
    hintKey: 'gateways.failover.retryBackoffMs.hint',
    step: 100,
  },
];

/** 编辑抽屉的表单状态。 */
interface Draft {
  /** true = 新建；false = 编辑已有网关 */
  created: boolean;
  id: string;
  name: string;
  port: number;
  bindHost: string;
  /** 留空 = 保持原密钥（控制台拿不到明文） */
  proxyKey: string;
  clearKey: boolean;
  publicBaseUrl: string;
  corsOrigins: string;
  exposeCatalog: boolean;
  /** 使用全部账号（= 配置里的空数组） */
  allAccounts: boolean;
  accounts: string[];
  accountMode: AccountMode;
  activeAccount: string;
  failover: FailoverConfig;
}

function draftOf(gateway: GatewayView): Draft {
  return {
    created: false,
    id: gateway.id,
    name: gateway.name,
    port: gateway.port,
    bindHost: gateway.bindHost,
    proxyKey: '',
    clearKey: false,
    publicBaseUrl: gateway.publicBaseUrl,
    corsOrigins: gateway.corsOrigins.join('\n'),
    exposeCatalog: gateway.exposeCatalog,
    allAccounts: gateway.allAccounts,
    accounts: gateway.accounts,
    accountMode: gateway.accountMode,
    activeAccount: gateway.activeAccount,
    failover: gateway.failover,
  };
}

function emptyDraft(): Draft {
  return {
    created: true,
    id: '',
    name: '',
    port: 3124,
    bindHost: '127.0.0.1',
    proxyKey: '',
    clearKey: false,
    publicBaseUrl: '',
    corsOrigins: '',
    exposeCatalog: false,
    allAccounts: true,
    accounts: [],
    accountMode: 'sticky',
    activeAccount: '',
    failover: {
      attemptTimeoutMs: 60000,
      idleTimeoutMs: 60000,
      budgetMs: 90000,
      retriesPerChannel: 1,
      cooldownMs: 300000,
      retryBackoffMs: 500,
    },
  };
}

/** 一个网关的列表行。 */
function GatewayRow({
  gateway,
  isConsole,
  busy,
  onEdit,
  onSetConsole,
  onDelete,
}: {
  gateway: GatewayView;
  isConsole: boolean;
  busy: boolean;
  onEdit: () => void;
  onSetConsole: () => void;
  onDelete: () => void;
}) {
  const { t } = useI18n();
  const state = STATE_TAG[gateway.status.state];
  return (
    <div className="cps-list-row">
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, width: '100%' }}>
        <div style={{ flex: 1, minWidth: 0, display: 'grid', gap: 6 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <Typography.Text strong>{gateway.name}</Typography.Text>
            {isConsole && (
              <Tooltip title={t('gateways.console.tip')}>
                <Tag color="blue" style={{ margin: 0 }}>
                  {t('gateways.console.badge')}
                </Tag>
              </Tooltip>
            )}
            <Tooltip title={gateway.status.error ?? undefined}>
              <Tag color={state.color} style={{ margin: 0 }}>
                {t(state.labelKey)}
                {gateway.status.state === 'running' && gateway.status.boundPort ? ` :${gateway.status.boundPort}` : ''}
              </Tag>
            </Tooltip>
            {gateway.status.state === 'error' && (
              <Typography.Text type="danger" style={{ fontSize: 12 }} ellipsis={{ tooltip: gateway.status.error }}>
                {gateway.status.error}
              </Typography.Text>
            )}
          </div>
          <Space size={16} wrap>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {gateway.id}
            </Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {t('gateways.accountCount', { count: gateway.accountCount })}
            </Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {t('gateways.modelCount', { count: gateway.modelCount })}
            </Typography.Text>
            <Typography.Text
              copyable={{ text: gateway.proxyBase, tooltips: [t('gateways.copy.address'), t('common.copied')] }}
            >
              <span className="cps-mono" style={{ fontSize: 12 }}>
                {gateway.proxyBase}
              </span>
            </Typography.Text>
          </Space>
        </div>

        <Space size={4}>
          <Tooltip title={isConsole ? t('gateways.action.consoleAlready') : t('gateways.action.console')}>
            <Button
              size="small"
              type="text"
              disabled={isConsole || busy}
              icon={isConsole ? <StarFilled /> : <StarOutlined />}
              aria-label={t('gateways.action.console')}
              onClick={onSetConsole}
            />
          </Tooltip>
          <Tooltip title={t('gateways.action.edit')}>
            <Button size="small" type="text" icon={<EditOutlined />} aria-label={t('common.edit')} onClick={onEdit} />
          </Tooltip>
          <Popconfirm
            title={t('gateways.delete.title', { name: gateway.name })}
            description={isConsole ? t('gateways.delete.consoleDesc') : t('gateways.delete.desc')}
            okText={t('common.delete')}
            okButtonProps={{ danger: true, disabled: isConsole }}
            cancelText={t('common.cancel')}
            onConfirm={onDelete}
          >
            <Button
              size="small"
              type="text"
              danger
              disabled={isConsole}
              icon={<DeleteOutlined />}
              aria-label={t('gateways.action.delete')}
            />
          </Popconfirm>
        </Space>
      </div>
    </div>
  );
}

export default function Gateways() {
  const { t } = useI18n();
  const gateways = useGateways();
  const accounts = useAccounts();
  const save = useSaveGateway();
  const remove = useDeleteGateway();
  const setConsole = useSetConsoleGateway();
  const fb = useFeedback();
  const [draft, setDraft] = useState<Draft | null>(null);

  const list = gateways.data?.gateways ?? [];
  const consoleId = gateways.data?.consoleGatewayId ?? 'main';
  const maxGateways = gateways.data?.maxGateways ?? 8;
  const accountNames = (accounts.data?.accounts ?? []).map((a) => a.name);
  const scopeNames = draft?.allAccounts ? accountNames : (draft?.accounts ?? []);

  const submit = (): void => {
    if (!draft) return;
    const name = draft.name.trim();
    if (!name) {
      fb.fail(t('gateways.validate.name'));
      return;
    }
    const id = draft.id.trim();
    if (draft.created && !/^[a-z0-9][a-z0-9-]{0,31}$/.test(id)) {
      fb.fail(t('gateways.validate.id'), t('gateways.validate.id.current', { id: id || '—' }));
      return;
    }
    if (!draft.allAccounts && draft.accounts.length === 0) {
      fb.fail(t('gateways.validate.accounts'));
      return;
    }
    const gateway: Record<string, unknown> = {
      id,
      name,
      port: draft.port,
      bindHost: draft.bindHost.trim(),
      publicBaseUrl: draft.publicBaseUrl.trim(),
      corsOrigins: draft.corsOrigins
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean),
      exposeCatalog: draft.exposeCatalog,
      allAccounts: draft.allAccounts,
      accounts: draft.allAccounts ? [] : draft.accounts,
      accountMode: draft.accountMode,
      activeAccount: draft.accountMode === 'single' ? draft.activeAccount : '',
      failover: draft.failover,
    };
    // proxyKey 三态：只有用户真的输入/清除时才带上这个字段
    if (draft.clearKey) gateway['proxyKey'] = null;
    else if (draft.proxyKey.trim()) gateway['proxyKey'] = draft.proxyKey.trim();

    save.mutate(
      {
        gateway,
        created: draft.created,
        note: draft.created ? t('gateways.note.created', { name }) : t('gateways.note.saved', { name }),
      },
      { onSuccess: () => setDraft(null) },
    );
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <PageHeader
        title={t('gateways.title')}
        desc={t('gateways.desc')}
        actions={
          <Tooltip
            title={list.length >= maxGateways ? t('gateways.create.limit', { max: maxGateways }) : t('gateways.create')}
          >
            <Button
              type="primary"
              icon={<PlusOutlined />}
              disabled={list.length >= maxGateways}
              onClick={() => setDraft(emptyDraft())}
            >
              {t('gateways.create')}
            </Button>
          </Tooltip>
        }
      />

      <Panel
        title={t('gateways.list.title')}
        extra={<PanelHint>{t('gateways.list.hint', { count: list.length })}</PanelHint>}
        flush
      >
        {gateways.isError ? (
          <Alert
            type="error"
            showIcon
            style={{ margin: 16 }}
            message={t('gateways.loadFailed')}
            description={t('gateways.loadFailed.desc')}
            action={
              <Button size="small" onClick={() => void gateways.refetch()}>
                {t('common.retry')}
              </Button>
            }
          />
        ) : gateways.isLoading && !gateways.data ? (
          <div style={{ padding: 16 }}>
            <Skeleton active paragraph={{ rows: 3 }} />
          </div>
        ) : (
          <div>
            {list.map((gateway) => (
              <GatewayRow
                key={gateway.id}
                gateway={gateway}
                isConsole={gateway.id === consoleId}
                busy={save.isPending || remove.isPending || setConsole.isPending}
                onEdit={() => setDraft(draftOf(gateway))}
                onSetConsole={() =>
                  setConsole.mutate({
                    id: gateway.id,
                    name: gateway.name,
                    url: gateway.proxyBase.replace(/\/v1\/?$/, ''),
                  })
                }
                onDelete={() => remove.mutate({ id: gateway.id, name: gateway.name })}
              />
            ))}
          </div>
        )}
      </Panel>

      <Drawer
        open={draft !== null}
        width={560}
        title={draft?.created ? t('gateways.drawer.create') : t('gateways.drawer.edit', { name: draft?.name ?? '' })}
        onClose={() => setDraft(null)}
        destroyOnHidden
        extra={
          <Space>
            <Button onClick={() => setDraft(null)}>{t('common.cancel')}</Button>
            <Button type="primary" loading={save.isPending} onClick={submit}>
              {t('common.save')}
            </Button>
          </Space>
        }
      >
        {draft && (
          <div style={{ display: 'grid', gap: 18 }}>
            <div className="cps-field">
              <div className="cps-field-label">
                <Typography.Text style={{ fontSize: 13 }}>{t('gateways.field.name')}</Typography.Text>
              </div>
              <div className="cps-field-body">
                <Input
                  placeholder={t('gateways.field.name.placeholder')}
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                />
              </div>
            </div>

            <div className="cps-field">
              <div className="cps-field-label">
                <Typography.Text style={{ fontSize: 13 }}>{t('gateways.field.id')}</Typography.Text>
              </div>
              <div className="cps-field-body">
                <Input
                  className="cps-mono"
                  placeholder={t('gateways.field.id.placeholder')}
                  disabled={!draft.created}
                  value={draft.id}
                  onChange={(e) => setDraft({ ...draft, id: e.target.value.toLowerCase() })}
                />
                <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 6 }}>
                  {t('gateways.field.id.hint')}
                </Typography.Text>
              </div>
            </div>

            <div className="cps-field">
              <div className="cps-field-label">
                <Typography.Text style={{ fontSize: 13 }}>{t('gateways.field.port')}</Typography.Text>
              </div>
              <div className="cps-field-body">
                <Space size={12} align="center">
                  <InputNumber
                    min={1}
                    max={65535}
                    value={draft.port}
                    onChange={(v) => setDraft({ ...draft, port: Number(v ?? 3124) })}
                    style={{ width: 140 }}
                  />
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {t('gateways.field.bindHost')}
                  </Typography.Text>
                  <Input
                    value={draft.bindHost}
                    onChange={(e) => setDraft({ ...draft, bindHost: e.target.value })}
                    style={{ width: 160 }}
                  />
                </Space>
                <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 6 }}>
                  {t('gateways.field.port.hint')}
                </Typography.Text>
              </div>
            </div>

            <div className="cps-field">
              <div className="cps-field-label">
                <Typography.Text style={{ fontSize: 13 }}>{t('gateways.field.key')}</Typography.Text>
              </div>
              <div className="cps-field-body">
                <Input.Password
                  placeholder={
                    draft.created ? t('gateways.field.key.placeholderNew') : t('gateways.field.key.placeholderKeep')
                  }
                  value={draft.proxyKey}
                  disabled={draft.clearKey}
                  onChange={(e) => setDraft({ ...draft, proxyKey: e.target.value })}
                />
                <Checkbox
                  style={{ marginTop: 8 }}
                  checked={draft.clearKey}
                  onChange={(e) => setDraft({ ...draft, clearKey: e.target.checked, proxyKey: '' })}
                >
                  {t('gateways.field.key.clear')}
                </Checkbox>
                <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 6 }}>
                  {t('gateways.field.key.hint')}
                </Typography.Text>
              </div>
            </div>

            <div className="cps-field">
              <div className="cps-field-label">
                <Typography.Text style={{ fontSize: 13 }}>{t('gateways.field.accounts')}</Typography.Text>
              </div>
              <div className="cps-field-body">
                <Space size={12} style={{ marginBottom: 8 }}>
                  <Switch
                    checked={draft.allAccounts}
                    onChange={(v) => setDraft({ ...draft, allAccounts: v, accounts: v ? [] : draft.accounts })}
                  />
                  <Typography.Text style={{ fontSize: 13 }}>{t('gateways.field.accounts.all')}</Typography.Text>
                  <PanelHint>{t('gateways.field.accounts.hint')}</PanelHint>
                </Space>
                {!draft.allAccounts && (
                  <Checkbox.Group
                    value={draft.accounts}
                    onChange={(v) => setDraft({ ...draft, accounts: v.map(String) })}
                    options={accountNames.map((n) => ({ value: n, label: n }))}
                    style={{ display: 'grid', gap: 6 }}
                  />
                )}
              </div>
            </div>

            <div className="cps-field">
              <div className="cps-field-label">
                <Typography.Text style={{ fontSize: 13 }}>{t('gateways.field.mode')}</Typography.Text>
              </div>
              <div className="cps-field-body">
                <Select
                  style={{ width: 280 }}
                  value={draft.accountMode}
                  onChange={(v: AccountMode) => setDraft({ ...draft, accountMode: v })}
                  options={ACCOUNT_MODE_OPTIONS.map((o) => ({ value: o.value, label: t(o.labelKey) }))}
                />
                {draft.accountMode === 'single' && (
                  <Select
                    style={{ width: 280, marginTop: 10 }}
                    placeholder={t('gateways.field.mode.placeholder')}
                    value={draft.activeAccount || undefined}
                    onChange={(v: string) => setDraft({ ...draft, activeAccount: v })}
                    options={scopeNames.map((n) => ({ value: n, label: n }))}
                  />
                )}
                <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 6 }}>
                  {t(MODE_HINT[draft.accountMode])}
                </Typography.Text>
              </div>
            </div>

            <div className="cps-field">
              <div className="cps-field-label">
                <Typography.Text style={{ fontSize: 13 }}>{t('gateways.field.access')}</Typography.Text>
              </div>
              <div className="cps-field-body">
                <Input
                  placeholder={t('gateways.field.publicBase.placeholder')}
                  value={draft.publicBaseUrl}
                  onChange={(e) => setDraft({ ...draft, publicBaseUrl: e.target.value })}
                />
                <Input.TextArea
                  rows={2}
                  style={{ marginTop: 8 }}
                  placeholder={t('gateways.field.cors.placeholder')}
                  value={draft.corsOrigins}
                  onChange={(e) => setDraft({ ...draft, corsOrigins: e.target.value })}
                />
                <Space size={10} style={{ marginTop: 10 }}>
                  <Switch checked={draft.exposeCatalog} onChange={(v) => setDraft({ ...draft, exposeCatalog: v })} />
                  <Typography.Text style={{ fontSize: 13 }}>{t('gateways.field.exposeCatalog')}</Typography.Text>
                </Space>
              </div>
            </div>

            <div className="cps-field">
              <div className="cps-field-label">
                <Typography.Text style={{ fontSize: 13 }}>{t('gateways.field.failover')}</Typography.Text>
              </div>
              <div className="cps-field-body">
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  {FAILOVER_FIELDS.map((field) => (
                    <div key={field.key} style={{ display: 'grid', gap: 4 }}>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        {t(field.labelKey)}
                      </Typography.Text>
                      <InputNumber
                        min={0}
                        step={field.step}
                        value={draft.failover[field.key]}
                        onChange={(v) =>
                          setDraft({
                            ...draft,
                            failover: { ...draft.failover, [field.key]: Number(v ?? 0) },
                          })
                        }
                        style={{ width: '100%' }}
                      />
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        {t(field.hintKey)}
                      </Typography.Text>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}
      </Drawer>
    </div>
  );
}

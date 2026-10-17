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
import { PageHeader } from '../pageHeader.tsx';
import { Panel, PanelHint } from '../panel.tsx';

/**
 * 网关 = 一个独立的接入面（端口 + 密钥 + 账号子集 + 账号策略 + 模型清单与路由配置）。
 *
 * 这一页承担了 3.0 之前「访问与安全」的全部内容：接入地址、API Key、CORS、目录暴露
 * 本来就是接入面的属性，多网关后只能按网关编辑——单独一页会立刻变成「编辑的是哪一个」。
 */

const STATE_TAG: Record<GatewayView['status']['state'], { color: string; label: string }> = {
  running: { color: 'green', label: '运行中' },
  error: { color: 'red', label: '绑定失败' },
  stopped: { color: 'default', label: '未运行' },
};

const ACCOUNT_MODE_OPTIONS: Array<{ value: AccountMode; label: string }> = [
  { value: 'sticky', label: '粘性（推荐 · 保 prompt cache）' },
  { value: 'single', label: '单账号（手动指定）' },
  { value: 'roundrobin', label: '每请求轮转（牺牲缓存）' },
];

const MODE_HINT: Record<AccountMode, string> = {
  sticky: '持续使用当前账号；只有 key 失效 / 额度用完这类账号级错误才轮转到下一个',
  single: '始终使用你指定的那一个账号',
  roundrobin: '每个请求都换一个账号——上游 prompt cache 会全部失效，成本明显更高',
};

const FAILOVER_FIELDS: Array<{ key: keyof FailoverConfig; label: string; hint: string; step: number }> = [
  { key: 'attemptTimeoutMs', label: '单次尝试上限', hint: '多久内要开始有响应（毫秒）', step: 1000 },
  { key: 'idleTimeoutMs', label: '空闲超时', hint: '连续多久没有新数据算卡死（毫秒）', step: 1000 },
  { key: 'budgetMs', label: '故障转移总预算', hint: '整条链封顶，agent 场景绝不久挂（毫秒）', step: 1000 },
  { key: 'retriesPerChannel', label: '同渠道重试次数', hint: '渠道级错误时先重试几次再切换', step: 1 },
  { key: 'cooldownMs', label: '渠道冷却时长', hint: '失败渠道排到候选末尾（毫秒）', step: 10000 },
  { key: 'retryBackoffMs', label: '重试退避基数', hint: '重试之间的等待（毫秒）', step: 100 },
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
    allAccounts: gateway.accounts.length === 0,
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
  const state = STATE_TAG[gateway.status.state];
  return (
    <div className="cps-list-row">
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, width: '100%' }}>
        <div style={{ flex: 1, minWidth: 0, display: 'grid', gap: 6 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <Typography.Text strong>{gateway.name}</Typography.Text>
            {isConsole && (
              <Tooltip title="控制台挂在这个网关上：/api 与页面只在这里提供">
                <Tag color="blue" style={{ margin: 0 }}>
                  控制台
                </Tag>
              </Tooltip>
            )}
            <Tooltip title={gateway.status.error ?? undefined}>
              <Tag color={state.color} style={{ margin: 0 }}>
                {state.label}
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
              {gateway.accountCount} 个账号
            </Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {gateway.modelCount} 个模型
            </Typography.Text>
            <Typography.Text copyable={{ text: gateway.proxyBase, tooltips: ['复制接入地址', '已复制'] }}>
              <span className="cps-mono" style={{ fontSize: 12 }}>
                {gateway.proxyBase}
              </span>
            </Typography.Text>
          </Space>
        </div>

        <Space size={4}>
          <Tooltip title={isConsole ? '已经是控制台网关' : '把控制台（页面与 API）切到这个网关'}>
            <Button
              size="small"
              type="text"
              disabled={isConsole || busy}
              icon={isConsole ? <StarFilled /> : <StarOutlined />}
              aria-label="设为控制台网关"
              onClick={onSetConsole}
            />
          </Tooltip>
          <Tooltip title="编辑端口、密钥、账号范围与策略">
            <Button size="small" type="text" icon={<EditOutlined />} aria-label="编辑网关" onClick={onEdit} />
          </Tooltip>
          <Popconfirm
            title={`删除网关「${gateway.name}」？`}
            description={
              isConsole
                ? '控制台网关不能直接删除：先把控制台切到别的网关。'
                : '删除后这个端口的接入立即停止，模型与路由配置一并移除。'
            }
            okText="删除"
            okButtonProps={{ danger: true, disabled: isConsole }}
            cancelText="取消"
            onConfirm={onDelete}
          >
            <Button
              size="small"
              type="text"
              danger
              disabled={isConsole}
              icon={<DeleteOutlined />}
              aria-label="删除网关"
            />
          </Popconfirm>
        </Space>
      </div>
    </div>
  );
}

export default function Gateways() {
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
      fb.fail('网关名称不能为空');
      return;
    }
    const id = draft.id.trim();
    if (draft.created && !/^[a-z0-9][a-z0-9-]{0,31}$/.test(id)) {
      fb.fail('标识需为 1-32 位小写字母、数字或连字符', `当前：${id || '空'}`);
      return;
    }
    if (!draft.allAccounts && draft.accounts.length === 0) {
      fb.fail('请至少勾选一个账号，或开启「使用全部账号」');
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
        note: draft.created ? `已创建网关「${name}」` : `网关「${name}」设置已保存`,
      },
      { onSuccess: () => setDraft(null) },
    );
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <PageHeader
        title="网关"
        desc="每个网关是一个独立接入面：自己的端口、密钥、账号范围、账号策略与模型路由。客户端连哪个，就用哪一套。"
        actions={
          <Tooltip title={list.length >= maxGateways ? `最多 ${maxGateways} 个网关` : '新建一个接入面'}>
            <Button
              type="primary"
              icon={<PlusOutlined />}
              disabled={list.length >= maxGateways}
              onClick={() => setDraft(emptyDraft())}
            >
              新建网关
            </Button>
          </Tooltip>
        }
      />

      <Panel title="网关列表" extra={<PanelHint>{list.length} 个 · 状态每 2 秒刷新</PanelHint>} flush>
        {gateways.isError ? (
          <Alert
            type="error"
            showIcon
            style={{ margin: 16 }}
            message="网关列表加载失败"
            description="服务可能正在重启；稍候重试，或用状态栏的刷新按钮。"
            action={
              <Button size="small" onClick={() => void gateways.refetch()}>
                重试
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
                onSetConsole={() => setConsole.mutate({ id: gateway.id, name: gateway.name })}
                onDelete={() => remove.mutate({ id: gateway.id, name: gateway.name })}
              />
            ))}
          </div>
        )}
      </Panel>

      <Drawer
        open={draft !== null}
        width={560}
        title={draft?.created ? '新建网关' : `编辑网关「${draft?.name ?? ''}」`}
        onClose={() => setDraft(null)}
        destroyOnHidden
        extra={
          <Space>
            <Button onClick={() => setDraft(null)}>取消</Button>
            <Button type="primary" loading={save.isPending} onClick={submit}>
              保存
            </Button>
          </Space>
        }
      >
        {draft && (
          <div style={{ display: 'grid', gap: 18 }}>
            <div className="cps-field">
              <div className="cps-field-label">
                <Typography.Text style={{ fontSize: 13 }}>名称</Typography.Text>
              </div>
              <div className="cps-field-body">
                <Input
                  placeholder="如：风控号专用"
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                />
              </div>
            </div>

            <div className="cps-field">
              <div className="cps-field-label">
                <Typography.Text style={{ fontSize: 13 }}>标识</Typography.Text>
              </div>
              <div className="cps-field-body">
                <Input
                  className="cps-mono"
                  placeholder="如：risk"
                  disabled={!draft.created}
                  value={draft.id}
                  onChange={(e) => setDraft({ ...draft, id: e.target.value.toLowerCase() })}
                />
                <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 6 }}>
                  用于接口参数与日志，创建后不可修改（小写字母、数字、连字符）。
                </Typography.Text>
              </div>
            </div>

            <div className="cps-field">
              <div className="cps-field-label">
                <Typography.Text style={{ fontSize: 13 }}>端口</Typography.Text>
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
                    绑定地址
                  </Typography.Text>
                  <Input
                    value={draft.bindHost}
                    onChange={(e) => setDraft({ ...draft, bindHost: e.target.value })}
                    style={{ width: 160 }}
                  />
                </Space>
                <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 6 }}>
                  改端口/地址会立即重绑这个网关；绑定失败只影响它自己，原因显示在列表里。
                </Typography.Text>
              </div>
            </div>

            <div className="cps-field">
              <div className="cps-field-label">
                <Typography.Text style={{ fontSize: 13 }}>API Key</Typography.Text>
              </div>
              <div className="cps-field-body">
                <Input.Password
                  placeholder={draft.created ? '留空 = 不鉴权（仅限本机绑定）' : '留空 = 保持不变；输入新值可覆盖'}
                  value={draft.proxyKey}
                  disabled={draft.clearKey}
                  onChange={(e) => setDraft({ ...draft, proxyKey: e.target.value })}
                />
                <Checkbox
                  style={{ marginTop: 8 }}
                  checked={draft.clearKey}
                  onChange={(e) => setDraft({ ...draft, clearKey: e.target.checked, proxyKey: '' })}
                >
                  清除已有密钥（客户端将不需要密钥）
                </Checkbox>
                <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 6 }}>
                  下游客户端访问这个网关的 /v1 时要带它。绑定非回环地址时必须设置。
                </Typography.Text>
              </div>
            </div>

            <div className="cps-field">
              <div className="cps-field-label">
                <Typography.Text style={{ fontSize: 13 }}>账号范围</Typography.Text>
              </div>
              <div className="cps-field-body">
                <Space size={12} style={{ marginBottom: 8 }}>
                  <Switch
                    checked={draft.allAccounts}
                    onChange={(v) => setDraft({ ...draft, allAccounts: v, accounts: v ? [] : draft.accounts })}
                  />
                  <Typography.Text style={{ fontSize: 13 }}>使用全部账号</Typography.Text>
                  <PanelHint>关闭后只勾选的账号参与这个网关</PanelHint>
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
                <Typography.Text style={{ fontSize: 13 }}>账号策略</Typography.Text>
              </div>
              <div className="cps-field-body">
                <Select
                  style={{ width: 280 }}
                  value={draft.accountMode}
                  onChange={(v: AccountMode) => setDraft({ ...draft, accountMode: v })}
                  options={ACCOUNT_MODE_OPTIONS}
                />
                {draft.accountMode === 'single' && (
                  <Select
                    style={{ width: 280, marginTop: 10 }}
                    placeholder="选择使用的账号"
                    value={draft.activeAccount || undefined}
                    onChange={(v: string) => setDraft({ ...draft, activeAccount: v })}
                    options={scopeNames.map((n) => ({ value: n, label: n }))}
                  />
                )}
                <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 6 }}>
                  {MODE_HINT[draft.accountMode]}
                </Typography.Text>
              </div>
            </div>

            <div className="cps-field">
              <div className="cps-field-label">
                <Typography.Text style={{ fontSize: 13 }}>接入展示</Typography.Text>
              </div>
              <div className="cps-field-body">
                <Input
                  placeholder="公网地址（可选），如 https://pass.example.com"
                  value={draft.publicBaseUrl}
                  onChange={(e) => setDraft({ ...draft, publicBaseUrl: e.target.value })}
                />
                <Input.TextArea
                  rows={2}
                  style={{ marginTop: 8 }}
                  placeholder={'CORS 白名单，每行一个 Origin（留空 = 不发跨域头）'}
                  value={draft.corsOrigins}
                  onChange={(e) => setDraft({ ...draft, corsOrigins: e.target.value })}
                />
                <Space size={10} style={{ marginTop: 10 }}>
                  <Switch checked={draft.exposeCatalog} onChange={(v) => setDraft({ ...draft, exposeCatalog: v })} />
                  <Typography.Text style={{ fontSize: 13 }}>
                    /v1/models 返回完整目录（默认只返回订阅模型）
                  </Typography.Text>
                </Space>
              </div>
            </div>

            <div className="cps-field">
              <div className="cps-field-label">
                <Typography.Text style={{ fontSize: 13 }}>失败转移</Typography.Text>
              </div>
              <div className="cps-field-body">
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  {FAILOVER_FIELDS.map((field) => (
                    <div key={field.key} style={{ display: 'grid', gap: 4 }}>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        {field.label}
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
                        {field.hint}
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

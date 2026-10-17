import {
  CheckCircleFilled,
  CloseCircleFilled,
  ExclamationCircleFilled,
  FileTextOutlined,
  KeyOutlined,
  LoadingOutlined,
  LockOutlined,
  MoonOutlined,
  PauseCircleOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  SunOutlined,
  SyncOutlined,
  TranslationOutlined,
} from '@ant-design/icons';
import { Button, Dropdown, Space, Tooltip, Typography, theme } from 'antd';

import type { HostControl } from './hostBridge.ts';
import { type Lang, type MsgKey, useI18n } from './i18n/index.tsx';

/**
 * 常驻状态栏。三个分区，各司其职（左→右 = 从「服务活着吗」到「我怎么连它」到「这个应用本身」）：
 *
 * ① 服务：状态点 + 状态词 + 启停控制。每个动作都有回执（失败一定看得见）。
 * ② 接入：控制台网关的 BASE URL 与它的密钥。地址和密钥放在一起，且都写明标签。
 * ③ 应用：版本、语言、主题、刷新。
 *
 * 3.0 P4：「清除本机保存的访问密钥」从状态栏移除，换成语言切换——远端用户忘了密钥时
 * 的恢复路径写在访问面板里（清站点数据 / 换一把密钥），不需要一个反直觉的「登出」按钮。
 */

const STATE_COLOR: Record<string, string> = {
  running: '#52c41a',
  starting: '#faad14',
  stopping: '#faad14',
  stopped: 'var(--ant-color-text-quaternary)',
  error: '#ff4d4f',
};

const STATE_ICON: Record<string, typeof CheckCircleFilled> = {
  running: CheckCircleFilled,
  starting: ExclamationCircleFilled,
  stopping: ExclamationCircleFilled,
  stopped: CloseCircleFilled,
  error: CloseCircleFilled,
};

const STATE_KEY: Record<string, MsgKey> = {
  running: 'service.state.running',
  starting: 'service.state.starting',
  stopping: 'service.state.stopping',
  stopped: 'service.state.stopped',
  error: 'service.state.error',
};

/** 状态栏里的一格：小号灰色标签 + 值。标签是「这是什么」不该靠猜。 */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Space size={6} align="center">
      <Typography.Text style={{ fontSize: 12, color: 'var(--ant-color-text-quaternary)' }}>{label}</Typography.Text>
      {children}
    </Space>
  );
}

function ServiceCluster({ control }: { control: HostControl }) {
  const { token } = theme.useToken();
  const { t } = useI18n();
  const { status, busy } = control;
  if (!control.host) return null;

  const Icon = busy ? LoadingOutlined : (STATE_ICON[status.state] ?? CloseCircleFilled);
  const color = STATE_COLOR[status.state] ?? token.colorTextSecondary;
  const label = t(STATE_KEY[status.state] ?? 'service.state.stopped');

  return (
    <Space size={10} align="center">
      <Tooltip
        title={
          status.port ? t('service.channel.title', { addr: `127.0.0.1:${status.port}` }) : t('service.channel.missing')
        }
      >
        <Space size={6} align="center">
          <Icon style={{ color, fontSize: 12 }} />
          <Typography.Text style={{ fontSize: 13, color: token.colorText }}>{label}</Typography.Text>
        </Space>
      </Tooltip>
      {status.state === 'stopped' || status.state === 'error' ? (
        <Tooltip title={t('service.action.start')}>
          <Button
            size="small"
            type="primary"
            ghost
            icon={<PlayCircleOutlined />}
            loading={busy}
            onClick={() => void control.start()}
          >
            {t('service.action.start')}
          </Button>
        </Tooltip>
      ) : (
        <Space size={2}>
          <Tooltip title={t('service.action.stop')}>
            <Button
              size="small"
              type="text"
              icon={<PauseCircleOutlined />}
              loading={busy}
              onClick={() => void control.stop()}
            />
          </Tooltip>
          <Tooltip title={t('service.action.restart')}>
            <Button
              size="small"
              type="text"
              icon={<SyncOutlined />}
              loading={busy}
              onClick={() => void control.restart()}
            />
          </Tooltip>
        </Space>
      )}
      <Tooltip title={t('service.action.logs')}>
        <Button size="small" type="text" icon={<FileTextOutlined />} onClick={control.openLogs} />
      </Tooltip>
    </Space>
  );
}

export function StatusBar({
  control,
  proxyBase,
  authRequired,
  version,
  onOpenGateways,
  mode,
  lang,
  onToggleLang,
  onToggleTheme,
  onRefresh,
}: {
  control: HostControl;
  proxyBase?: string;
  authRequired?: boolean;
  version?: string;
  onOpenGateways: () => void;
  mode: 'light' | 'dark';
  lang: Lang;
  onToggleLang: (lang: Lang) => void;
  onToggleTheme: () => void;
  onRefresh: () => void;
}) {
  const { token } = theme.useToken();
  const { t } = useI18n();
  return (
    <div
      style={{
        height: 54,
        flex: '0 0 auto',
        display: 'flex',
        alignItems: 'center',
        gap: 22,
        padding: '0 18px',
        background: token.colorBgContainer,
        borderTop: `1px solid ${token.colorBorderSecondary}`,
        overflowX: 'auto',
      }}
    >
      <ServiceCluster control={control} />

      {/* 接入信息：地址与密钥同区，各自带标签 */}
      <Space size={18} align="center" style={{ minWidth: 0 }}>
        <Field label={t('statusbar.address')}>
          {proxyBase ? (
            <Typography.Text
              copyable={{ text: proxyBase, tooltips: [t('statusbar.address.copy'), t('common.copied')] }}
              style={{ fontSize: 13, fontFamily: 'var(--cps-font-mono)' }}
            >
              {proxyBase}
            </Typography.Text>
          ) : (
            <Typography.Text type="secondary" style={{ fontSize: 13 }}>
              {t('statusbar.notReady')}
            </Typography.Text>
          )}
        </Field>
        <Field label={t('statusbar.key')}>
          <Tooltip title={authRequired ? t('statusbar.key.tip.set') : t('statusbar.key.tip.unset')}>
            <Button
              size="small"
              type="link"
              icon={authRequired ? <LockOutlined /> : <KeyOutlined />}
              style={{ fontSize: 13, padding: 0, height: 'auto' }}
              onClick={onOpenGateways}
            >
              {authRequired ? t('statusbar.key.set') : t('statusbar.key.unset')}
            </Button>
          </Tooltip>
        </Field>
      </Space>

      <Space size={2} style={{ marginLeft: 'auto' }}>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          v{version ?? '…'}
        </Typography.Text>
        {/* 语言切换：即时生效，不刷新页面 */}
        <Dropdown
          trigger={['click']}
          menu={{
            selectable: true,
            selectedKeys: [lang],
            items: [
              { key: 'zh-CN', label: '中文' },
              { key: 'en-US', label: 'English' },
            ],
            onClick: ({ key }) => onToggleLang(key as Lang),
          }}
        >
          <Tooltip title={t('app.lang.switch')}>
            <Button size="small" type="text" icon={<TranslationOutlined />} aria-label={t('app.lang.switch')} />
          </Tooltip>
        </Dropdown>
        <Tooltip title={mode === 'dark' ? t('statusbar.theme.dark') : t('statusbar.theme.light')}>
          <Button
            size="small"
            type="text"
            icon={mode === 'dark' ? <SunOutlined /> : <MoonOutlined />}
            onClick={onToggleTheme}
          />
        </Tooltip>
        <Tooltip title={t('statusbar.refresh')}>
          <Button size="small" type="text" icon={<ReloadOutlined />} onClick={onRefresh} />
        </Tooltip>
      </Space>
    </div>
  );
}

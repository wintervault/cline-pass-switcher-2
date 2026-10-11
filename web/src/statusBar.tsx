import {
  CheckCircleFilled,
  CloseCircleFilled,
  ExclamationCircleFilled,
  FileTextOutlined,
  KeyOutlined,
  LoadingOutlined,
  LockOutlined,
  LogoutOutlined,
  MoonOutlined,
  PauseCircleOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  SunOutlined,
  SyncOutlined,
} from '@ant-design/icons';
import { Button, Space, Tooltip, Typography, theme } from 'antd';

import { setAuthKey } from './api/client.ts';
import { HOST_LABEL, type HostControl } from './hostBridge.ts';

/**
 * 常驻状态栏。三个分区，各司其职（左→右 = 从「服务活着吗」到「我怎么连它」到「这个应用本身」）：
 *
 * ① 服务：状态点 + 状态词 + 启停控制。以前只有一个红点加一句「已停止」，
 *    既可能误报（壳的 IPC 不通时永远显示已停止），也没有承载控制动作——
 *    现在这里是唯一的服务控制入口，每个动作都有回执（失败一定看得见）。
 * ② 接入：BASE URL 与它的密钥。地址和密钥放在一起，且都写明标签——
 *    此前密钥入口孤零零挂在地址右边，用户根本对不上号（审阅 #4/#12）。
 * ③ 应用：版本、主题、刷新。
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

/** 状态栏里的一格：小号灰色标签 + 值。标签是这次新增的——「这是什么」不该靠猜。 */
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
  const { status, busy } = control;
  if (!control.host) return null;

  const Icon = busy ? LoadingOutlined : (STATE_ICON[status.state] ?? CloseCircleFilled);
  const color = STATE_COLOR[status.state] ?? token.colorTextSecondary;

  return (
    <Space size={10} align="center">
      <Tooltip
        title={
          status.port ? `桌面壳控制通道 127.0.0.1:${status.port}（页面据此启停服务）` : '控制通道未就绪，请查看日志'
        }
      >
        <Space size={6} align="center">
          <Icon style={{ color, fontSize: 12 }} />
          <Typography.Text style={{ fontSize: 13, color: token.colorText }}>{HOST_LABEL[status.state]}</Typography.Text>
        </Space>
      </Tooltip>
      {status.state === 'stopped' || status.state === 'error' ? (
        <Tooltip title="启动服务">
          <Button
            size="small"
            type="primary"
            ghost
            icon={<PlayCircleOutlined />}
            loading={busy}
            onClick={() => void control.start()}
          >
            启动
          </Button>
        </Tooltip>
      ) : (
        <Space size={2}>
          <Tooltip title="停止服务">
            <Button
              size="small"
              type="text"
              icon={<PauseCircleOutlined />}
              loading={busy}
              onClick={() => void control.stop()}
            />
          </Tooltip>
          <Tooltip title="重启服务">
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
      <Tooltip title="打开日志目录">
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
  onOpenSecurity,
  mode,
  onToggleTheme,
  onRefresh,
  loggedIn,
  onLogout,
}: {
  control: HostControl;
  proxyBase?: string;
  authRequired?: boolean;
  version?: string;
  onOpenSecurity: () => void;
  mode: 'light' | 'dark';
  onToggleTheme: () => void;
  onRefresh: () => void;
  loggedIn: boolean;
  onLogout: () => void;
}) {
  const { token } = theme.useToken();
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
        <Field label="接入地址">
          {proxyBase ? (
            <Typography.Text
              copyable={{ text: proxyBase, tooltips: ['复制地址', '已复制'] }}
              style={{ fontSize: 13, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}
            >
              {proxyBase}
            </Typography.Text>
          ) : (
            <Typography.Text type="secondary" style={{ fontSize: 13 }}>
              未就绪
            </Typography.Text>
          )}
        </Field>
        <Field label="API Key">
          <Tooltip
            title={
              authRequired
                ? '已设置：下游客户端访问 /v1 需带上它（本机打开控制台不需要）。点击查看或重设'
                : '未设置：下游客户端无需密钥即可调用代理。点击设置'
            }
          >
            <Button
              size="small"
              type="link"
              icon={authRequired ? <LockOutlined /> : <KeyOutlined />}
              style={{ fontSize: 13, padding: 0, height: 'auto' }}
              onClick={onOpenSecurity}
            >
              {authRequired ? '已设置 · 查看' : '未设置 · 去设置'}
            </Button>
          </Tooltip>
        </Field>
      </Space>

      <Space size={2} style={{ marginLeft: 'auto' }}>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          v{version ?? '…'}
        </Typography.Text>
        <Tooltip title={mode === 'dark' ? '切换到亮色' : '切换到暗色'}>
          <Button
            size="small"
            type="text"
            icon={mode === 'dark' ? <SunOutlined /> : <MoonOutlined />}
            onClick={onToggleTheme}
          />
        </Tooltip>
        <Tooltip title="刷新全部数据">
          <Button size="small" type="text" icon={<ReloadOutlined />} onClick={onRefresh} />
        </Tooltip>
        {loggedIn && (
          <Tooltip title="清除本机保存的访问密钥">
            <Button
              size="small"
              type="text"
              icon={<LogoutOutlined />}
              onClick={() => {
                setAuthKey('');
                onLogout();
              }}
            />
          </Tooltip>
        )}
      </Space>
    </div>
  );
}

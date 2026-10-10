import {
  AppstoreOutlined,
  ExperimentOutlined,
  FileTextOutlined,
  HistoryOutlined,
  LogoutOutlined,
  MoonOutlined,
  NodeIndexOutlined,
  PauseCircleOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  SafetyOutlined,
  SunOutlined,
  SyncOutlined,
  TeamOutlined,
} from '@ant-design/icons';
import { useQueryClient } from '@tanstack/react-query';
import type { MenuProps } from 'antd';
import {
  Alert,
  App as AntdApp,
  Badge,
  Button,
  ConfigProvider,
  Input,
  Layout,
  Menu,
  Modal,
  Space,
  Tooltip,
  Typography,
  theme,
} from 'antd';
import zhCN from 'antd/es/locale/zh_CN';
import { type ComponentType, useEffect, useState } from 'react';

import { getAuthKey, setAuthKey } from './api/client.ts';
import { useMeta, useRefresh } from './api/hooks.ts';
import Accounts from './features/Accounts.tsx';
import Catalog from './features/Catalog.tsx';
import History from './features/History.tsx';
import Models from './features/Models.tsx';
import Playground from './features/Playground.tsx';
import Security from './features/Security.tsx';
import { useHostBridge } from './hostBridge.ts';
import { Logo } from './logo.tsx';
import { darkTheme, initialTheme, lightTheme, persistTheme, type ThemeMode } from './theme.ts';

/** 主题状态在最外层；Console 在 ConfigProvider 内部才能拿到主题 token。 */
export default function App() {
  const [mode, setMode] = useState<ThemeMode>(initialTheme);

  const toggleTheme = (): void => {
    const next: ThemeMode = mode === 'dark' ? 'light' : 'dark';
    setMode(next);
    persistTheme(next);
  };

  return (
    <ConfigProvider theme={mode === 'dark' ? darkTheme : lightTheme} locale={zhCN}>
      <AntdApp>
        <Console mode={mode} onToggleTheme={toggleTheme} />
      </AntdApp>
    </ConfigProvider>
  );
}

const HOST_LABEL: Record<string, string> = {
  running: '运行中',
  starting: '启动中',
  stopping: '停止中',
  stopped: '已停止',
};

/** 桌面壳模式下的服务控制簇（浏览器直开时不渲染）。 */
function HostControls({ host }: { host: ReturnType<typeof useHostBridge> }) {
  const bridge = host.host;
  if (!bridge) return null;
  const { status } = host;
  const stopped = status === 'stopped';
  return (
    <Space size={4}>
      <Tooltip title="桌面壳托管的服务状态（2 秒自动刷新）">
        <Badge
          status={stopped ? 'error' : status === 'running' ? 'success' : 'processing'}
          text={HOST_LABEL[status] ?? status}
        />
      </Tooltip>
      {stopped && (
        <Tooltip title="启动服务">
          <Button size="small" type="text" icon={<PlayCircleOutlined />} onClick={() => void bridge.start()} />
        </Tooltip>
      )}
      {!stopped && (
        <Tooltip title="停止服务">
          <Button size="small" type="text" icon={<PauseCircleOutlined />} onClick={() => void bridge.stop()} />
        </Tooltip>
      )}
      {!stopped && (
        <Tooltip title="重启服务">
          <Button size="small" type="text" icon={<SyncOutlined />} onClick={() => void bridge.restart()} />
        </Tooltip>
      )}
      <Tooltip title="打开日志目录">
        <Button size="small" type="text" icon={<FileTextOutlined />} onClick={() => void bridge.openLogs()} />
      </Tooltip>
    </Space>
  );
}

/** 导航注册表。 */
const PAGES: { key: string; label: string; icon: ComponentType; element: ComponentType }[] = [
  { key: 'models', label: '订阅模型', icon: NodeIndexOutlined, element: Models },
  { key: 'accounts', label: '账号池', icon: TeamOutlined, element: Accounts },
  { key: 'security', label: '访问与安全', icon: SafetyOutlined, element: Security },
  { key: 'playground', label: '测试台', icon: ExperimentOutlined, element: Playground },
  { key: 'history', label: '请求历史', icon: HistoryOutlined, element: History },
  { key: 'catalog', label: '完整目录', icon: AppstoreOutlined, element: Catalog },
];

/** Menu 数据源：icon 传组件引用，由 Menu 渲染。 */
const NAV_ITEMS: MenuProps['items'] = PAGES.map((p) => ({ key: p.key, label: p.label, icon: <p.icon /> }));

function Console({ mode, onToggleTheme }: { mode: ThemeMode; onToggleTheme: () => void }) {
  const { token } = theme.useToken();
  const meta = useMeta();
  const refresh = useRefresh();
  const qc = useQueryClient();
  const host = useHostBridge();
  const [nav, setNav] = useState('models');

  const [authKey, setKey] = useState(getAuthKey());
  const [loginOpen, setLoginOpen] = useState(false);
  const [loginInput, setLoginInput] = useState('');
  const [loginErr, setLoginErr] = useState('');

  // 页面底色跟随主题（Layout 之外的区域由 body 承担）
  useEffect(() => {
    document.body.style.background = token.colorBgLayout;
    document.body.style.colorScheme = mode;
  }, [token.colorBgLayout, mode]);

  // 服务端开启了鉴权而本地没有密钥 → 弹登录框
  useEffect(() => {
    if (meta.data?.authRequired && !authKey) setLoginOpen(true);
  }, [meta.data, authKey]);

  // 任何查询/变更遇到 401（密钥被改、过期）→ 重新弹登录
  useEffect(() => {
    const handler = (): void => {
      setAuthKey('');
      setKey('');
      setLoginOpen(true);
    };
    window.addEventListener('cps:unauthorized', handler);
    return () => window.removeEventListener('cps:unauthorized', handler);
  }, []);

  const tryLogin = async (): Promise<void> => {
    const candidate = loginInput.trim();
    if (!candidate) return;
    try {
      const res = await fetch('/api/models', { headers: { 'X-Admin-Key': candidate } });
      if (!res.ok) throw new Error(String(res.status));
      setAuthKey(candidate);
      setKey(candidate);
      setLoginOpen(false);
      setLoginErr('');
      qc.invalidateQueries();
    } catch {
      setLoginErr('密钥错误，请重试');
    }
  };

  return (
    <>
      <Layout style={{ minHeight: '100vh' }}>
        <Layout.Header
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 16,
            flexWrap: 'wrap',
            // antd 的 Layout.Header 默认深色底（亮色算法下也是 #001529 系），改为跟随主题
            background: token.colorBgContainer,
            borderBottom: `1px solid ${token.colorBorderSecondary}`,
          }}
        >
          <Space size={8} align="center">
            <Logo size={26} />
            <Typography.Title level={5} style={{ margin: 0 }}>
              Cline Pass 控制台
            </Typography.Title>
          </Space>
          <Menu
            mode="horizontal"
            selectedKeys={[nav]}
            onClick={(e) => setNav(e.key)}
            items={NAV_ITEMS}
            style={{ flex: 1, minWidth: 0, background: 'transparent' }}
          />
          <Space style={{ marginLeft: 'auto' }}>
            <HostControls host={host} />
            <Tooltip title={mode === 'dark' ? '切换到亮色' : '切换到暗色'}>
              <Button
                size="small"
                type="text"
                icon={mode === 'dark' ? <SunOutlined /> : <MoonOutlined />}
                onClick={onToggleTheme}
              />
            </Tooltip>
            <Tooltip title="刷新全部数据">
              <Button size="small" type="text" icon={<ReloadOutlined />} onClick={refresh} />
            </Tooltip>
            {authKey && (
              <Tooltip title="清除本机保存的访问密钥">
                <Button
                  size="small"
                  type="text"
                  icon={<LogoutOutlined />}
                  onClick={() => {
                    setAuthKey('');
                    setKey('');
                    qc.invalidateQueries();
                  }}
                />
              </Tooltip>
            )}
          </Space>
        </Layout.Header>

        <Layout.Content style={{ padding: 24, maxWidth: 1360, margin: '0 auto', width: '100%' }}>
          {meta.data && !meta.data.configured && (
            <Alert
              type="error"
              showIcon
              style={{ marginBottom: 16 }}
              message="尚未配置上游 API Key"
              description="在「账号池」里添加你的 Cline Pass 账号（sk_ 开头的 key）并保存；也可通过 CLINE_PASS_KEY 环境变量提供。"
            />
          )}
          {PAGES.map((p) => (
            <div key={p.key} style={{ display: nav === p.key ? undefined : 'none' }}>
              <p.element />
            </div>
          ))}
        </Layout.Content>
      </Layout>

      <Modal
        open={loginOpen}
        title="此部署已启用代理密钥保护"
        okText="进入控制台"
        cancelButtonProps={{ style: { display: 'none' } }}
        onOk={() => void tryLogin()}
        onCancel={() => setLoginOpen(false)}
      >
        <Space direction="vertical" style={{ width: '100%' }}>
          <Typography.Text type="secondary">
            请输入代理密钥（服务端 config.json 的 proxyKey，或部署时设置的 PROXY_KEY）。
          </Typography.Text>
          <Input.Password
            autoFocus
            value={loginInput}
            onChange={(e) => setLoginInput(e.target.value)}
            onPressEnter={() => void tryLogin()}
            placeholder="代理密钥"
          />
          {loginErr && <Typography.Text type="danger">{loginErr}</Typography.Text>}
        </Space>
      </Modal>
    </>
  );
}

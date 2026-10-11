import {
  AppstoreOutlined,
  ExperimentOutlined,
  FileTextOutlined,
  HistoryOutlined,
  LogoutOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  MoonOutlined,
  NodeIndexOutlined,
  PauseCircleOutlined,
  PlayCircleOutlined,
  PushpinFilled,
  PushpinOutlined,
  ReloadOutlined,
  SafetyOutlined,
  SunOutlined,
  SyncOutlined,
  TeamOutlined,
} from '@ant-design/icons';
import { useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  App as AntdApp,
  Badge,
  Button,
  ConfigProvider,
  Input,
  Layout,
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
import './app.css';
import Accounts from './features/Accounts.tsx';
import Catalog from './features/Catalog.tsx';
import History from './features/History.tsx';
import Models from './features/Models.tsx';
import Playground from './features/Playground.tsx';
import Security from './features/Security.tsx';
import { useHostBridge } from './hostBridge.ts';
import { Logo } from './logo.tsx';
import { darkTheme, initialTheme, lightTheme, persistTheme, type ThemeMode } from './theme.ts';

/** 钉住页面的持久化键：打开控制台时默认落到被钉住的页面。 */
const PIN_KEY = 'cps_pinned_page';
const SIDEBAR_KEY = 'cps_sidebar';

/** 导航注册表：壳层只认这张表；页面增减只改这里。 */
const PAGES: { key: string; label: string; icon: ComponentType; element: ComponentType }[] = [
  { key: 'models', label: '订阅模型', icon: NodeIndexOutlined, element: Models },
  { key: 'accounts', label: '账号池', icon: TeamOutlined, element: Accounts },
  { key: 'playground', label: '测试台', icon: ExperimentOutlined, element: Playground },
  { key: 'history', label: '请求历史', icon: HistoryOutlined, element: History },
  { key: 'catalog', label: '完整目录', icon: AppstoreOutlined, element: Catalog },
  { key: 'security', label: '访问与安全', icon: SafetyOutlined, element: Security },
];

const HOST_LABEL: Record<string, string> = {
  running: '运行中',
  starting: '启动中',
  stopping: '停止中',
  stopped: '已停止',
};

/** 左侧导航：可折叠（64px 图标 ⇄ 200px 图标+文字）；悬停可钉住页面（打开时默认落到此页）。 */
function SideNav({
  nav,
  onNav,
  collapsed,
  onToggle,
  pinned,
  onTogglePin,
}: {
  nav: string;
  onNav: (key: string) => void;
  collapsed: boolean;
  onToggle: () => void;
  pinned: string | null;
  onTogglePin: (key: string) => void;
}) {
  const { token } = theme.useToken();
  const btnBase = { height: 44, width: '100%', gap: 10, paddingInline: collapsed ? 0 : 10 } as const;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', padding: '12px 0' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: collapsed ? '0 0 0 18px' : '0 16px',
          marginBottom: 16,
        }}
      >
        <Logo size={28} />
        {!collapsed && (
          <Typography.Text strong style={{ fontSize: 14, whiteSpace: 'nowrap' }}>
            Cline Pass
          </Typography.Text>
        )}
      </div>
      <div style={{ display: 'grid', gap: 4, padding: collapsed ? '0 10px' : '0 12px' }}>
        {PAGES.map((p) => {
          const active = nav === p.key;
          const isPinned = pinned === p.key;
          const Comp = p.icon;
          return (
            <div key={p.key} className="cps-nav-item">
              <Tooltip title={collapsed ? p.label : undefined} placement="right">
                <Button
                  type="text"
                  aria-label={p.label}
                  className={[
                    'cps-nav',
                    active ? 'cps-nav-active' : '',
                    collapsed && isPinned ? 'cps-nav-pinned-dot' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  onClick={() => onNav(p.key)}
                  style={{
                    ...btnBase,
                    justifyContent: collapsed ? 'center' : 'flex-start',
                    fontSize: 18,
                    color: active ? token.colorPrimary : token.colorTextSecondary,
                    background: active ? token.colorPrimaryBg : undefined,
                  }}
                  icon={<Comp />}
                >
                  {!collapsed && (
                    <span style={{ fontSize: 14, paddingRight: 18, whiteSpace: 'nowrap' }}>{p.label}</span>
                  )}
                </Button>
              </Tooltip>
              {!collapsed && (
                <Tooltip title={isPinned ? '取消钉住' : '钉住：打开控制台时默认显示此页'}>
                  <button
                    type="button"
                    aria-label={isPinned ? `取消钉住${p.label}` : `钉住${p.label}`}
                    className={isPinned ? 'cps-pin cps-pinned' : 'cps-pin'}
                    onClick={() => onTogglePin(p.key)}
                  >
                    {isPinned ? <PushpinFilled /> : <PushpinOutlined />}
                  </button>
                </Tooltip>
              )}
            </div>
          );
        })}
      </div>
      <div style={{ marginTop: 'auto', padding: collapsed ? '0 10px' : '0 12px' }}>
        <Tooltip title={collapsed ? '展开侧栏' : undefined} placement="right">
          <Button
            type="text"
            aria-label={collapsed ? '展开侧栏' : '折叠侧栏'}
            onClick={onToggle}
            style={{
              ...btnBase,
              height: 40,
              justifyContent: collapsed ? 'center' : 'flex-start',
              color: token.colorTextTertiary,
            }}
            icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
          >
            {!collapsed && <span style={{ fontSize: 13 }}>收起侧栏</span>}
          </Button>
        </Tooltip>
      </div>
    </div>
  );
}

/** 状态栏里的服务控制簇（桌面壳模式渲染；浏览器直开时不显示）。 */
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
          style={{ fontSize: 12 }}
        />
      </Tooltip>
      {stopped ? (
        <Tooltip title="启动服务">
          <Button size="small" type="text" icon={<PlayCircleOutlined />} onClick={() => void bridge.start()} />
        </Tooltip>
      ) : (
        <>
          <Tooltip title="停止服务">
            <Button size="small" type="text" icon={<PauseCircleOutlined />} onClick={() => void bridge.stop()} />
          </Tooltip>
          <Tooltip title="重启服务">
            <Button size="small" type="text" icon={<SyncOutlined />} onClick={() => void bridge.restart()} />
          </Tooltip>
        </>
      )}
      <Tooltip title="打开日志目录">
        <Button size="small" type="text" icon={<FileTextOutlined />} onClick={() => void bridge.openLogs()} />
      </Tooltip>
    </Space>
  );
}

function Console({ mode, onToggleTheme }: { mode: ThemeMode; onToggleTheme: () => void }) {
  const { token } = theme.useToken();
  const meta = useMeta();
  const refresh = useRefresh();
  const qc = useQueryClient();
  const host = useHostBridge();
  /** 钉住的页面：打开控制台时默认落在这里（用户可把高频页钉住，省一次点击）。 */
  const [pinned, setPinned] = useState<string | null>(() => localStorage.getItem(PIN_KEY));
  const [nav, setNav] = useState(() => localStorage.getItem(PIN_KEY) ?? 'models');
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(SIDEBAR_KEY) === 'collapsed');

  const toggleSidebar = (): void => {
    setCollapsed((c) => {
      localStorage.setItem(SIDEBAR_KEY, c ? 'expanded' : 'collapsed');
      return !c;
    });
  };

  const togglePin = (key: string): void => {
    setPinned((p) => {
      const next = p === key ? null : key;
      if (next) localStorage.setItem(PIN_KEY, next);
      else localStorage.removeItem(PIN_KEY);
      return next;
    });
  };

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

  // 页面内的引导按钮通过自定义事件请求切页（避免给每个 feature 传导航 prop）
  useEffect(() => {
    const handler = (e: Event): void => {
      const key = (e as CustomEvent<string>).detail;
      if (typeof key === 'string') setNav(key);
    };
    window.addEventListener('cps:navigate', handler);
    return () => window.removeEventListener('cps:navigate', handler);
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

  const proxyBase = meta.data?.proxyBase;

  return (
    <>
      {/* 桌面应用形态：固定侧栏 + 内容区内滚 + 常驻状态栏（窗口高度恒定，不整页滚） */}
      <Layout style={{ height: '100vh' }}>
        <Layout.Sider
          width={collapsed ? 64 : 200}
          style={{
            background: token.colorBgContainer,
            borderRight: `1px solid ${token.colorBorderSecondary}`,
          }}
        >
          <SideNav
            nav={nav}
            onNav={setNav}
            collapsed={collapsed}
            onToggle={toggleSidebar}
            pinned={pinned}
            onTogglePin={togglePin}
          />
        </Layout.Sider>

        <Layout style={{ background: 'transparent', minWidth: 0 }}>
          <Layout.Content style={{ overflow: 'auto', padding: '24px 24px 32px' }}>
            <div style={{ maxWidth: 1400, margin: '0 auto' }}>
              {meta.data && !meta.data.configured && (
                <Alert
                  type="error"
                  showIcon
                  style={{ marginBottom: 16 }}
                  message="尚未配置上游 API Key"
                  description="在「账号池」里添加你的 Cline Pass 账号（sk_ 开头的 key）并保存；也可通过 CLINE_PASS_KEY 环境变量提供。"
                  action={
                    <Button size="small" danger onClick={() => setNav('accounts')}>
                      去配置
                    </Button>
                  }
                />
              )}
              {PAGES.map((p) => (
                <div key={p.key} style={{ display: nav === p.key ? undefined : 'none' }}>
                  <p.element />
                </div>
              ))}
            </div>
          </Layout.Content>

          <Layout.Footer
            style={{
              height: 34,
              padding: '0 16px',
              display: 'flex',
              alignItems: 'center',
              gap: 16,
              background: token.colorBgContainer,
              borderTop: `1px solid ${token.colorBorderSecondary}`,
            }}
          >
            <HostControls host={host} />
            {proxyBase && (
              <Tooltip title="下游客户端使用的接入地址（点击复制）">
                <Typography.Text type="secondary" style={{ fontSize: 12 }} copyable={{ text: proxyBase }}>
                  {proxyBase}
                </Typography.Text>
              </Tooltip>
            )}
            <Space size={2} style={{ marginLeft: 'auto' }}>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                v{meta.data?.version ?? '…'}
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
          </Layout.Footer>
        </Layout>
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

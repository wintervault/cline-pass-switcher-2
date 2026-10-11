import {
  AppstoreOutlined,
  ExperimentOutlined,
  HistoryOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  NodeIndexOutlined,
  PushpinFilled,
  PushpinOutlined,
  SafetyOutlined,
  TeamOutlined,
} from '@ant-design/icons';
import { useQueryClient } from '@tanstack/react-query';
import { Alert, App as AntdApp, Button, ConfigProvider, Layout, Tooltip, Typography, theme } from 'antd';
import zhCN from 'antd/es/locale/zh_CN';
import { type ComponentType, useCallback, useEffect, useState } from 'react';
import { AccessGate } from './accessGate.tsx';
import { getAuthKey, setAuthKey } from './api/client.ts';
import { useMeta, useRefresh } from './api/hooks.ts';
import './app.css';
import Accounts from './features/Accounts.tsx';
import Catalog from './features/Catalog.tsx';
import History from './features/History.tsx';
import Models from './features/Models.tsx';
import Playground from './features/Playground.tsx';
import Security from './features/Security.tsx';
import { useFeedback } from './feedback.ts';
import { useHostControl } from './hostBridge.ts';
import { PAGE_GUTTER, PAGE_WIDTH } from './layout.ts';
import { Logo } from './logo.tsx';
import { ServiceBanner } from './serviceBanner.tsx';
import { StatusBar } from './statusBar.tsx';
import { darkTheme, initialTheme, lightTheme, persistTheme, type ThemeMode } from './theme.ts';
import { TITLEBAR_HEIGHT, TitleBar } from './titleBar.tsx';

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

function Console({ mode, onToggleTheme }: { mode: ThemeMode; onToggleTheme: () => void }) {
  const { token } = theme.useToken();
  const meta = useMeta();
  const refresh = useRefresh();
  const qc = useQueryClient();
  const fb = useFeedback();
  /**
   * 服务由壳托管：状态、启停动作、失败原因都在这里（状态栏与提示条共用同一份）。
   * 启停/重启都有回执——按下时说「正在…」，状态真的变过去后说「已完成」。
   */
  const host = useHostControl({
    onChanged: useCallback(() => void qc.invalidateQueries(), [qc]),
    onNotice: useCallback(
      (text: string, kind: 'ok' | 'fail' | 'info') => {
        if (kind === 'ok') fb.ok(text);
        else if (kind === 'fail') fb.fail(text);
        else fb.info(text);
      },
      [fb],
    ),
  });
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
    const label = PAGES.find((p) => p.key === key)?.label ?? key;
    setPinned((p) => {
      const next = p === key ? null : key;
      if (next) localStorage.setItem(PIN_KEY, next);
      else localStorage.removeItem(PIN_KEY);
      fb.ok(next ? `已钉住「${label}」：下次打开控制台直接进这里` : `已取消钉住「${label}」`);
      return next;
    });
  };

  const [authKey, setKey] = useState(getAuthKey());
  /**
   * 需要密钥才能读控制台 API（只可能出现在**远端访问**的部署上）。
   *
   * 这里是 v2.9.2 真实反馈的修复点：以前一设密钥就弹一个关不掉的模态框，
   * 密钥忘了/输了错的就永远进不去——用下发给客户端的密钥把机器主人锁在门外。
   * 现在两件事都改了：
   * 1. 服务端把「本机访问控制台」判定为最高权限，本机永远不发 401（见 security/local.ts）；
   * 2. 页面侧不再用模态框硬拦，改成一块**常驻、可重试、给出恢复路径**的面板——
   *    不可能出现「关不掉的弹窗」这种死循环。
   */
  const [needKey, setNeedKey] = useState(false);
  const [keyDraft, setKeyDraft] = useState('');
  const [keyChecking, setKeyChecking] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);

  // 页面底色跟随主题（Layout 之外的区域由 body 承担）
  useEffect(() => {
    document.body.style.background = token.colorBgLayout;
    document.body.style.colorScheme = mode;
  }, [token.colorBgLayout, mode]);

  // 遇到 401（远端部署且密钥缺失/失效）→ 记下状态，由面板承担输入
  useEffect(() => {
    const handler = (): void => {
      setAuthKey('');
      setKey('');
      setNeedKey(true);
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

  const tryKey = async (): Promise<void> => {
    const candidate = keyDraft.trim();
    if (!candidate) {
      setKeyError('请先填入访问密钥');
      return;
    }
    setKeyChecking(true);
    setKeyError(null);
    try {
      const res = await fetch('/api/models', { headers: { 'X-Admin-Key': candidate } });
      if (!res.ok) throw new Error(res.status === 401 ? '密钥不正确' : `服务端返回 ${res.status}`);
      setAuthKey(candidate);
      setKey(candidate);
      setNeedKey(false);
      setKeyDraft('');
      void qc.invalidateQueries();
      fb.ok('密钥有效，已进入控制台');
    } catch (err) {
      setKeyError((err as Error).message);
    } finally {
      setKeyChecking(false);
    }
  };

  const proxyBase = meta.data?.proxyBase;

  return (
    <>
      {/* 桌面应用形态：自绘标题栏 + 固定侧栏 + 内容区内滚 + 常驻状态栏（窗口高度恒定，不整页滚） */}
      <TitleBar />
      <Layout style={{ height: '100vh', paddingTop: TITLEBAR_HEIGHT }}>
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
          {/*
            内容列由外壳统一给定（唯一来源）：所有页面共用同一个宽度与左边距。
            两处关键：
            1. `scrollbarGutter: 'stable'` —— 常驻预留滚动条槽位。不预留的话，
               页面有滚动条时内容宽 1044、没有时 1054，切页时整块内容横移 5px
               （「切页感觉布局偏移、不像一个 app」的真正来源）。
            2. 页面**不许**再自己写 maxWidth —— 一写就与别的页面对不齐，
               标题的横坐标会在切页时跳。
          */}
          <Layout.Content
            style={{
              overflow: 'auto',
              scrollbarGutter: 'stable',
              padding: `20px ${PAGE_GUTTER}px 24px`,
            }}
          >
            <div
              style={{
                width: '100%',
                maxWidth: PAGE_WIDTH,
                margin: '0 auto',
                minHeight: '100%',
                display: 'flex',
                flexDirection: 'column',
              }}
            >
              {needKey ? (
                <AccessGate
                  value={keyDraft}
                  onChange={setKeyDraft}
                  onSubmit={() => void tryKey()}
                  checking={keyChecking}
                  error={keyError}
                />
              ) : (
                <>
                  <ServiceBanner control={host} />
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
                    <div key={p.key} style={{ display: nav === p.key ? 'block' : 'none', flex: '0 0 auto' }}>
                      <p.element />
                    </div>
                  ))}
                </>
              )}
            </div>
          </Layout.Content>

          <StatusBar
            control={host}
            proxyBase={proxyBase}
            authRequired={meta.data?.authRequired}
            version={meta.data?.version}
            onOpenSecurity={() => setNav('security')}
            mode={mode}
            onToggleTheme={onToggleTheme}
            onRefresh={() => {
              refresh();
              fb.ok('已刷新全部数据');
            }}
            loggedIn={Boolean(authKey)}
            onLogout={() => {
              setAuthKey('');
              setKey('');
              void qc.invalidateQueries();
              fb.info('已清除本机保存的访问密钥');
            }}
          />
        </Layout>
      </Layout>
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

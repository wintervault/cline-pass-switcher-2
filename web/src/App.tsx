import { MoonOutlined, SunOutlined } from '@ant-design/icons';
import { useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  App as AntdApp,
  Button,
  ConfigProvider,
  Input,
  Layout,
  Modal,
  Space,
  Tabs,
  Tooltip,
  Typography,
  theme,
} from 'antd';
import zhCN from 'antd/es/locale/zh_CN';
import { useEffect, useState } from 'react';

import { getAuthKey, setAuthKey } from './api/client.ts';
import { useMeta, useRefresh } from './api/hooks.ts';
import Accounts from './features/Accounts.tsx';
import Catalog from './features/Catalog.tsx';
import History from './features/History.tsx';
import Models from './features/Models.tsx';
import Playground from './features/Playground.tsx';
import Security from './features/Security.tsx';
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

function Console({ mode, onToggleTheme }: { mode: ThemeMode; onToggleTheme: () => void }) {
  const { token } = theme.useToken();
  const meta = useMeta();
  const refresh = useRefresh();
  const qc = useQueryClient();

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

  const proxyBase = meta.data?.proxyBase;

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
          <Typography.Title level={4} style={{ margin: 0 }}>
            Cline Pass 上游控制台
          </Typography.Title>
          {proxyBase && (
            <Typography.Text copyable={{ text: proxyBase }} code style={{ fontSize: 12 }}>
              {proxyBase}
            </Typography.Text>
          )}
          <Space style={{ marginLeft: 'auto' }}>
            <Tooltip title={mode === 'dark' ? '切换到亮色' : '切换到暗色'}>
              <Button
                size="small"
                icon={mode === 'dark' ? <SunOutlined /> : <MoonOutlined />}
                onClick={onToggleTheme}
              />
            </Tooltip>
            <Button size="small" onClick={refresh}>
              ↻ 刷新
            </Button>
            {authKey && (
              <Button
                size="small"
                onClick={() => {
                  setAuthKey('');
                  setKey('');
                  qc.invalidateQueries();
                }}
              >
                退出登录
              </Button>
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
          <Tabs
            defaultActiveKey="models"
            items={[
              { key: 'models', label: '订阅模型', children: <Models /> },
              { key: 'accounts', label: '账号池', children: <Accounts /> },
              { key: 'security', label: '访问与安全', children: <Security /> },
              { key: 'playground', label: '测试台', children: <Playground /> },
              { key: 'history', label: '请求历史', children: <History /> },
              { key: 'catalog', label: '完整目录', children: <Catalog /> },
            ]}
          />
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

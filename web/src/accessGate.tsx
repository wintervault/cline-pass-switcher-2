import { KeyOutlined, LockOutlined } from '@ant-design/icons';
import { Button, Input, Space, Typography, theme } from 'antd';

/**
 * 远端访问时的访问密钥入口。
 *
 * 关键在于**它不是一个关不掉的弹窗**：以前的实现用模态框硬拦，密钥错了就
 * 永远进不去（关掉又弹、再关再弹），把机器主人自己锁死。现在是一块常驻面板——
 * 失败了就地重试，并明确给出两条恢复路径，任何一种情况下用户都有路可走。
 *
 * 本机访问根本不会走到这里：服务端把「回环对端 + 回环 Host」判定为最高权限
 * （见 server/src/security/local.ts），压根不发 401。
 */
export function AccessGate({
  value,
  onChange,
  onSubmit,
  checking,
  error,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  checking: boolean;
  error: string | null;
}) {
  const { token } = theme.useToken();
  return (
    <div style={{ maxWidth: 520, margin: '40px auto 0' }}>
      <div
        style={{
          border: `1px solid ${token.colorBorderSecondary}`,
          borderRadius: token.borderRadiusLG,
          background: token.colorBgContainer,
          padding: 24,
        }}
      >
        <Space size={10} align="center" style={{ marginBottom: 8 }}>
          <LockOutlined style={{ color: token.colorPrimary }} />
          <Typography.Text strong style={{ fontSize: 15 }}>
            此部署需要访问密钥
          </Typography.Text>
        </Space>

        <Typography.Paragraph type="secondary" style={{ fontSize: 13, lineHeight: '20px', marginBottom: 16 }}>
          你正从本机之外访问这台服务器上的控制台，所以需要 API Key。填入后本机会记住它，下次不用再输。
        </Typography.Paragraph>

        <Space.Compact style={{ width: '100%' }}>
          <Input.Password
            autoFocus
            prefix={<KeyOutlined style={{ color: token.colorTextQuaternary }} />}
            placeholder="API Key（即服务端 config.json 里的 proxyKey）"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onPressEnter={onSubmit}
            status={error ? 'error' : undefined}
          />
          <Button type="primary" loading={checking} onClick={onSubmit}>
            进入控制台
          </Button>
        </Space.Compact>

        {error && (
          <Typography.Text type="danger" style={{ fontSize: 12, display: 'block', marginTop: 8 }}>
            {error}
          </Typography.Text>
        )}

        {/* 恢复路径：被锁在外面的人最需要看到的就是这两行 */}
        <div
          style={{
            marginTop: 20,
            paddingTop: 16,
            borderTop: `1px solid ${token.colorBorderSecondary}`,
            display: 'grid',
            gap: 10,
          }}
        >
          <Typography.Text style={{ fontSize: 13 }}>进不去？两条路：</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12, lineHeight: '19px' }}>
            ① <b>到这台服务器上直接打开</b>{' '}
            <Typography.Text code style={{ fontSize: 12 }}>
              http://127.0.0.1:3123
            </Typography.Text>
            —— 本机访问永远不需要密钥，进去后在「访问与安全」里就能看到或重设。
          </Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12, lineHeight: '19px' }}>
            ② 编辑服务器上的{' '}
            <Typography.Text code style={{ fontSize: 12 }}>
              data/config.json
            </Typography.Text>
            ，把{' '}
            <Typography.Text code style={{ fontSize: 12 }}>
              proxyKey
            </Typography.Text>{' '}
            改成新值后重启服务（或用{' '}
            <Typography.Text code style={{ fontSize: 12 }}>
              PROXY_KEY
            </Typography.Text>{' '}
            环境变量注入）。
          </Typography.Text>
        </div>
      </div>
    </div>
  );
}

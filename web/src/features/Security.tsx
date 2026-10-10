import { App, Button, Input, Space, Switch, Tag, Typography } from 'antd';
import { useEffect, useState } from 'react';

import { useSaveSecurity, useSecurity } from '../api/hooks.ts';

export default function Security() {
  const { message } = App.useApp();
  const security = useSecurity();
  const save = useSaveSecurity();
  const [proxyKey, setProxyKey] = useState('');
  const [publicBase, setPublicBase] = useState('');
  const [corsOrigins, setCorsOrigins] = useState('');

  useEffect(() => {
    if (!security.data) return;
    setPublicBase(security.data.publicBaseUrl);
    setCorsOrigins(security.data.corsOrigins.join('\n'));
  }, [security.data]);

  const persist = (): void => {
    save.mutate(
      {
        proxyKey: proxyKey.trim(),
        publicBaseUrl: publicBase.trim(),
        corsOrigins: corsOrigins
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter(Boolean),
      },
      {
        onSuccess: () => {
          message.success('已保存（密钥留空 = 保持不变）');
          setProxyKey('');
        },
        onError: (e) => message.error(`保存失败：${String(e)}`),
      },
    );
  };

  const data = security.data;

  return (
    <div style={{ display: 'grid', gap: 16, maxWidth: 720 }}>
      <div>
        <Space align="center" style={{ marginBottom: 6 }}>
          <Typography.Text>下游代理密钥</Typography.Text>
          {data?.authRequired ? (
            <Tag color="green">鉴权已开启</Tag>
          ) : (
            <Tag color="orange">鉴权关闭（仅限本机绑定）</Tag>
          )}
        </Space>
        <div>
          <Space.Compact style={{ width: '100%' }}>
            <Input.Password
              placeholder={data?.hasProxyKey ? '已设置，留空保持不变' : '空 = 关闭鉴权'}
              value={proxyKey}
              onChange={(e) => setProxyKey(e.target.value)}
            />
            <Button type="primary" loading={save.isPending} onClick={persist}>
              保存
            </Button>
          </Space.Compact>
        </div>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          客户端用这把密钥访问代理（Authorization: Bearer …）。修改后客户端需同步更新。
          绑定非回环地址且密钥为空时服务会拒绝启动。
        </Typography.Text>
      </div>

      <div>
        <Typography.Text>公网代理地址（展示用）</Typography.Text>
        <div style={{ marginTop: 4 }}>
          <Input
            placeholder="如 https://pass.example.com（本地留空）"
            value={publicBase}
            onChange={(e) => setPublicBase(e.target.value)}
          />
        </div>
      </div>

      <div>
        <Typography.Text>CORS 白名单（每行一个 Origin）</Typography.Text>
        <div style={{ marginTop: 4 }}>
          <Input.TextArea
            rows={2}
            placeholder={'默认为空：不发跨域头（同源访问足够）\n如需放行其他前端：https://your-app.example.com'}
            value={corsOrigins}
            onChange={(e) => setCorsOrigins(e.target.value)}
          />
        </div>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          白名单外的跨源写请求会被直接拒绝（防本地 CSRF）；非浏览器客户端不受影响。
        </Typography.Text>
      </div>

      <div>
        <Space align="center">
          <Switch checked={data?.exposeCatalog ?? false} onChange={(v) => save.mutate({ exposeCatalog: v })} />
          <Typography.Text>把完整目录模型加入 /v1/models（默认关闭：客户端只看到订阅模型）</Typography.Text>
        </Space>
      </div>
    </div>
  );
}

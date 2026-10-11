import { App, Button, Divider, Input, Popconfirm, Space, Switch, Tag, Typography } from 'antd';
import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';

import { useMeta, useSaveSecurity, useSecurity } from '../api/hooks.ts';
import { PageHeader } from '../pageHeader.tsx';

/** 设置区块：标题 + 说明 + 控件；区块之间用分隔线，不用同尺寸卡片堆叠。 */
function Section({ title, desc, children }: { title: string; desc?: string; children: ReactNode }) {
  return (
    <div>
      <Typography.Title level={5} style={{ margin: 0 }}>
        {title}
      </Typography.Title>
      {desc && (
        <Typography.Text type="secondary" style={{ fontSize: 13, display: 'block', marginTop: 4 }}>
          {desc}
        </Typography.Text>
      )}
      <div style={{ marginTop: 12 }}>{children}</div>
    </div>
  );
}

export default function Security() {
  const { message } = App.useApp();
  const security = useSecurity();
  const meta = useMeta();
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
    <div style={{ maxWidth: 720, margin: '0 auto' }}>
      <PageHeader title="访问与安全" desc="下游接入地址、代理密钥与跨源防护。低频配置，改完记得保存。" />

      <Section
        title="接入地址"
        desc="下游客户端（Cline、任意 OpenAI 兼容工具）的 Base URL。本地部署即回环地址；公网部署填好下方「公网代理地址」后这里会同步展示。"
      >
        <Typography.Text code copyable style={{ fontSize: 13 }}>
          {meta.data?.proxyBase ?? '—'}
        </Typography.Text>
      </Section>

      <Divider style={{ margin: '24px 0' }} />

      <Section title="公网代理地址（展示用）" desc="门户与状态栏展示的公网地址；本地使用留空。">
        <Input
          style={{ maxWidth: 480 }}
          placeholder="如 https://pass.example.com（本地留空）"
          value={publicBase}
          onChange={(e) => setPublicBase(e.target.value)}
        />
      </Section>

      <Divider style={{ margin: '24px 0' }} />

      <Section
        title="下游代理密钥"
        desc="客户端用这把密钥访问代理（Authorization: Bearer …）。修改后客户端需同步更新；绑定非回环地址且密钥为空时服务会拒绝启动。"
      >
        <Space align="center" style={{ marginBottom: 8 }}>
          {data?.authRequired ? (
            <Tag color="green">鉴权已开启</Tag>
          ) : (
            <Tag color="orange">鉴权关闭（仅限本机绑定）</Tag>
          )}
          {data?.hasProxyKey && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              已设置，留空保持不变
            </Typography.Text>
          )}
        </Space>
        <Input.Password
          style={{ maxWidth: 480 }}
          placeholder={data?.hasProxyKey ? '留空保持不变' : '尚未设置'}
          value={proxyKey}
          onChange={(e) => setProxyKey(e.target.value)}
        />
        {data?.hasProxyKey && (
          <div style={{ marginTop: 8 }}>
            <Popconfirm
              title="清除代理密钥？"
              description="清除后代理不再鉴权（仅回环绑定时安全）；公网部署不要这样做。"
              okText="清除"
              okButtonProps={{ danger: true }}
              cancelText="取消"
              onConfirm={() =>
                save.mutate({ proxyKey: null }, { onSuccess: () => message.success('密钥已清除（代理不再鉴权）') })
              }
            >
              <Button size="small" danger type="text">
                清除密钥
              </Button>
            </Popconfirm>
          </div>
        )}
      </Section>

      <Divider style={{ margin: '24px 0' }} />

      <Section
        title="跨源访问（CORS 白名单）"
        desc="每行一个 Origin。默认空 = 不发跨域头（同源访问足够）；白名单外的跨源写请求会被直接拒绝（防本地 CSRF），非浏览器客户端不受影响。"
      >
        <Input.TextArea
          rows={2}
          style={{ maxWidth: 480 }}
          placeholder={'默认为空\n如需放行其他前端：https://your-app.example.com'}
          value={corsOrigins}
          onChange={(e) => setCorsOrigins(e.target.value)}
        />
      </Section>

      <div style={{ marginTop: 24 }}>
        <Button type="primary" loading={save.isPending} onClick={persist}>
          保存以上修改
        </Button>
        <Typography.Text type="secondary" style={{ fontSize: 12, marginLeft: 12 }}>
          接入地址 / 公网地址 / 密钥 / CORS 一并保存
        </Typography.Text>
      </div>

      <Divider style={{ margin: '24px 0' }} />

      <Section
        title="目录暴露"
        desc="把完整目录模型加入 /v1/models。默认关闭：客户端只看到订阅模型。开关即时生效，无需点保存。"
      >
        <Space align="center">
          <Switch
            checked={data?.exposeCatalog ?? false}
            onChange={(v) => save.mutate({ exposeCatalog: v })}
            loading={save.isPending}
          />
          <Typography.Text style={{ fontSize: 14 }}>
            {data?.exposeCatalog ? '已开启：/v1/models 包含完整目录' : '已关闭：只暴露订阅模型'}
          </Typography.Text>
        </Space>
      </Section>
    </div>
  );
}

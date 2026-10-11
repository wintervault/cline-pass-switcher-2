import { DeleteOutlined, EyeInvisibleOutlined, EyeTwoTone, SaveOutlined } from '@ant-design/icons';
import { App, Button, Divider, Input, Popconfirm, Space, Switch, Tag, Typography, theme } from 'antd';
import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';

import { useMeta, useSaveSecurity, useSecurity } from '../api/hooks.ts';
import { GAP_SECTION } from '../layout.ts';
import { PageHeader, SectionTitle } from '../pageHeader.tsx';

/**
 * 设置行的统一版式：左标签（固定宽） + 右控件（弹性）。
 *
 * 上一版每块自己定控件宽度（480 / 480 / 480），说明文字与控件左右不对齐，
 * 窗口一放大整页就散。现在只有这一个栅格：标签列宽固定，控件列统一铺满。
 */
function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="cps-field">
      <div className="cps-field-label">
        <Typography.Text style={{ fontSize: 13 }}>{label}</Typography.Text>
        {hint && (
          <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 2 }}>
            {hint}
          </Typography.Text>
        )}
      </div>
      <div className="cps-field-body">{children}</div>
    </div>
  );
}

export default function Security() {
  const { message } = App.useApp();
  const { token } = theme.useToken();
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
  const accessBase = meta.data?.proxyBase ?? '—';

  return (
    <div style={{ maxWidth: 760 }}>
      <PageHeader title="访问与安全" desc="下游怎么连、用什么密钥连、跨源怎么放行。低频配置，改完点保存。" />

      {/* 接入区：地址与密钥是同一个问题的两面，放在一起才读得懂 */}
      <div
        style={{
          border: `1px solid ${token.colorBorderSecondary}`,
          borderLeft: `3px solid ${token.colorPrimary}`,
          borderRadius: token.borderRadiusLG,
          background: token.colorBgContainer,
          padding: 20,
          marginBottom: GAP_SECTION,
          display: 'grid',
          gap: 18,
        }}
      >
        <Field label="接入地址" hint="下游客户端（Cline / 任意 OpenAI 兼容工具）填这个 Base URL">
          <Input
            readOnly
            value={accessBase}
            addonAfter={
              <Typography.Text
                copyable={{ text: accessBase, tooltips: ['复制地址', '已复制'] }}
                style={{ fontSize: 13 }}
              >
                复制
              </Typography.Text>
            }
            style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 13 }}
          />
        </Field>

        <Field label="访问密钥" hint="客户端请求头带上：Authorization: Bearer <密钥>">
          <div style={{ display: 'grid', gap: 8 }}>
            <Space size={8} align="center" wrap>
              {data?.authRequired ? (
                <Tag color="green" style={{ margin: 0 }}>
                  鉴权已开启
                </Tag>
              ) : (
                <Tag color="orange" style={{ margin: 0 }}>
                  未开启（仅限本机绑定）
                </Tag>
              )}
              {data?.hasProxyKey ? (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  已设置密钥；输入新值可覆盖，留空保持不变
                </Typography.Text>
              ) : (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  尚未设置——下游无需密钥即可访问（只有本机可达时是安全的）
                </Typography.Text>
              )}
            </Space>
            <Space.Compact style={{ width: '100%', maxWidth: 460 }}>
              <Input.Password
                placeholder={data?.hasProxyKey ? '留空保持不变' : '设置一把密钥（建议 24 位以上随机串）'}
                value={proxyKey}
                onChange={(e) => setProxyKey(e.target.value)}
                iconRender={(visible) => (visible ? <EyeTwoTone /> : <EyeInvisibleOutlined />)}
              />
              <Button
                disabled={!proxyKey.trim()}
                onClick={() =>
                  void navigator.clipboard?.writeText(proxyKey.trim()).then(() => message.success('已复制'))
                }
              >
                复制
              </Button>
            </Space.Compact>
            {data?.hasProxyKey && (
              <div>
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
                  <Button size="small" danger type="text" icon={<DeleteOutlined />}>
                    清除密钥
                  </Button>
                </Popconfirm>
              </div>
            )}
          </div>
        </Field>
      </div>

      <SectionTitle title="部署" />
      <div style={{ display: 'grid', gap: 18, marginBottom: GAP_SECTION }}>
        <Field label="公网代理地址" hint="门户与状态栏展示用；本机自用留空">
          <Input
            style={{ maxWidth: 460 }}
            placeholder="如 https://pass.example.com（本地留空）"
            value={publicBase}
            onChange={(e) => setPublicBase(e.target.value)}
          />
        </Field>
        <Field label="CORS 白名单" hint="每行一个 Origin；留空 = 不发跨域头（同源足够）">
          <Input.TextArea
            rows={3}
            style={{ maxWidth: 460 }}
            placeholder={'默认为空\n如需放行其他前端：https://your-app.example.com'}
            value={corsOrigins}
            onChange={(e) => setCorsOrigins(e.target.value)}
          />
        </Field>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: GAP_SECTION }}>
        <Button type="primary" icon={<SaveOutlined />} loading={save.isPending} onClick={persist}>
          保存修改
        </Button>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          公网地址与 CORS 白名单一起保存
        </Typography.Text>
      </div>

      <Divider style={{ margin: `0 0 ${GAP_SECTION}px` }} />

      <SectionTitle title="目录暴露" />
      <Field label="/v1/models" hint="开关即时生效，无需保存">
        <Space align="center">
          <Switch
            checked={data?.exposeCatalog ?? false}
            onChange={(v) => save.mutate({ exposeCatalog: v })}
            loading={save.isPending}
          />
          <Typography.Text style={{ fontSize: 13 }}>
            {data?.exposeCatalog ? '已开启：/v1/models 返回完整目录' : '已关闭：只返回订阅模型（推荐）'}
          </Typography.Text>
        </Space>
      </Field>
    </div>
  );
}

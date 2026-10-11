import { DeleteOutlined, EyeInvisibleOutlined, EyeTwoTone, SaveOutlined } from '@ant-design/icons';
import { App, Button, Input, Popconfirm, Space, Switch, Tag, Tooltip, Typography, theme } from 'antd';
import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';

import { useMeta, useSaveExposeCatalog, useSaveSecurity, useSecurity } from '../api/hooks.ts';
import { useFeedback } from '../feedback.ts';
import { GAP_SECTION } from '../layout.ts';
import { PageHeader, SectionTitle } from '../pageHeader.tsx';

/**
 * 设置项的统一版式：左标签 + 右控件，说明文字挂在**控件下方**。
 *
 * 说明挂在标签下方时，标签列宽一窄就折成四行（真实反馈里的「水平差」）。
 * 挂在控件下方则是整行宽度，怎么窄都不会挤——这是本页唯一的栅格。
 */
function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="cps-field">
      <div className="cps-field-label">
        <Typography.Text style={{ fontSize: 13 }}>{label}</Typography.Text>
      </div>
      <div className="cps-field-body">
        <div>{children}</div>
        {hint && (
          <Typography.Text
            type="secondary"
            style={{ fontSize: 12, lineHeight: '18px', display: 'block', marginTop: 6 }}
          >
            {hint}
          </Typography.Text>
        )}
      </div>
    </div>
  );
}

export default function Security() {
  const { token } = theme.useToken();
  const security = useSecurity();
  const meta = useMeta();
  const save = useSaveSecurity();
  const saveExpose = useSaveExposeCatalog();
  const fb = useFeedback();
  const { message } = App.useApp();
  const [proxyKey, setProxyKey] = useState('');
  const [publicBase, setPublicBase] = useState('');
  const [corsOrigins, setCorsOrigins] = useState('');

  useEffect(() => {
    if (!security.data) return;
    setPublicBase(security.data.publicBaseUrl);
    setCorsOrigins(security.data.corsOrigins.join('\n'));
  }, [security.data]);

  const data = security.data;
  /** 未保存的改动：只在真的改了东西时才让保存按钮可用（避免「点了没反应」的错觉）。 */
  const dirty =
    proxyKey.trim().length > 0 ||
    (data !== undefined && publicBase !== data.publicBaseUrl) ||
    (data !== undefined && corsOrigins !== data.corsOrigins.join('\n'));

  const persist = (): void => {
    if (!dirty) {
      fb.info('没有需要保存的改动');
      return;
    }
    save.mutate({
      payload: {
        proxyKey: proxyKey.trim(),
        publicBaseUrl: publicBase.trim(),
        corsOrigins: corsOrigins
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter(Boolean),
      },
      note: proxyKey.trim() ? '已保存：API Key 已更新，客户端需同步更换' : '安全设置已保存',
    });
    setProxyKey('');
  };

  const accessBase = meta.data?.proxyBase ?? '—';

  return (
    <div>
      <PageHeader
        title="访问与安全"
        desc="下游客户端怎么连、用什么密钥连、跨源怎么放行。低频配置，改完点右上角保存。"
        actions={
          <Space size={8}>
            {dirty && (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                有未保存的改动
              </Typography.Text>
            )}
            <Button type="primary" icon={<SaveOutlined />} disabled={!dirty} loading={save.isPending} onClick={persist}>
              保存
            </Button>
          </Space>
        }
      />

      <SectionTitle title="接入" />
      <div style={{ display: 'grid', gap: 18, marginBottom: GAP_SECTION }}>
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
            style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 13, maxWidth: 460 }}
          />
        </Field>

        <Field
          label="API Key"
          hint={
            <span>
              下游客户端访问代理时带上它（
              <Typography.Text code style={{ fontSize: 12 }}>
                Authorization: Bearer &lt;API Key&gt;
              </Typography.Text>
              ）。
              <b> 只保护 /v1 代理端点</b>；本机打开这个控制台不需要它——控制台是机器主人的工具，
              不会用一把下发给客户端的密钥把你锁在门外。
            </span>
          }
        >
          <div style={{ display: 'grid', gap: 8 }}>
            {/* 状态与销毁动作同一行：把「清除」从输入框下方挪开，纵向只剩三段（状态 / 输入 / 说明） */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, maxWidth: 460 }}>
              {data?.hasProxyKey ? (
                <Tag color="green" style={{ margin: 0 }}>
                  已设置：客户端必须带密钥
                </Tag>
              ) : (
                <Tag color="orange" style={{ margin: 0 }}>
                  未设置：本机可用，公网部署请务必设置
                </Tag>
              )}
              {data?.hasProxyKey && (
                <Popconfirm
                  title="清除 API Key？"
                  description="清除后下游客户端无需密钥即可调用代理（仅本机绑定时安全）；公网部署不要这样做。"
                  okText="清除"
                  okButtonProps={{ danger: true }}
                  cancelText="取消"
                  onConfirm={() =>
                    save.mutate({ payload: { proxyKey: null }, note: 'API Key 已清除：下游客户端不再需要密钥' })
                  }
                >
                  <Button size="small" danger type="text" icon={<DeleteOutlined />} style={{ marginLeft: 'auto' }}>
                    清除密钥
                  </Button>
                </Popconfirm>
              )}
            </div>
            <Space.Compact style={{ width: '100%', maxWidth: 460 }}>
              <Input.Password
                placeholder={
                  data?.hasProxyKey ? '留空 = 保持不变；输入新值可覆盖' : '设置一把密钥（建议 24 位以上随机串）'
                }
                value={proxyKey}
                onChange={(e) => setProxyKey(e.target.value)}
                iconRender={(visible) => (visible ? <EyeTwoTone /> : <EyeInvisibleOutlined />)}
              />
              <Button
                disabled={!proxyKey.trim()}
                onClick={() => {
                  void navigator.clipboard?.writeText(proxyKey.trim()).then(
                    () => fb.copy('API Key '),
                    () => message.error('复制失败（剪贴板不可用）'),
                  );
                }}
              >
                复制
              </Button>
            </Space.Compact>
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
        <Field
          label="CORS 白名单"
          hint="每行一个 Origin。留空 = 不发跨域头（同源访问已经够用）；白名单外的跨源写请求会被直接拒绝（防本地 CSRF），非浏览器客户端不受影响。"
        >
          <Input.TextArea
            rows={3}
            style={{ maxWidth: 460 }}
            placeholder={'默认为空\n如需放行其他前端：https://your-app.example.com'}
            value={corsOrigins}
            onChange={(e) => setCorsOrigins(e.target.value)}
          />
        </Field>
      </div>

      <SectionTitle title="目录暴露" />
      <Field label="/v1/models" hint="开关即时生效，不需要点保存">
        <Space align="center">
          <Switch
            checked={data?.exposeCatalog ?? false}
            onChange={(v) => saveExpose.mutate(v)}
            loading={saveExpose.isPending}
          />
          <Tooltip
            title={
              data?.exposeCatalog
                ? '任何拿到接入地址的人都能看到你的完整模型目录'
                : '下游只看到你在「订阅模型」里配置过的模型'
            }
          >
            <Typography.Text style={{ fontSize: 13, borderBottom: `1px dashed ${token.colorBorder}` }}>
              {data?.exposeCatalog ? '已开启：返回完整目录' : '已关闭：只返回订阅模型（推荐）'}
            </Typography.Text>
          </Tooltip>
        </Space>
      </Field>
    </div>
  );
}

import { ReloadOutlined } from '@ant-design/icons';
import { Alert, Button, Space } from 'antd';

import type { HostControl } from './hostBridge.ts';
import { useI18n } from './i18n/index.tsx';

/**
 * 服务异常时的页面级提示。
 *
 * 页面内容在服务停止后仍会留在屏幕上（查询缓存），如果只在状态栏点一个红点，
 * 用户会以为看到的是实时数据。这里明确讲清：数据是旧的 + 怎么恢复 + 失败原因。
 *
 * 「壳进程已退出」是独立的一档：控制通道都连不上时，页面里再点多少次「启动」
 * 都没用（没人接了），这时唯一正确的指引是重新打开应用——以前这种情况会
 * 一直显示「已停止」，用户按提示点「启动服务」却毫无反应，是最迷惑的一种状态。
 */
export function ServiceBanner({ control }: { control: HostControl }) {
  const { t } = useI18n();
  const { host, status, busy, error } = control;
  if (!host) return null;
  if (status.state === 'running') return null;

  if (status.state === 'starting') {
    return (
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message={t('service.starting.title')}
        description={t('service.starting.desc')}
      />
    );
  }

  if (status.state === 'stopping') {
    return (
      <Alert
        type="warning"
        showIcon
        style={{ marginBottom: 16 }}
        message={t('service.stopping.title')}
        description={t('service.stopping.desc')}
      />
    );
  }

  // 控制通道不通 = 壳进程已经不在了。此时任何按钮都按不动，只能请用户重开应用。
  const hostGone = status.port === 0 || (error ?? '').toLowerCase().includes('fetch');

  if (status.state === 'stopped') {
    return (
      <Alert
        type="warning"
        showIcon
        style={{ marginBottom: 16 }}
        message={t('service.stopped.title')}
        description={t('service.stopped.desc')}
        action={
          <Button size="small" type="primary" loading={busy} onClick={() => void control.start()}>
            {t('service.action.start')}
          </Button>
        }
      />
    );
  }

  // error 档：启动失败，或控制通道本身不通
  if (hostGone) {
    return (
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message={t('service.gone.title')}
        description={t('service.gone.desc')}
      />
    );
  }

  return (
    <Alert
      type="error"
      showIcon
      style={{ marginBottom: 16 }}
      message={t('service.error.title')}
      description={
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          <span>{status.error ?? error ?? t('service.error.unknown')}</span>
          <Space size={8}>
            <Button size="small" type="primary" loading={busy} onClick={() => void control.start()}>
              {t('service.action.retryStart')}
            </Button>
            <Button size="small" icon={<ReloadOutlined />} onClick={control.openLogs}>
              {t('service.action.viewLogs')}
            </Button>
          </Space>
        </Space>
      }
    />
  );
}

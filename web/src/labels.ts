import type { AccountClassKind, UpstreamStatusKind } from './api/types.ts';
import type { MsgKey } from './i18n/index.tsx';

/**
 * 状态 → 徽标（文案 key + 颜色）。
 *
 * 放在 UI 层而不是 `api/types.ts`：那里只镜像服务端的数据形状，
 * 而「可用 / 限流 / 风控」是界面语言，要跟着语言切换。
 */

export const STATUS_TAG: Record<UpstreamStatusKind, { labelKey: MsgKey; color: string }> = {
  ok: { labelKey: 'labels.upstream.ok', color: 'green' },
  limited: { labelKey: 'labels.upstream.limited', color: 'gold' },
  bad: { labelKey: 'labels.upstream.bad', color: 'red' },
  auth: { labelKey: 'labels.upstream.auth', color: 'volcano' },
  unknown: { labelKey: 'labels.upstream.unknown', color: 'default' },
};

export const ACCOUNT_CLASS_TAG: Record<AccountClassKind, { labelKey: MsgKey; color: string }> = {
  normal: { labelKey: 'labels.class.normal', color: 'green' },
  private: { labelKey: 'labels.class.private', color: 'orange' },
  unknown: { labelKey: 'labels.class.unknown', color: 'default' },
};

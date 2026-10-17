import type { Notice } from '../api/types.ts';
import type { MsgKey } from './index.tsx';

/**
 * 后端返回的用户可见文案：**稳定 code + params**，这里映射成词条。
 *
 * 不在前端猜后端字符串（中英文混排、原文变化都会立刻破功）；未知 code 返回空串，
 * 宁可少显示一句，也不把中文原文泄漏到英文界面里。原始信息仍在服务端日志里。
 */
const NOTICE_KEYS: Record<string, MsgKey> = {
  'account.keyOkGatewayNotice': 'toast.account.notice',
};

export function noticeText(
  t: (key: MsgKey, params?: Record<string, string | number>) => string,
  notice: Notice | undefined,
): string {
  if (!notice) return '';
  const key = NOTICE_KEYS[notice.code];
  if (!key) return '';
  return t(key, notice.params);
}

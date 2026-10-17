import { daysUntil, isIsoDate } from '../config/date.ts';

/**
 * 到期状态。服务端算好状态与天数、前端只负责渲染——理由有两条：
 * 1. 「今天」以**服务端时钟**为准（用户机器时间可能不准）；
 * 2. 3.0 的 i18n 决定是「后端返回 code + params」（ROADMAP §9 第 13 条），
 *    到期状态正好是 `{ kind, days }` 这种形状，前端按 kind 取词、按 days 拼数。
 */
export type ExpiryKind = 'none' | 'active' | 'soon' | 'expired';

export interface ExpiryState {
  kind: ExpiryKind;
  /** 距到期还有几天（今天 = 0，已过期为负）；`none` 时为 null。 */
  days: number | null;
}

/** 到期前多少天内算「即将到期」（金色徽标）。 */
export const EXPIRY_SOON_DAYS = 7;

export function expiryState(expiresAt: string | undefined | null, now: Date = new Date()): ExpiryState {
  // 配置里存的是用户声明，可能被手改坏；坏值当作「未设置」，而不是抛错
  if (!expiresAt || !isIsoDate(expiresAt)) return { kind: 'none', days: null };
  const days = daysUntil(expiresAt, now);
  if (days === null) return { kind: 'none', days: null };
  if (days < 0) return { kind: 'expired', days };
  if (days <= EXPIRY_SOON_DAYS) return { kind: 'soon', days };
  return { kind: 'active', days };
}

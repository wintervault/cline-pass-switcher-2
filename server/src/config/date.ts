/**
 * 配置里日期字段的格式契约与计算。
 *
 * 统一用**本地日期** `YYYY-MM-DD`，不引入时区/时刻复杂度：
 * 「到期时间」是用户心智里的日历日期，不是某一瞬间。也正因为如此，
 * 解析必须按本地日历构造 `Date(y, m-1, d)`，不能用 `new Date('2026-11-01')`
 * ——后者按 UTC 解析，在东八区会变成前一天 08:00，天数差会整体偏一天。
 */

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** 是否是真实存在的 `YYYY-MM-DD`（`2026-02-31` 这类「格式对、日期不存在」也算非法）。 */
export function isIsoDate(s: string): boolean {
  const m = ISO_DATE.exec(s);
  if (!m) return false;
  const y = Number(m[1] ?? 0);
  const mo = Number(m[2] ?? 0);
  const d = Number(m[3] ?? 0);
  // 用本地日历往返比较：2 月 31 日会被 Date 进位成 3 月 3 日，比较即失败
  const date = new Date(y, mo - 1, d);
  return date.getFullYear() === y && date.getMonth() === mo - 1 && date.getDate() === d;
}

/**
 * `expiresAt` 与本地的天数差：正数 = 还有几天，0 = 今天，负数 = 已过期几天。
 * 非法或缺失返回 null（调用方据此显示「未设置」）。
 *
 * 用 `Math.round` 而不是 `floor`：目标与今天都取本地零点，差值本应是整天，
 * 但夏令时切换日会差一小时——round 保证那天仍然是「1 天」而不是「0 天」。
 */
export function daysUntil(expiresAt: string | undefined | null, now: Date = new Date()): number | null {
  if (!expiresAt || !isIsoDate(expiresAt)) return null;
  const m = ISO_DATE.exec(expiresAt);
  const y = Number(m?.[1] ?? 0);
  const mo = Number(m?.[2] ?? 0);
  const d = Number(m?.[3] ?? 0);
  const target = new Date(y, mo - 1, d);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((target.getTime() - today.getTime()) / 86_400_000);
}

import { describe, expect, it } from 'vitest';

import { expiryState } from '../src/accounts/expiry.ts';
import { daysUntil, isIsoDate } from '../src/config/date.ts';
import { AccountSchema, defaultConfig } from '../src/config/schema.ts';

/** 本地中午，避免测试在「零点边界」上抖动。 */
const at = (y: number, m: number, d: number) => new Date(y, m - 1, d, 12, 0, 0);

describe('isIsoDate', () => {
  it('接受真实存在的日期', () => {
    expect(isIsoDate('2026-11-01')).toBe(true);
    expect(isIsoDate('2028-02-29')).toBe(true); // 闰年
  });

  it('拒绝格式错误与不存在的日期', () => {
    expect(isIsoDate('2026-1-1')).toBe(false);
    expect(isIsoDate('2026/11/01')).toBe(false);
    expect(isIsoDate('')).toBe(false);
    expect(isIsoDate('2026-02-31')).toBe(false); // 格式对但日期不存在
    expect(isIsoDate('2026-13-01')).toBe(false);
    expect(isIsoDate('2027-02-29')).toBe(false); // 非闰年
  });
});

describe('daysUntil', () => {
  it('按本地日历计算整天差（不受时区/时刻影响）', () => {
    expect(daysUntil('2026-11-01', at(2026, 11, 1))).toBe(0);
    expect(daysUntil('2026-11-01', at(2026, 10, 31))).toBe(1);
    expect(daysUntil('2026-11-01', at(2026, 11, 2))).toBe(-1);
    expect(daysUntil('2026-11-01', at(2026, 10, 1))).toBe(31);
  });

  it('缺省或非法返回 null', () => {
    expect(daysUntil(undefined, at(2026, 10, 17))).toBeNull();
    expect(daysUntil(null, at(2026, 10, 17))).toBeNull();
    expect(daysUntil('2026-99-99', at(2026, 10, 17))).toBeNull();
  });
});

describe('expiryState', () => {
  const now = at(2026, 10, 17);

  it('未设置 → none', () => {
    expect(expiryState(undefined, now)).toEqual({ kind: 'none', days: null });
    expect(expiryState('', now)).toEqual({ kind: 'none', days: null });
    expect(expiryState('被手改坏的值', now)).toEqual({ kind: 'none', days: null });
  });

  it('7 天内（含今天）→ soon', () => {
    expect(expiryState('2026-10-17', now)).toEqual({ kind: 'soon', days: 0 });
    expect(expiryState('2026-10-24', now)).toEqual({ kind: 'soon', days: 7 });
  });

  it('8 天以上 → active', () => {
    expect(expiryState('2026-10-25', now)).toEqual({ kind: 'active', days: 8 });
  });

  it('已过期 → expired（到期不自动停用，只是标记）', () => {
    expect(expiryState('2026-10-16', now)).toEqual({ kind: 'expired', days: -1 });
  });
});

describe('AccountSchema.expiresAt', () => {
  const base = { name: 'a', key: 'sk_a', enabled: true };

  it('合法日期保留；非法日期按「未设置」处理，账号本身不丢', () => {
    expect(AccountSchema.parse({ ...base, expiresAt: '2026-12-01' }).expiresAt).toBe('2026-12-01');
    const broken = AccountSchema.parse({ ...base, expiresAt: '2026-02-31' });
    expect(broken.expiresAt).toBeUndefined();
    expect(broken.key).toBe('sk_a');
  });
});

describe('ConfigSchema.classifyModel', () => {
  it('默认值是 planner 管线的 flash 模型', () => {
    expect(defaultConfig().classifyModel).toBe('cline-pass/deepseek-v4.1-flash');
  });
});

import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * 恒定时间字符串比较。
 *
 * 直接 `a === b` 会在首个不同字符处短路，攻击者可以通过反复测量响应耗时逐字节猜出密钥。
 * 这里先把两侧各自 SHA-256 到定长再比——长度差异也不会通过短路泄露。
 */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a, 'utf8').digest();
  const hb = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(ha, hb);
}

/** 判断绑定地址是否只对本机可见。 */
export function isLoopbackHost(host: string): boolean {
  const h = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h.startsWith('127.');
}

/**
 * 密钥掩码：只保留末尾 4 位，用于控制台展示。
 * 短于 8 位的密钥一律全掩，避免掩码本身就泄露了大半内容。
 */
export function maskSecret(secret: string): string {
  const s = String(secret ?? '');
  if (!s) return '';
  if (s.length < 8) return '••••';
  return `${'•'.repeat(Math.min(8, s.length - 4))}${s.slice(-4)}`;
}

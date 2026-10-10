import { describe, expect, it } from 'vitest';
import { enabledAccounts, isConfigured, publicProxyBase } from '../src/config/derive.ts';
import { applyEnvOverrides } from '../src/config/env.ts';
import { defaultConfig } from '../src/config/schema.ts';
import { assertBindSafe, InsecureBindError } from '../src/security/bind.ts';
import { isLoopbackHost, maskSecret, safeEqual } from '../src/security/compare.ts';

describe('safeEqual', () => {
  it('相等返回 true，不等返回 false', () => {
    expect(safeEqual('sk_abc', 'sk_abc')).toBe(true);
    expect(safeEqual('sk_abc', 'sk_abd')).toBe(false);
  });

  it('长度不同也不抛异常（timingSafeEqual 要求等长，所以先 hash）', () => {
    expect(safeEqual('a', 'a-very-long-key')).toBe(false);
    expect(safeEqual('', 'x')).toBe(false);
    expect(safeEqual('', '')).toBe(true);
  });

  it('中文/多字节字符不会崩', () => {
    expect(safeEqual('密钥', '密钥')).toBe(true);
    expect(safeEqual('密钥', '密鈅')).toBe(false);
  });
});

describe('isLoopbackHost', () => {
  it.each(['127.0.0.1', '127.1.2.3', 'localhost', 'LOCALHOST', '::1', '[::1]', '  127.0.0.1  '])(
    '%s 是回环',
    (host) => {
      expect(isLoopbackHost(host)).toBe(true);
    },
  );

  it.each(['0.0.0.0', '::', '192.168.1.10', 'pass.example.com', '10.0.0.1'])('%s 不是回环', (host) => {
    expect(isLoopbackHost(host)).toBe(false);
  });
});

describe('maskSecret', () => {
  it('只保留末尾 4 位', () => {
    const masked = maskSecret('sk_abcdefghijklmn');
    expect(masked.endsWith('klmn')).toBe(true);
    expect(masked).not.toContain('abcdefgh');
  });

  it('短密钥全掩，避免掩码本身就泄露大半内容', () => {
    expect(maskSecret('sk_abc')).toBe('••••');
    expect(maskSecret('')).toBe('');
  });
});

describe('assertBindSafe', () => {
  const base = { bindHost: '127.0.0.1', proxyKey: '' };

  it('回环绑定无密钥 → 放行（本地自用）', () => {
    expect(() => assertBindSafe(base, {})).not.toThrow();
  });

  it('非回环 + 有密钥 → 放行', () => {
    expect(() => assertBindSafe({ bindHost: '0.0.0.0', proxyKey: 'sk_down' }, {})).not.toThrow();
  });

  it('非回环 + 无密钥 → 拒绝启动', () => {
    expect(() => assertBindSafe({ bindHost: '0.0.0.0', proxyKey: '' }, {})).toThrow(InsecureBindError);
    expect(() => assertBindSafe({ bindHost: 'pass.example.com', proxyKey: '' }, {})).toThrow(InsecureBindError);
  });

  it('报错信息给出可执行的修复方式', () => {
    try {
      assertBindSafe({ bindHost: '0.0.0.0', proxyKey: '' }, {});
      expect.unreachable('应当抛错');
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain('PROXY_KEY=');
      expect(message).toContain('BIND_HOST=127.0.0.1');
      expect(message).toContain('ALLOW_INSECURE_BIND=1');
    }
  });

  it('逃生舱 ALLOW_INSECURE_BIND=1 可放行', () => {
    expect(() => assertBindSafe({ bindHost: '0.0.0.0', proxyKey: '' }, { ALLOW_INSECURE_BIND: '1' })).not.toThrow();
    expect(() => assertBindSafe({ bindHost: '0.0.0.0', proxyKey: '' }, { ALLOW_INSECURE_BIND: '0' })).toThrow();
  });
});

describe('applyEnvOverrides', () => {
  it('CLINE_PASS_KEY 注入账号池且不重复', () => {
    const cfg = defaultConfig();
    expect(applyEnvOverrides(cfg, { CLINE_PASS_KEY: 'sk_env' })).toContain('CLINE_PASS_KEY 已注入账号池');
    expect(cfg.accounts).toEqual([{ name: 'env-account', key: 'sk_env', enabled: true }]);
    // 再次应用不重复插入
    applyEnvOverrides(cfg, { CLINE_PASS_KEY: 'sk_env' });
    expect(cfg.accounts).toHaveLength(1);
  });

  it('PROXY_KEY / PUBLIC_BASE_URL / PORT / BIND_HOST 覆盖生效', () => {
    const cfg = defaultConfig();
    applyEnvOverrides(cfg, {
      PROXY_KEY: 'sk_down',
      PUBLIC_BASE_URL: 'https://pass.example.com/',
      PORT: '8080',
      BIND_HOST: '0.0.0.0',
    });
    expect(cfg.proxyKey).toBe('sk_down');
    expect(cfg.publicBaseUrl).toBe('https://pass.example.com'); // 去掉尾斜杠
    expect(cfg.port).toBe(8080);
    expect(cfg.bindHost).toBe('0.0.0.0');
  });

  it('非法 PORT 被忽略', () => {
    const cfg = defaultConfig();
    applyEnvOverrides(cfg, { PORT: 'abc' });
    expect(cfg.port).toBe(3123);
    applyEnvOverrides(cfg, { PORT: '99999' });
    expect(cfg.port).toBe(3123);
  });
});

describe('derive', () => {
  it('isConfigured 只看启用且 key 非空的账号', () => {
    const cfg = defaultConfig();
    expect(isConfigured(cfg)).toBe(false);
    cfg.accounts = [{ name: 'a', key: 'sk_a', enabled: false }];
    expect(isConfigured(cfg)).toBe(false);
    cfg.accounts.push({ name: 'b', key: 'sk_b', enabled: true });
    expect(isConfigured(cfg)).toBe(true);
    expect(enabledAccounts(cfg)).toHaveLength(1);
  });

  it('publicProxyBase 优先用 publicBaseUrl，否则按绑定地址推导', () => {
    const cfg = defaultConfig();
    expect(publicProxyBase(cfg)).toBe('http://127.0.0.1:3123/v1');
    cfg.publicBaseUrl = 'https://pass.example.com/';
    expect(publicProxyBase(cfg)).toBe('https://pass.example.com/v1');
  });

  it('绑定 0.0.0.0 时展示用 0.0.0.0 而非 127.0.0.1', () => {
    const cfg = defaultConfig();
    cfg.bindHost = '0.0.0.0';
    cfg.port = 9000;
    expect(publicProxyBase(cfg)).toBe('http://0.0.0.0:9000/v1');
  });
});

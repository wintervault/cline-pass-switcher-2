import { describe, expect, it } from 'vitest';

import { AccountPool } from '../src/accounts/pool.ts';
import { defaultConfig } from '../src/config/schema.ts';

const acc = (name: string, key = `sk_${name}`, enabled = true) => ({ name, key, enabled });

/**
 * 账号池按网关构造：这里直接用「一个网关」的视角（账号子集 = 全部）。
 * single 模式用**账号名**指定（3.0 起账号标识是 name，不再用下标）。
 */
const poolWith = (accounts: Parameters<typeof acc>[], mode: 'sticky' | 'single' | 'roundrobin', active = '') => {
  const config = defaultConfig();
  config.accounts = accounts.map(([n, k, e]) => acc(n as string, k as string | undefined, e as boolean | undefined));
  const view = { accounts: config.accounts, accountMode: mode, activeAccount: active };
  return new AccountPool(() => view);
};

describe('AccountPool.pick', () => {
  it('无可用账号 → null（调用方应返回明确的配置错误）', () => {
    expect(poolWith([], 'sticky').pick()).toBeNull();
    expect(poolWith([['a', 'sk_a', false]], 'sticky').pick()).toBeNull();
    expect(poolWith([['a', '']], 'sticky').pick()).toBeNull();
  });

  it('sticky：反复 pick 得到同一个账号（保 prompt cache）', () => {
    const pool = poolWith([['a'], ['b'], ['c']], 'sticky');
    const first = pool.pick();
    expect(first?.name).toBe('a');
    expect(pool.pick()?.name).toBe('a');
    expect(pool.pick()?.name).toBe('a');
  });

  it('single：用 activeAccount 指定的账号', () => {
    const pool = poolWith([['a'], ['b'], ['c']], 'single', 'c');
    expect(pool.pick()?.name).toBe('c');
  });

  it('single：activeAccount 指向禁用账号时回退到第一个启用的', () => {
    const pool = poolWith([['a', 'sk_a', false], ['b']], 'single', 'a');
    expect(pool.pick()?.name).toBe('b');
  });

  it('roundrobin：连续 pick 依次轮换（旧版行为，牺牲缓存）', () => {
    const pool = poolWith([['a'], ['b'], ['c']], 'roundrobin');
    expect([pool.pick()?.name, pool.pick()?.name, pool.pick()?.name, pool.pick()?.name]).toEqual(['a', 'b', 'c', 'a']);
  });

  it('roundrobin 只有一个账号时不轮换', () => {
    const pool = poolWith([['a']], 'roundrobin');
    expect(pool.pick()?.name).toBe('a');
  });
});

describe('AccountPool.rotate', () => {
  it('sticky：账号级错误后轮转到下一个启用账号并保持', () => {
    const pool = poolWith([['a'], ['b'], ['c']], 'sticky');
    const failed = pool.pick();
    expect(failed?.name).toBe('a');
    const next = pool.rotate(failed as never, 'key 失效');
    expect(next?.name).toBe('b');
    expect(pool.pick()?.name).toBe('b'); // 粘在新账号上
  });

  it('轮转到最后一个后回到第一个（环形）', () => {
    const pool = poolWith([['a'], ['b']], 'sticky');
    let current = pool.pick();
    const seen = [current?.name];
    for (let i = 0; i < 3; i++) {
      current = pool.rotate(current as never, 'err');
      seen.push(current?.name);
    }
    expect(seen).toEqual(['a', 'b', 'a', 'b']);
  });

  it('只有一个启用账号时 rotate 返回 null（调用方应直接报错）', () => {
    const pool = poolWith([['a']], 'sticky');
    const failed = pool.pick();
    expect(pool.rotate(failed as never, 'err')).toBeNull();
  });

  it('rotate 触发监听器（供日志/历史记录）', () => {
    const pool = poolWith([['a'], ['b']], 'sticky');
    const events: string[] = [];
    pool.onRotate((info) => events.push(`${info.from}→${info.to}:${info.reason}`));
    const failed = pool.pick();
    pool.rotate(failed as never, '401');
    expect(events).toEqual(['a→b:401']);
  });

  it('single 模式同样可以轮转（账号挂了总比直接失败好）', () => {
    const pool = poolWith([['a'], ['b']], 'single', 'a');
    const failed = pool.pick();
    expect(pool.rotate(failed as never, 'key 失效')?.name).toBe('b');
  });

  it('账号列表变更后 pick 反映最新状态（引用同一 Config 对象）', () => {
    const config = defaultConfig();
    config.accounts = [acc('a')];
    const pool = new AccountPool(() => ({ accounts: config.accounts, accountMode: 'sticky', activeAccount: '' }));
    expect(pool.pick()?.name).toBe('a');
    // 控制台保存后是就地更新同一对象
    config.accounts = [acc('a'), acc('b')];
    expect(pool.enabled()).toHaveLength(2);
    expect(pool.pick()?.name).toBe('a');
  });
});

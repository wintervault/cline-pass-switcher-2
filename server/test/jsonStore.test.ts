import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { atomicWriteFile, JsonStore, readJsonFile } from '../src/store/jsonStore.ts';

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cps-store-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('atomicWriteFile', () => {
  it('写入后内容完整可读', async () => {
    const file = path.join(dir, 'a.json');
    await atomicWriteFile(file, '{"x":1}');
    expect(await fs.readFile(file, 'utf8')).toBe('{"x":1}');
  });

  it('覆盖已有文件而不是追加', async () => {
    const file = path.join(dir, 'a.json');
    await atomicWriteFile(file, '{"long":"aaaaaaaaaaaaaaaaaaaa"}');
    await atomicWriteFile(file, '{"x":1}');
    expect(await fs.readFile(file, 'utf8')).toBe('{"x":1}');
  });

  it('不留下临时文件', async () => {
    const file = path.join(dir, 'a.json');
    await atomicWriteFile(file, '{}');
    const entries = await fs.readdir(dir);
    expect(entries.filter((e) => e.endsWith('.tmp'))).toEqual([]);
  });

  it('写入失败时清理临时文件且不破坏原文件', async () => {
    const file = path.join(dir, 'a.json');
    await atomicWriteFile(file, '{"original":true}');
    // 目标目录不存在 → 写临时文件阶段就会失败
    await expect(atomicWriteFile(path.join(dir, 'nope', 'b.json'), '{}')).rejects.toThrow();
    expect(await fs.readFile(file, 'utf8')).toBe('{"original":true}');
    expect((await fs.readdir(dir)).filter((e) => e.endsWith('.tmp'))).toEqual([]);
  });
});

describe('readJsonFile', () => {
  it('文件不存在 → value=null, corrupt=false', async () => {
    expect(await readJsonFile(path.join(dir, 'missing.json'))).toEqual({ value: null, corrupt: false, raw: null });
  });

  it('内容截断 → corrupt=true 并带回原始文本', async () => {
    const file = path.join(dir, 'broken.json');
    await fs.writeFile(file, '{"accounts":[{"key":"sk_abc');
    const r = await readJsonFile(file);
    expect(r.corrupt).toBe(true);
    expect(r.value).toBeNull();
    expect(r.raw).toContain('sk_abc'); // 原始内容要留给调用方备份
  });
});

describe('JsonStore', () => {
  it('update 后 flush 落盘', async () => {
    const file = path.join(dir, 'c.json');
    const store = new JsonStore<{ n: number }>(file, { n: 0 }, { debounceMs: 5 });
    store.update((v) => {
      v.n = 42;
    });
    await store.flush();
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({ n: 42 });
  });

  it('防抖：连续多次 update 合并为最终值', async () => {
    const file = path.join(dir, 'c.json');
    const store = new JsonStore<{ n: number }>(file, { n: 0 }, { debounceMs: 50 });
    for (let i = 1; i <= 20; i++) {
      store.update((v) => {
        v.n = i;
      });
    }
    await store.flush();
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({ n: 20 });
  });

  it('flush 期间并发 update 不会丢：最终落盘是最新值', async () => {
    const file = path.join(dir, 'c.json');
    const store = new JsonStore<{ n: number }>(file, { n: 0 }, { debounceMs: 1 });
    store.update((v) => {
      v.n = 1;
    });
    const flushing = store.flush();
    store.update((v) => {
      v.n = 2;
    });
    await flushing;
    await store.flush();
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({ n: 2 });
  });

  it('写盘失败不抛出，保留脏标记供下次重试', async () => {
    const errors: unknown[] = [];
    // 目录不存在 → 写盘必然失败
    const store = new JsonStore<{ n: number }>(
      path.join(dir, 'nope', 'c.json'),
      { n: 0 },
      {
        debounceMs: 1,
        onError: (e) => errors.push(e),
      },
    );
    store.update((v) => {
      v.n = 1;
    });
    await expect(store.flush()).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
  });

  it('close 后不再安排写盘', async () => {
    const file = path.join(dir, 'c.json');
    const store = new JsonStore<{ n: number }>(file, { n: 0 }, { debounceMs: 5 });
    store.close();
    store.update((v) => {
      v.n = 1;
    });
    await new Promise((r) => setTimeout(r, 30));
    await expect(fs.access(file)).rejects.toThrow();
  });

  it('maxDelayMs 上限：持续 update 也会在窗口内落盘', async () => {
    const file = path.join(dir, 'c.json');
    const store = new JsonStore<{ n: number }>(file, { n: 0 }, { debounceMs: 1000, maxDelayMs: 20 });
    const started = Date.now();
    // 每 5ms 改一次，防抖永远在重置；但 maxDelayMs 到了就必须写
    const ticker = setInterval(() => {
      store.update((v) => {
        v.n += 1;
      });
    }, 5);
    await new Promise((r) => setTimeout(r, 120));
    clearInterval(ticker);
    expect(Date.now() - started).toBeLessThan(1000);
    await store.flush();
    const onDisk = JSON.parse(await fs.readFile(file, 'utf8')) as { n: number };
    expect(onDisk.n).toBeGreaterThan(0);
  });
});

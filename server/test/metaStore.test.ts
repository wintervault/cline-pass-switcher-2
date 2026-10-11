import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JsonStore } from '../src/store/jsonStore.ts';
import { loadMetaStore } from '../src/store/metaStore.ts';

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cps-meta-'));
  file = path.join(dir, 'metadata.json');
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const listBackups = async () => (await fs.readdir(dir)).filter((f) => f.includes('.broken-'));

describe('loadMetaStore', () => {
  // 旧版缺陷：metadata.json 内容为 {} 时 META.history 为 undefined，
  // record() 里 history.unshift 抛 TypeError → 聊天接口 500（实测确认）
  it('空对象 {} → 完整默认结构，绝不崩溃', async () => {
    await fs.writeFile(file, '{}');
    const { store, notes } = await loadMetaStore(file);
    const meta = store.value;
    expect(Array.isArray(meta.history)).toBe(true);
    expect(typeof meta.models).toBe('object');
    expect(typeof meta.stats).toBe('object');
    expect(meta.catalog).toBeNull();
    expect(notes).toEqual([]);
  });

  it('文件不存在 → 默认结构，无备份', async () => {
    const { store } = await loadMetaStore(file);
    expect(store.value.history).toEqual([]);
    expect(await listBackups()).toEqual([]);
  });

  it('截断 JSON → 备份原文件 + 重建', async () => {
    await fs.writeFile(file, '{"history":[{"ts":1');
    const { store, backupPath } = await loadMetaStore(file);
    expect(store.value.history).toEqual([]);
    expect(backupPath).not.toBeNull();
    expect(await listBackups()).toHaveLength(1);
    const backed = await fs.readFile(backupPath as string, 'utf8');
    expect(backed).toContain('"ts":1');
  });

  it('history 为 null（旧版会崩的另一种形态）→ 重建为空数组', async () => {
    await fs.writeFile(file, '{"history":null,"models":{}}');
    const { store } = await loadMetaStore(file);
    expect(store.value.history).toEqual([]);
  });

  it('顶层是数组（同属「不是对象映射」）→ 备份 + 重建，不静默清空', async () => {
    await fs.writeFile(file, '[{"history":[]}]');
    const { store, backupPath } = await loadMetaStore(file);
    expect(store.value.history).toEqual([]);
    expect(backupPath).not.toBeNull();
    expect(await listBackups()).toHaveLength(1);
  });

  it('损坏的模型记录被丢弃，好的保留', async () => {
    await fs.writeFile(
      file,
      JSON.stringify({
        models: {
          'cline-pass/good': {
            pipeline: 'planner',
            upstreams: ['a', 'b'],
            upstreamStatus: { a: { status: 'ok' } },
          },
          'cline-pass/bad': { pipeline: 12345, upstreams: '不是数组' },
        },
      }),
    );
    const { store, notes } = await loadMetaStore(file);
    expect(Object.keys(store.value.models)).toEqual(['cline-pass/good']);
    expect(store.value.models['cline-pass/good']?.upstreams).toEqual(['a', 'b']);
    // 字段级 catch 会把垃圾输入「修复」成默认值，修复后仍无信息量 → 丢弃
    expect(notes.join()).toContain('丢弃了 1 个损坏或无信息量的模型观测记录');
  });

  it('损坏的历史条目被丢弃', async () => {
    await fs.writeFile(
      file,
      JSON.stringify({
        history: [
          { ts: 111, model: 'cline-pass/x', provider: 'alibaba', stream: false },
          { garbage: true },
          'string entry',
        ],
      }),
    );
    const { store, notes } = await loadMetaStore(file);
    expect(store.value.history).toHaveLength(1);
    expect(store.value.history[0]?.model).toBe('cline-pass/x');
    expect(notes.join()).toContain('丢弃了 2 条损坏的历史记录');
  });

  it('缺少的字段用默认值补全（不要求全量结构）', async () => {
    await fs.writeFile(file, JSON.stringify({ models: { 'cline-pass/x': { pipeline: 'direct' } } }));
    const { store } = await loadMetaStore(file);
    const m = store.value.models['cline-pass/x'];
    expect(m?.pipeline).toBe('direct');
    expect(m?.pinnable).toBe(false);
    expect(m?.upstreams).toEqual([]);
    expect(m?.upstreamDetail).toEqual({});
    expect(m?.lastProvider).toBeNull();
  });
});

describe('MetaStore 写回', () => {
  it('记录历史并落盘，写回后可再读回', async () => {
    await fs.writeFile(file, '{}');
    const { store } = await loadMetaStore(file);

    store.update((meta) => {
      meta.history.unshift({
        ts: 1234,
        model: 'cline-pass/glm-5.2',
        provider: 'alibaba',
        canonical: 'zai/glm-5.2',
        ms: 2500,
        stream: true,
        error: null,
        account: 'A',
        attempts: ['alibaba'],
        trace: [{ upstream: 'alibaba', status: 200, ms: 2400, note: 'stream' }],
        pinMismatch: false,
      });
      meta.models['cline-pass/glm-5.2'] = {
        pipeline: 'planner',
        pinnable: true,
        pinState: 'enforced',
        pinProbeAt: null,
        pinDisabledReason: null,
        availableProviders: ['alibaba', 'baseten'],
        upstreams: ['alibaba', 'baseten'],
        upstreamDetail: {},
        upstreamStatus: {},
        tier0: [],
        canonicalSlug: 'zai/glm-5.2',
        openrouterSlug: null,
        lastProvider: 'alibaba',
        lastMs: 2500,
        probedAt: 1234,
        validatedAt: null,
      };
    });
    await store.flush();

    // 用全新的 store 重新读回，验证落盘内容完整
    const second = await loadMetaStore(file);
    expect(second.store.value.history).toHaveLength(1);
    expect(second.store.value.history[0]?.trace[0]?.note).toBe('stream');
    expect(second.store.value.models['cline-pass/glm-5.2']?.availableProviders).toEqual(['alibaba', 'baseten']);
  });

  it('JsonStore 与 MetaStore 共用同一套原子写', async () => {
    const store = new JsonStore<{ n: number }>(file, { n: 0 }, { debounceMs: 1 });
    store.update((v) => {
      v.n = 9;
    });
    await store.flush();
    const onDisk = JSON.parse(await fs.readFile(file, 'utf8')) as { n: number };
    expect(onDisk.n).toBe(9);
  });
});

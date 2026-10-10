import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig, writeConfig } from '../src/config/load.ts';
import { ConfigTooNewError, migrateConfig } from '../src/config/migrate.ts';
import { CONFIG_VERSION, defaultConfig, FailoverSchema } from '../src/config/schema.ts';

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cps-config-'));
  file = path.join(dir, 'config.json');
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const write = (content: string) => fs.writeFile(file, content, 'utf8');
const readBack = async () => JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
const listBackups = async () => (await fs.readdir(dir)).filter((f) => f.includes('.broken-'));

describe('zod 4 默认值语义（回归护栏）', () => {
  // zod 4 的 .default({}) 不 parse 默认值，会原样返回裸 {}；必须用 .catch(fn).prefault({})
  it('failover 缺省时被完整填充，而不是留下裸对象', () => {
    const cfg = defaultConfig();
    expect(cfg.failover).toEqual(FailoverSchema.parse({}));
    expect(cfg.failover.attemptTimeoutMs).toBe(60000);
    expect(cfg.failover.budgetMs).toBe(90000);
  });

  it('failover 为垃圾值时整体回退默认，不抛异常', () => {
    const parsed = FailoverSchema.catch(() => FailoverSchema.parse({})).prefault({});
    expect(parsed.parse('垃圾')).toEqual(FailoverSchema.parse({}));
    expect(parsed.parse(undefined)).toEqual(FailoverSchema.parse({}));
  });
});

describe('migrateConfig', () => {
  it('旧版 apiKey 迁入账号池且不重复', () => {
    const r = migrateConfig({ apiKey: 'sk_legacy' });
    expect(r.raw.apiKey).toBeUndefined();
    expect(r.raw.accounts).toEqual([{ name: '默认账号', key: 'sk_legacy', enabled: true }]);
    expect(r.applied.join()).toContain('apiKey');

    // 已有同 key 账号时不重复插入
    const r2 = migrateConfig({ apiKey: 'sk_x', accounts: [{ name: 'A', key: 'sk_x', enabled: true }] });
    expect(r2.raw.accounts).toHaveLength(1);
  });

  it('perModel 单 upstream 转优先级列表，并丢弃退役字段', () => {
    const r = migrateConfig({
      perModel: { 'cline-pass/x': { upstream: 'alibaba', maxRetries: 3, pinMode: 'preferred' } },
    });
    const cfg = (r.raw.perModel as Record<string, Record<string, unknown>>)['cline-pass/x'];
    expect(cfg?.upstreams).toEqual(['alibaba']);
    expect(cfg?.upstream).toBeUndefined();
    expect(cfg?.maxRetries).toBeUndefined();
    expect(cfg?.pinMode).toBe('preferred');
  });

  it('roundrobin → sticky（轮询式切换会让 prompt cache 全失效）', () => {
    const r = migrateConfig({ accountMode: 'roundrobin' });
    expect(r.raw.accountMode).toBe('sticky');
    expect(r.applied.join()).toContain('prompt cache');
  });

  it('版本升级到当前版本', () => {
    expect(migrateConfig({}).raw.version).toBe(CONFIG_VERSION);
  });

  it('版本高于程序支持时抛 ConfigTooNewError', () => {
    expect(() => migrateConfig({ version: CONFIG_VERSION + 1 })).toThrow(ConfigTooNewError);
  });

  it('已是当前版本时不重复迁移', () => {
    const r = migrateConfig({ version: CONFIG_VERSION, accountMode: 'roundrobin' });
    expect(r.applied).toEqual([]);
    expect(r.raw.accountMode).toBe('roundrobin');
  });
});

describe('loadConfig', () => {
  it('文件不存在 → 默认配置 + fresh', async () => {
    const r = await loadConfig(file);
    expect(r.fresh).toBe(true);
    expect(r.config.accounts).toEqual([]);
    expect(r.config.port).toBe(3123);
    expect(await listBackups()).toEqual([]);
  });

  it('空对象 {} → 默认配置，不崩溃（旧版此处会 TypeError）', async () => {
    await write('{}');
    const r = await loadConfig(file);
    expect(r.config.failover.attemptTimeoutMs).toBe(60000);
    expect(r.config.knownModels.length).toBeGreaterThan(0);
    expect(await listBackups()).toEqual([]);
  });

  it('knownModels 缺失 → 恢复默认清单', async () => {
    await write('{"port":4000}');
    const r = await loadConfig(file);
    expect(r.config.knownModels).toContain('cline-pass/glm-5.2');
  });

  it('knownModels 为 null（损坏）→ 恢复默认清单，不崩溃（旧版此处会崩溃）', async () => {
    await write('{"knownModels":null}');
    const r = await loadConfig(file);
    expect(Array.isArray(r.config.knownModels)).toBe(true);
    expect(r.config.knownModels.length).toBeGreaterThan(0);
  });

  it('knownModels 为显式空数组 → 尊重用户清空，不复活', async () => {
    await write('{"knownModels":[]}');
    const r = await loadConfig(file);
    expect(r.config.knownModels).toEqual([]);
  });

  it('文件内容为 "null" 被当作损坏而非全新安装', async () => {
    await write('null');
    const r = await loadConfig(file);
    expect(r.fresh).toBe(false);
    expect(r.backupPath).not.toBeNull();
    expect(await listBackups()).toHaveLength(1);
    // typeof null === 'object'，报错信息不能写成「顶层不是对象（是 object）」
    expect(r.notes.join()).toContain('是 null');
  });

  it('截断的 JSON → 备份原文件 + 默认配置启动', async () => {
    await write('{"accounts":[{"key":"sk_secret_trunc');
    const r = await loadConfig(file);
    expect(r.backupPath).not.toBeNull();
    expect(await listBackups()).toHaveLength(1);
    // 备份里必须保留原始内容，否则密钥就真丢了
    const backedUp = await fs.readFile(r.backupPath as string, 'utf8');
    expect(backedUp).toContain('sk_secret_trunc');
    expect(r.notes.join()).toContain('备份');
  });

  it('顶层是数组 → 当作损坏处理', async () => {
    await write('[1,2,3]');
    const r = await loadConfig(file);
    expect(r.backupPath).not.toBeNull();
    expect(r.config.port).toBe(3123);
  });

  it('无效账号被丢弃，有效账号保留', async () => {
    await write(
      JSON.stringify({
        accounts: [
          { name: '好的', key: 'sk_good', enabled: true },
          { name: '缺 key' },
          'string 不是对象',
          { name: '另一个好的', key: 'sk_good2', enabled: false },
        ],
      }),
    );
    const r = await loadConfig(file);
    expect(r.config.accounts.map((a) => a.key)).toEqual(['sk_good', 'sk_good2']);
    expect(r.notes.join()).toContain('丢弃了 2 个无效账号');
  });

  it('activeAccount 越界被钳制', async () => {
    await write(JSON.stringify({ accounts: [{ name: 'A', key: 'sk_a' }], activeAccount: 9 }));
    const r = await loadConfig(file);
    expect(r.config.activeAccount).toBe(0);
    expect(r.notes.join()).toContain('越界');
  });

  it('perModel 中 exclude 优先于 upstreams', async () => {
    await write(
      JSON.stringify({
        perModel: { 'cline-pass/x': { upstreams: ['a', 'b'], exclude: ['b'], pinMode: 'strict' } },
      }),
    );
    const r = await loadConfig(file);
    expect(r.config.perModel['cline-pass/x']?.upstreams).toEqual(['a']);
    expect(r.config.perModel['cline-pass/x']?.exclude).toEqual(['b']);
  });

  it('未知顶层字段被记录但不影响加载', async () => {
    await write(JSON.stringify({ port: 4000, maxRetries: 3, 拼写错误的字段: true }));
    const r = await loadConfig(file);
    expect(r.config.port).toBe(4000);
    expect(r.notes.join()).toContain('未知配置字段');
  });

  it('端到端：旧版完整配置能平滑升级', async () => {
    await write(
      JSON.stringify({
        port: 3123,
        apiKey: 'sk_v1_key',
        proxyKey: 'downstream-key',
        publicBaseUrl: 'https://pass.example.com',
        exposeCatalog: false,
        upstreamBase: 'https://api.cline.bot/api/v1',
        accounts: [],
        accountMode: 'roundrobin',
        activeAccount: 0,
        knownModels: ['cline-pass/glm-5.2'],
        perModel: { 'cline-pass/glm-5.2': { upstream: 'alibaba', maxRetries: 0, pinMode: 'strict', sort: 'cost' } },
      }),
    );
    const r = await loadConfig(file);
    expect(r.config.version).toBe(CONFIG_VERSION);
    expect(r.config.accounts).toEqual([{ name: '默认账号', key: 'sk_v1_key', enabled: true }]);
    expect(r.config.accountMode).toBe('sticky');
    expect(r.config.proxyKey).toBe('downstream-key');
    expect(r.config.publicBaseUrl).toBe('https://pass.example.com');
    expect(r.config.perModel['cline-pass/glm-5.2']).toEqual({
      upstreams: ['alibaba'],
      exclude: [],
      pinMode: 'strict',
      sort: 'cost',
    });
    expect(r.config.failover.budgetMs).toBe(90000);
    expect(r.backupPath).toBeNull();
  });
});

describe('writeConfig', () => {
  it('写出的配置能被原样读回', async () => {
    const cfg = defaultConfig();
    cfg.accounts = [{ name: 'A', key: 'sk_a', enabled: true }];
    await writeConfig(file, cfg);
    const r = await loadConfig(file);
    expect(r.config.accounts).toEqual(cfg.accounts);
    expect(r.notes).toEqual([]);
    expect(await readBack()).toMatchObject({ version: CONFIG_VERSION });
  });
});

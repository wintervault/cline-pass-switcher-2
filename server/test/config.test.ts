import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig, persistConfigMigration, writeConfig } from '../src/config/load.ts';
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
    expect(cfg.gateways[0]?.failover).toEqual(FailoverSchema.parse({}));
    expect(cfg.gateways[0]?.failover.attemptTimeoutMs).toBe(60000);
    expect(cfg.gateways[0]?.failover.budgetMs).toBe(90000);
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
    // 3.0 起 perModel 是网关级的：v2 的顶层 perModel 会被搬进「主网关」
    const gateway = (r.raw.gateways as Array<Record<string, unknown>>)[0];
    if (!gateway) throw new Error('缺少主网关');
    const cfg = (gateway.perModel as Record<string, Record<string, unknown>>)['cline-pass/x'];
    expect(cfg?.upstreams).toEqual(['alibaba']);
    expect(cfg?.upstream).toBeUndefined();
    expect(cfg?.maxRetries).toBeUndefined();
    expect(cfg?.pinMode).toBe('preferred');
  });

  it('roundrobin → sticky（轮询式切换会让 prompt cache 全失效）', () => {
    const r = migrateConfig({ accountMode: 'roundrobin' });
    const gateway = (r.raw.gateways as Array<Record<string, unknown>>)[0];
    expect(gateway?.accountMode).toBe('sticky');
    expect(r.applied.join()).toContain('prompt cache');
  });

  it('版本升级到当前版本', () => {
    expect(migrateConfig({}).raw.version).toBe(CONFIG_VERSION);
  });

  it('v2 → v3：旧顶层接入设置整体迁入 main 网关，账号池保持全局', () => {
    const r = migrateConfig({
      version: 2,
      port: 4000,
      bindHost: '0.0.0.0',
      proxyKey: 'sk_down',
      corsOrigins: ['https://a.example.com'],
      exposeCatalog: true,
      accountMode: 'single',
      activeAccount: 1,
      accounts: [
        { name: 'A', key: 'sk_a' },
        { name: 'B', key: 'sk_b' },
      ],
      knownModels: ['cline-pass/x'],
      perModel: { 'cline-pass/x': { upstreams: ['deepseek'] } },
      failover: { budgetMs: 120000 },
    });
    expect(r.raw.version).toBe(3);
    const gateway = (r.raw.gateways as Array<Record<string, unknown>>)[0];
    expect(gateway?.id).toBe('main');
    expect(gateway?.port).toBe(4000);
    expect(gateway?.bindHost).toBe('0.0.0.0');
    expect(gateway?.proxyKey).toBe('sk_down');
    expect(gateway?.exposeCatalog).toBe(true);
    expect(gateway?.accountMode).toBe('single');
    // 旧的 activeAccount 是下标，迁移后要变成账号名
    expect(gateway?.activeAccount).toBe('B');
    // v2 的账号池本来就是全量的 → allAccounts=true
    expect(gateway?.allAccounts).toBe(true);
    expect(gateway?.accounts).toEqual([]);
    expect(gateway?.knownModels).toEqual(['cline-pass/x']);
    expect(r.raw.console).toEqual({ gatewayId: 'main' });
    for (const key of [
      'port',
      'bindHost',
      'proxyKey',
      'corsOrigins',
      'exposeCatalog',
      'accountMode',
      'activeAccount',
      'knownModels',
      'perModel',
      'failover',
    ]) {
      expect(r.raw[key]).toBeUndefined();
    }
  });

  it('v3 配置原样保留（不重复迁移）', () => {
    const r = migrateConfig({ version: 3, gateways: [{ id: 'main', port: 3000 }], console: { gatewayId: 'main' } });
    expect(r.applied).toEqual([]);
    expect((r.raw.gateways as Array<Record<string, unknown>>)[0]?.port).toBe(3000);
  });

  it('版本高于程序支持时抛 ConfigTooNewError', () => {
    expect(() => migrateConfig({ version: CONFIG_VERSION + 1 })).toThrow(ConfigTooNewError);
  });

  it('已是当前版本时不重复迁移', () => {
    const r = migrateConfig({ version: CONFIG_VERSION, gateways: [{ id: 'main', port: 3123 }] });
    expect(r.applied).toEqual([]);
    expect((r.raw.gateways as Array<Record<string, unknown>>)[0]?.port).toBe(3123);
  });
});

describe('loadConfig', () => {
  it('文件不存在 → 默认配置 + fresh', async () => {
    const r = await loadConfig(file);
    expect(r.fresh).toBe(true);
    expect(r.config.accounts).toEqual([]);
    expect(r.config.gateways[0]?.port).toBe(3123);
    expect(r.config.console.gatewayId).toBe('main');
    expect(await listBackups()).toEqual([]);
  });

  it('空对象 {} → 默认配置，不崩溃（旧版此处会 TypeError）', async () => {
    await write('{}');
    const r = await loadConfig(file);
    expect(r.config.gateways[0]?.failover.attemptTimeoutMs).toBe(60000);
    expect(r.config.gateways[0]?.knownModels.length).toBeGreaterThan(0);
    expect(await listBackups()).toEqual([]);
  });

  it('knownModels 缺失 → 恢复默认清单', async () => {
    await write('{"port":4000}');
    const r = await loadConfig(file);
    expect(r.config.gateways[0]?.knownModels).toContain('cline-pass/glm-5.2');
    // v2 的顶层 port 也会迁进主网关
    expect(r.config.gateways[0]?.port).toBe(4000);
  });

  it('knownModels 为 null（损坏）→ 恢复默认清单，不崩溃（旧版此处会崩溃）', async () => {
    await write('{"knownModels":null}');
    const r = await loadConfig(file);
    expect(Array.isArray(r.config.gateways[0]?.knownModels)).toBe(true);
    expect(r.config.gateways[0]?.knownModels.length).toBeGreaterThan(0);
  });

  it('knownModels 为显式空数组 → 尊重用户清空，不复活', async () => {
    await write('{"knownModels":[]}');
    const r = await loadConfig(file);
    expect(r.config.gateways[0]?.knownModels).toEqual([]);
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
    expect(r.config.gateways[0]?.port).toBe(3123);
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

  it('v2 的 activeAccount 下标在迁移时翻译成账号名；指向不存在的账号则清空', async () => {
    await write(JSON.stringify({ accounts: [{ name: 'A', key: 'sk_a' }], activeAccount: 0 }));
    const r = await loadConfig(file);
    expect(r.config.gateways[0]?.activeAccount).toBe('A');

    await write(JSON.stringify({ accounts: [{ name: 'A', key: 'sk_a' }], activeAccount: 9 }));
    const r2 = await loadConfig(file);
    expect(r2.config.gateways[0]?.activeAccount).toBe('');
  });

  it('版本迁移会被标记，写回后文件是 v3 且原文件有备份', async () => {
    const v2 = {
      version: 2,
      port: 3123,
      proxyKey: 'sk_downstream',
      accounts: [{ name: 'A', key: 'sk_a' }],
      knownModels: ['cline-pass/x'],
    };
    await write(JSON.stringify(v2));
    const r = await loadConfig(file);
    expect(r.migrationFrom).toBe(2);

    const backupPath = await persistConfigMigration(file, r.config, r.migrationFrom ?? 0);
    const written = await readBack();
    expect(written['version']).toBe(3);
    expect((written['gateways'] as Array<Record<string, unknown>>)[0]?.['id']).toBe('main');
    expect(written['port']).toBeUndefined();
    expect(backupPath).not.toBeNull();
    if (backupPath) {
      const original = JSON.parse(await fs.readFile(backupPath, 'utf8')) as Record<string, unknown>;
      expect(original['version']).toBe(2);
    }

    // 已是 v3：再加载不会再次迁移
    const again = await loadConfig(file);
    expect(again.migrationFrom).toBeNull();
  });

  it('字段级修正（未涉及版本）不会被标记为迁移', async () => {
    await write(JSON.stringify({ version: 3, accounts: [{ name: 'A', key: '' }] }));
    const r = await loadConfig(file);
    expect(r.migrationFrom).toBeNull();
  });

  it('perModel 中 exclude 优先于 upstreams', async () => {
    await write(
      JSON.stringify({
        perModel: { 'cline-pass/x': { upstreams: ['a', 'b'], exclude: ['b'], pinMode: 'strict' } },
      }),
    );
    const r = await loadConfig(file);
    expect(r.config.gateways[0]?.perModel['cline-pass/x']?.upstreams).toEqual(['a']);
    expect(r.config.gateways[0]?.perModel['cline-pass/x']?.exclude).toEqual(['b']);
  });

  it('未知顶层字段被记录但不影响加载', async () => {
    await write(JSON.stringify({ version: 3, maxRetries: 3, 拼写错误的字段: true }));
    const r = await loadConfig(file);
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
    const gateway = r.config.gateways[0];
    expect(gateway?.accountMode).toBe('sticky');
    expect(gateway?.proxyKey).toBe('downstream-key');
    expect(gateway?.publicBaseUrl).toBe('https://pass.example.com');
    expect(gateway?.accounts).toEqual([]); // 空 = 全部账号
    expect(gateway?.perModel['cline-pass/glm-5.2']).toEqual({
      upstreams: ['alibaba'],
      exclude: [],
      pinMode: 'strict',
      sort: 'cost',
    });
    expect(gateway?.failover.budgetMs).toBe(90000);
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

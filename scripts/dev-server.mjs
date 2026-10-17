#!/usr/bin/env node
/**
 * 开发/自测用的**隔离实例**：绝不碰正在运行的那一个。
 *
 * 用户明确要求（2026-10-17）：日常使用的实例要稳定运行，开发与自测另起炉灶，
 * 端口也不能冲突。所以这个脚本：
 *
 * - 端口默认 3133，并**明确拒绝** 3123（线上实例）与 3122（桌面壳的控制通道）；
 * - 数据目录默认 `%TEMP%/cps-dev`，可用 `--data` 指定——线上数据一个字节都不写；
 * - 需要真实账号/配置时用 `--from <线上 data 目录>` 播种：只复制 config.json 与
 *   metadata.json，不复制日志（日志是线上实例正在写的文件，不碰）。
 *
 * 用法：
 *   npm run dev:isolated
 *   node scripts/dev-server.mjs --port 3134 --data D:\tmp\cps-dev2
 *   node scripts/dev-server.mjs --from "C:\Library\tempTools\cline-pass-switcher-2.9.11-portable\data"
 */
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

/** 线上实例与服务控制通道的端口，隔离实例一概不许用。 */
const FORBIDDEN_PORTS = new Set([3123, 3122]);

const port = Number(flag('--port', '3133'));
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`[dev] 端口不合法：${flag('--port', '3133')}`);
  process.exit(1);
}
if (FORBIDDEN_PORTS.has(port)) {
  console.error(`[dev] 端口 ${port} 是线上实例/控制通道，拒绝使用（换一个，如 3133）`);
  process.exit(1);
}

const dataDir = resolve(flag('--data', join(tmpdir(), 'cps-dev')));
const seedFrom = flag('--from', null);

const entry = join(root, 'server', 'dist', 'index.js');
if (!existsSync(entry)) {
  console.error('[dev] 找不到 server/dist/index.js——先跑 npm run build');
  process.exit(1);
}

if (seedFrom) {
  const from = resolve(seedFrom);
  if (from === dataDir) {
    console.error('[dev] --from 与 --data 不能是同一个目录');
    process.exit(1);
  }
  mkdirSync(dataDir, { recursive: true });
  for (const file of ['config.json', 'metadata.json']) {
    const src = join(from, file);
    if (existsSync(src)) {
      cpSync(src, join(dataDir, file));
      console.log(`[dev] 已从线上数据目录复制 ${file}`);
    }
  }
}
mkdirSync(dataDir, { recursive: true });

console.log(`[dev] 隔离实例：http://127.0.0.1:${port}/`);
console.log(`[dev] 数据目录：${dataDir}（与线上互不影响）`);

const child = spawn(process.execPath, [entry], {
  stdio: 'inherit',
  env: { ...process.env, DATA_DIR: dataDir, PORT: String(port), BIND_HOST: '127.0.0.1' },
});
const stop = () => child.kill();
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
child.on('exit', (code) => process.exit(code ?? 0));

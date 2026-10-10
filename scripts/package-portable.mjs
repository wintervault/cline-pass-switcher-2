/**
 * 组装便携版 zip：exe + runtime/ + data/（空目录，VS Code Portable Mode 同款检测标记）。
 *
 * 便携模式：exe 旁存在 data 目录 → 数据（配置/密钥/日志）就地保存，删除目录即彻底清除。
 * 前置：npm run build + scripts/prepare-runtime.mjs 已跑（本脚本校验并按需提示）。
 * 运行：node scripts/package-portable.mjs
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exeSrc = path.join(root, 'desktop/target/release/cline-pass-switcher.exe');
const runtimeSrc = path.join(root, 'desktop/runtime');
const stage = path.join(root, 'desktop/target/portable/stage');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const zipOut = path.join(root, 'desktop/target/portable', `cline-pass-switcher-${pkg.version}-portable.zip`);

if (!fs.existsSync(exeSrc)) {
  console.error('缺少 desktop/target/release/cline-pass-switcher.exe —— 先跑 npm run desktop:build');
  process.exit(1);
}
if (!fs.existsSync(path.join(runtimeSrc, 'server/dist/index.js'))) {
  console.error('缺少运行时 —— 先跑 node scripts/prepare-runtime.mjs');
  process.exit(1);
}

fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(path.join(stage, 'data'), { recursive: true });
fs.copyFileSync(exeSrc, path.join(stage, 'cline-pass-switcher.exe'));
fs.cpSync(runtimeSrc, path.join(stage, 'runtime'), { recursive: true });
// data/README.txt：①让空目录在 zip 里存活 ②把便携模式的语义写在数据旁边
fs.writeFileSync(
  path.join(stage, 'data', 'README.txt'),
  [
    '此目录存在 = 便携模式：配置与日志全部保存在本目录（随目录删除而清除）。',
    '删除本目录即重置为首次启动状态。安全提示：config.json 含上游密钥，',
    '便携介质（U 盘等）丢失 = 密钥泄露，请自行权衡。',
  ].join('\n'),
);

fs.rmSync(zipOut, { force: true });
execSync(
  `powershell -NoProfile -Command "Compress-Archive -Path '${stage.replace(/'/g, "''")}\\*' -DestinationPath '${zipOut.replace(/'/g, "''")}' -Force"`,
  { stdio: 'inherit' },
);
console.log(`便携版已打包：${zipOut}`);

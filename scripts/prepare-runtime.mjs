/**
 * 准备桌面壳要打包的服务端运行时：
 *   desktop/runtime/
 *     package.json          { type: "module" }（ESM 判定）
 *     node_modules/         仅 pino + zod 及其传递依赖（--omit=dev）
 *     server/dist/          编译产物
 *     server/package.json   { type: "module" }
 *
 * Node 的模块解析会从 server/dist/index.js 逐级向上找 node_modules，
 * 因此 runtime/node_modules 必须位于 runtime 根（与 resources 打包层级一致）。
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimeDir = path.join(root, 'desktop', 'runtime');
const serverPkg = JSON.parse(fs.readFileSync(path.join(root, 'server/package.json'), 'utf8'));

fs.rmSync(runtimeDir, { recursive: true, force: true });
fs.mkdirSync(path.join(runtimeDir, 'server'), { recursive: true });

// 1) 编译产物（服务端 + 前端：服务端静态托管 WEB_DIST = runtime/web/dist，缺了就是
//    「front-end assets not found」白屏 JSON——桌面壳首发的真实缺陷）
fs.cpSync(path.join(root, 'server/dist'), path.join(runtimeDir, 'server/dist'), { recursive: true });
fs.cpSync(path.join(root, 'web/dist'), path.join(runtimeDir, 'web/dist'), { recursive: true });

// 2) 模块类型标记 + 版本号（服务端 PACKAGE_VERSION 读 REPO_ROOT/package.json，
//    运行时布局下即 runtime/package.json——这里必须带上 version，否则 /healthz 显示 0.0.0）
const rootPkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
fs.writeFileSync(
  path.join(runtimeDir, 'package.json'),
  JSON.stringify(
    { name: 'cline-pass-runtime', private: true, type: 'module', version: rootPkg.version },
    null,
    2,
  ),
);
fs.writeFileSync(
  path.join(runtimeDir, 'server/package.json'),
  JSON.stringify({ name: 'cline-pass-server-runtime', private: true, type: 'module' }, null, 2),
);

// 3) 干净的生产依赖（只装 server 的 dependencies，杜绝把仓库根的开发依赖打进安装包）
fs.writeFileSync(
  path.join(runtimeDir, 'server/package.json'),
  JSON.stringify(
    { name: 'cline-pass-server-runtime', private: true, type: 'module', dependencies: serverPkg.dependencies },
    null,
    2,
  ),
);
execSync('npm install --omit=dev --no-audit --no-fund --loglevel=error', {
  cwd: path.join(runtimeDir, 'server'),
  stdio: 'inherit',
});
// 依赖装在 runtime/server/node_modules，同样满足向上解析；保持现状即可

const size = (dir) => {
  let total = 0;
  for (const f of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (f.isFile()) total += fs.statSync(path.join(f.parentPath ?? dir, f.name)).size;
  }
  return total;
};
console.log(`运行时准备完成：${runtimeDir}（约 ${Math.round(size(runtimeDir) / 1024 / 1024)} MB）`);

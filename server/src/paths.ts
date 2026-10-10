import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 本文件所在目录：源码运行时是 `server/src`，编译后运行时是 `server/dist`。 */
const here = path.dirname(fileURLToPath(import.meta.url));

/** `server/` 包根目录。两种运行方式下都是上一级。 */
export const PACKAGE_ROOT = path.resolve(here, '..');
/** 仓库根目录。 */
export const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..');

/** 运行数据目录。Docker 里由 DATA_DIR 指向挂载卷。 */
export const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : REPO_ROOT;

export const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
export const META_PATH = path.join(DATA_DIR, 'metadata.json');

/** 前端构建产物（阶段 6 之后由后端静态托管）。 */
export const WEB_DIST = path.join(REPO_ROOT, 'web', 'dist');

/**
 * 程序版本号：读仓库根 package.json（单一来源，避免与代码里的常量漂移）。
 * 开发（server/src）与容器（/app/server/dist）两种布局下 REPO_ROOT 都成立。
 */
export const PACKAGE_VERSION: string = (() => {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

import fs from 'node:fs';
import path from 'node:path';

import { WEB_DIST } from '../../paths.ts';
import { sendError } from '../respond.ts';
import type { Ctx, Handler } from '../router.ts';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
  '.woff2': 'font/woff2',
};

function resolveWithin(root: string, pathname: string): string | null {
  const target = path.normalize(path.join(root, pathname));
  // 防目录穿越：解析结果必须仍在根目录内
  if (!target.startsWith(root + path.sep) && target !== root) return null;
  return target;
}

/**
 * 静态资源：托管 web/dist（React 构建产物）。
 * SPA 路由（非 /api、非 /v1 的未知路径）回落到 index.html。
 */
export function staticHandler(): Handler {
  return (c: Ctx) => {
    if (c.method !== 'GET') {
      sendError(c.res, 405, 'method not allowed');
      return;
    }

    if (!fs.existsSync(path.join(WEB_DIST, 'index.html'))) {
      sendError(c.res, 404, 'front-end assets not found (run `npm run build --workspace=web`)');
      return;
    }

    const pathname = c.path === '/' ? '/index.html' : c.path;
    const file = resolveWithin(WEB_DIST, pathname);

    if (file && fs.existsSync(file) && fs.statSync(file).isFile()) {
      respondFile(c, file);
      return;
    }

    // SPA fallback：仅对看起来像前端路由的路径回 index.html
    if (!pathname.startsWith('/api/') && !pathname.startsWith('/v1/')) {
      respondFile(c, path.join(WEB_DIST, 'index.html'));
      return;
    }
    sendError(c.res, 404, `no route: ${c.method} ${c.path}`, 'not_found');
  };
}

function respondFile(c: Ctx, file: string): void {
  try {
    const data = fs.readFileSync(file);
    const type = CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
    // 构建产物带内容指纹，可以长缓存；index.html 不缓存保证发版即生效
    const cacheable = /-[A-Za-z0-9_-]{8,}\.(js|css|woff2)$/.test(file);
    c.res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': data.length,
      'Cache-Control': cacheable ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    c.res.end(data);
  } catch {
    sendError(c.res, 500, 'failed to read static file', 'server_error');
  }
}

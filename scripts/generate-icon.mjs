/**
 * 生成应用图标：desktop/icons/{icon.ico,icon.png}。
 *
 * 设计源是本目录的 icon.svg（与 web/src/logo.tsx 同源）：
 * 圆角方块 + 蓝靛对角渐变 + 左上高光，白色「路由分叉」符号——
 * 一条主干通向钉住目标（青色高亮端点 + 光环），上下为暗一档的候选渠道。
 * 用 @resvg/resvg-js（devDependency）从矢量逐尺寸渲染，比位图缩小更锐利。
 *
 * 运行：node scripts/generate-icon.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

import { Resvg } from '@resvg/resvg-js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'desktop/icons');
const SIZES = [256, 64, 48, 32, 24, 16];

const svg = fs.readFileSync(path.join(ROOT, 'desktop/icons/icon.svg'), 'utf8');

/** SVG → 指定尺寸的 RGBA 像素。 */
function render(size) {
  return new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().pixels;
}

// ---------- PNG 编码（256 主尺寸与 icon.png） ----------
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

function encodePng(pixels, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const stride = size * 4;
  const filtered = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    filtered[y * (stride + 1)] = 0; // filter: none
    pixels.copy(filtered, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(filtered, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- ICO 容器（256 用 PNG，小尺寸用 BMP——兼容性最稳的组合） ----------
function bmpEntry(pixels, size) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8); // XOR+AND 高度
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  const maskStride = Math.ceil(size / 32) * 4;
  const buf = Buffer.alloc(40 + size * size * 4 + maskStride * size);
  header.copy(buf, 0);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const src = ((size - 1 - y) * size + x) * 4; // 自下而上
      const dst = 40 + (y * size + x) * 4;
      buf[dst] = pixels[src + 2]; // B
      buf[dst + 1] = pixels[src + 1]; // G
      buf[dst + 2] = pixels[src]; // R
      buf[dst + 3] = pixels[src + 3]; // A
    }
  }
  return buf;
}

function buildIco(pixelsBySize) {
  const entries = SIZES.map((size) => ({
    size,
    data: size === 256 ? encodePng(pixelsBySize[256], 256) : bmpEntry(pixelsBySize[size], size),
  }));
  const count = entries.length;
  const dir = Buffer.alloc(6);
  dir.writeUInt16LE(0, 0);
  dir.writeUInt16LE(1, 2); // type: icon
  dir.writeUInt16LE(count, 4);
  const blobs = [];
  const dirEntries = [];
  let cur = 6 + 16 * count;
  for (const e of entries) {
    const d = Buffer.alloc(16);
    d[0] = e.size === 256 ? 0 : e.size;
    d[1] = e.size === 256 ? 0 : e.size;
    d.writeUInt16LE(1, 4); // planes
    d.writeUInt16LE(32, 6); // bitcount
    d.writeUInt32LE(e.data.length, 8);
    d.writeUInt32LE(cur, 12);
    dirEntries.push(d);
    blobs.push(e.data);
    cur += e.data.length;
  }
  return Buffer.concat([dir, ...dirEntries, ...blobs]);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const pixelsBySize = Object.fromEntries(SIZES.map((s) => [s, Buffer.from(render(s))]));
fs.writeFileSync(path.join(OUT_DIR, 'icon.ico'), buildIco(pixelsBySize));
fs.writeFileSync(path.join(OUT_DIR, 'icon.png'), encodePng(pixelsBySize[256], 256));
console.log(`图标已生成：${OUT_DIR}{icon.ico,icon.png}`);

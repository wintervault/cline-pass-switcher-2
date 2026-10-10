/**
 * 生成应用图标：desktop/icons/icon.ico（多尺寸）+ icon.png（256）。
 *
 * 设计：圆角方块 + 蓝→深蓝垂直渐变底 + 白色「路由切换」符号
 * （一条分叉路径：左侧一个源节点，向右上/右下分出两条支路各带一个节点），
 * 呼应本项目「多上游路由切换」的定位。
 *
 * 纯 Node 实现（node:zlib + 手写 PNG/ICO 容器），2x 超采样抗锯齿，无任何依赖。
 * 运行：node scripts/generate-icon.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const OUT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../desktop/icons');
const SIZE = 256; // 主尺寸（超采样前的逻辑尺寸）
const SS = 2; // 超采样倍数

// ---------- 几何 ----------

/** 圆角方块覆盖判断（坐标已归一到 [0,1]，r 为圆角半径） */
function inRoundedRect(x, y, r) {
  const m = 0.03; // 外边距
  const lo = m,
    hi = 1 - m;
  if (x < lo || x > hi || y < lo || y > hi) return false;
  const cx = Math.max(lo + r, Math.min(x, hi - r));
  const cy = Math.max(lo + r, Math.min(y, hi - r));
  const dx = x - cx,
    dy = y - cy;
  return dx * dx + dy * dy <= r * r || (x >= lo + r && x <= hi - r) || (y >= lo + r && y <= hi - r);
}

const dist = (x1, y1, x2, y2) => Math.hypot(x1 - x2, y1 - y2);

/** 点到线段距离 */
function distToSeg(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1,
    dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len2));
  return dist(px, py, x1 + t * dx, y1 + t * dy);
}

/**
 * 白色符号覆盖判断：路由分叉。
 * 源节点 (0.30, 0.50) → 分叉点 (0.52, 0.50) → 上支 (0.74, 0.32) / 下支 (0.74, 0.68)
 */
function inGlyph(x, y) {
  const sx = 0.3,
    sy = 0.5,
    fx = 0.52,
    fy = 0.5;
  const ux = 0.74,
    uy = 0.32,
    dx2 = 0.74,
    dy2 = 0.68;
  const lw = 0.045; // 线宽半径
  if (distToSeg(x, y, sx, sy, fx, fy) <= lw) return true;
  if (distToSeg(x, y, fx, fy, ux, uy) <= lw) return true;
  if (distToSeg(x, y, fx, fy, dx2, dy2) <= lw) return true;
  // 节点：源实心大，分支实心中
  if (dist(x, y, sx, sy) <= 0.085) return true;
  if (dist(x, y, ux, uy) <= 0.062) return true;
  if (dist(x, y, dx2, dy2) <= 0.062) return true;
  return false;
}

function gradient(y) {
  // #5B9BFF → #2E63D9
  const top = [0x5b, 0x9b, 0xff],
    bottom = [0x2e, 0x63, 0xd9];
  const t = Math.max(0, Math.min(1, y));
  return [0, 1, 2].map((i) => Math.round(top[i] + (bottom[i] - top[i]) * t));
}

// ---------- 绘制（超采样） ----------
const N = SIZE * SS;
const raw = Buffer.alloc(SIZE * SIZE * 4);

for (let py = 0; py < SIZE; py++) {
  for (let px = 0; px < SIZE; px++) {
    let r = 0,
      g = 0,
      b = 0,
      a = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const x = (px * SS + sx + 0.5) / N;
        const y = (py * SS + sy + 0.5) / N;
        if (!inRoundedRect(x, y, 0.16)) continue;
        const [br, bg, bb] = gradient(y);
        if (inGlyph(x, y)) {
          r += 255;
          g += 255;
          b += 255;
        } else {
          r += br;
          g += bg;
          b += bb;
        }
        a += 255;
      }
    }
    const n = SS * SS;
    const off = (py * SIZE + px) * 4;
    raw[off] = Math.round(r / n);
    raw[off + 1] = Math.round(g / n);
    raw[off + 2] = Math.round(b / n);
    raw[off + 3] = Math.round(a / n);
  }
}

// ---------- PNG 编码 ----------
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

// ---------- 尺寸缩放（面积平均） ----------
function downscale(pixels, from, to) {
  const out = Buffer.alloc(to * to * 4);
  const scale = from / to;
  for (let y = 0; y < to; y++) {
    for (let x = 0; x < to; x++) {
      let r = 0,
        g = 0,
        b = 0,
        a = 0,
        n = 0;
      const x0 = Math.floor(x * scale),
        x1 = Math.min(from, Math.ceil((x + 1) * scale));
      const y0 = Math.floor(y * scale),
        y1 = Math.min(from, Math.ceil((y + 1) * scale));
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const off = (yy * from + xx) * 4;
          r += pixels[off];
          g += pixels[off + 1];
          b += pixels[off + 2];
          a += pixels[off + 3];
          n++;
        }
      }
      const off = (y * to + x) * 4;
      out[off] = Math.round(r / n);
      out[off + 1] = Math.round(g / n);
      out[off + 2] = Math.round(b / n);
      out[off + 3] = Math.round(a / n);
    }
  }
  return out;
}

// ---------- ICO 容器（256 用 PNG，小尺寸用 BMP——兼容性最稳的组合） ----------
function bmpEntry(pixels, size) {
  // BITMAPINFOHEADER(40) + BGRA 像素（自下而上）+ AND mask（全 0 = 不透明位由 alpha 决定）
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8); // XOR+AND 的高度
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  const maskStride = Math.ceil(size / 32) * 4;
  const pixelsSize = size * size * 4;
  const maskSize = maskStride * size;
  const buf = Buffer.alloc(40 + pixelsSize + maskSize);
  header.copy(buf, 0);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const src = ((size - 1 - y) * size + x) * 4; // 自下而上
      const dst = 40 + (y * size + x) * 4;
      buf[dst] = pixels[src + 2];
      buf[dst + 1] = pixels[src + 1];
      buf[dst + 2] = pixels[src];
      buf[dst + 3] = pixels[src + 3];
    }
  }
  return buf;
}

function buildIco(pixels256) {
  const sizes = [256, 64, 48, 32, 24, 16];
  const entries = sizes.map((size) => {
    const pixels = size === 256 ? pixels256 : downscale(pixels256, 256, size);
    return { size, data: size === 256 ? encodePng(pixels, size) : bmpEntry(pixels, size) };
  });
  const count = entries.length;
  const dir = Buffer.alloc(6);
  dir.writeUInt16LE(0, 0);
  dir.writeUInt16LE(1, 2); // type: icon
  dir.writeUInt16LE(count, 4);
  const offset = 6 + 16 * count;
  const dirEntries = [];
  const blobs = [];
  let cur = offset;
  for (const e of entries) {
    const d = Buffer.alloc(16);
    d[0] = e.size === 256 ? 0 : e.size; // 256 → 0
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
fs.writeFileSync(path.join(OUT_DIR, 'icon.ico'), buildIco(raw));
fs.writeFileSync(path.join(OUT_DIR, 'icon.png'), encodePng(raw, SIZE));
console.log(`图标已生成：${OUT_DIR}{icon.ico,icon.png}`);

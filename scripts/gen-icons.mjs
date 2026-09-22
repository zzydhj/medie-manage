// 把 public/favicon.svg 的设计栅格化成 PNG / ICO。
// 零依赖:只用 Node 内置 zlib 手写 PNG 编码(项目没有 sharp 之类的图像库)。
//
// 用法:node scripts/gen-icons.mjs
// 产出:public/apple-touch-icon.png(180,iOS 加到主屏)、public/favicon.ico(16/32/48,旧浏览器兜底)
//
// ⚠️ 几何与配色必须和 public/favicon.svg 保持一致,改设计请两处同步。

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PUB = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const S = 64; // 设计坐标系边长(viewBox 0 0 64 64)
const SS = 8; // 超采样倍率:每输出像素取 8x8 子样本做抗锯齿

// ---------------- 设计描述(对应 SVG) ----------------
const hex = (h) => [
  parseInt(h.slice(1, 3), 16),
  parseInt(h.slice(3, 5), 16),
  parseInt(h.slice(5, 7), 16),
];
const C_BLUE = hex('#2563eb'); // 渐变起点 / 山
const C_SKY = hex('#60a5fa'); // 渐变终点 / 太阳
const C_WHITE = hex('#ffffff');

const BG = { x: 0, y: 0, w: 64, h: 64, r: 14 }; // 品牌底
const BACK = { x: 12.5, y: 12.5, w: 32, h: 32, r: 6 }; // 后层卡片(白 45%)
const FRONT = { x: 19.5, y: 19.5, w: 32, h: 32, r: 6 }; // 前层卡片(白)
const SUN = { cx: 29, cy: 29, r: 3.5 };
const MOUNTAIN = [
  [19.5, 51.5],
  [30, 38],
  [37, 44.5],
  [44, 36],
  [51.5, 51.5],
];
const BACK_ALPHA = 0.45;

// ---------------- 几何判定 ----------------
/** 圆角矩形有向距离:负=内部 */
function sdRoundRect(px, py, b) {
  const dx = Math.abs(px - (b.x + b.w / 2)) - (b.w / 2 - b.r);
  const dy = Math.abs(py - (b.y + b.h / 2)) - (b.h / 2 - b.r);
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  const inside = Math.min(Math.max(dx, dy), 0);
  return outside + inside - b.r;
}

/** 射线法判定点是否在多边形内 */
function inPolygon(px, py, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

const lerp = (a, b, t) => a + (b - a) * t;

/**
 * 取设计坐标 (x,y) 处的颜色,返回 [r,g,b,a];a=0 表示完全透明(圆角外)。
 * 画家算法:底 -> 后卡 -> 前卡 -> 太阳 -> 山。
 */
function colorAt(x, y) {
  if (sdRoundRect(x, y, BG) >= 0) return [0, 0, 0, 0];

  // 对角线性渐变(等价于 SVG x1=0,y1=0,x2=1,y2=1)
  const t = Math.max(0, Math.min(1, (x + y) / (2 * S)));
  let r = lerp(C_BLUE[0], C_SKY[0], t);
  let g = lerp(C_BLUE[1], C_SKY[1], t);
  let b = lerp(C_BLUE[2], C_SKY[2], t);

  // 后层卡片:白 45% 叠加
  if (sdRoundRect(x, y, BACK) < 0) {
    r = lerp(r, C_WHITE[0], BACK_ALPHA);
    g = lerp(g, C_WHITE[1], BACK_ALPHA);
    b = lerp(b, C_WHITE[2], BACK_ALPHA);
  }

  // 前层卡片及其内部图案(太阳/山被卡片圆角裁切)
  if (sdRoundRect(x, y, FRONT) < 0) {
    r = C_WHITE[0];
    g = C_WHITE[1];
    b = C_WHITE[2];
    const dSun = Math.hypot(x - SUN.cx, y - SUN.cy) - SUN.r;
    if (dSun < 0) {
      [r, g, b] = C_SKY;
    } else if (inPolygon(x, y, MOUNTAIN)) {
      [r, g, b] = C_BLUE;
    }
  }
  return [r, g, b, 1];
}

// ---------------- PNG 编码 ----------------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** 渲染并编码一张 size x size 的 RGBA PNG */
function renderPNG(size) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  const scale = S / size;
  let o = 0;
  for (let py = 0; py < size; py++) {
    raw[o++] = 0; // 每行首字节:滤波器 0(None)
    for (let px = 0; px < size; px++) {
      // 子样本按 alpha 预乘累加,再反预乘,保证半透明边缘不出现黑边
      let pr = 0;
      let pg = 0;
      let pb = 0;
      let pa = 0;
      for (let sy = 0; sy < SS; sy++) {
        const y = (py + (sy + 0.5) / SS) * scale;
        for (let sx = 0; sx < SS; sx++) {
          const x = (px + (sx + 0.5) / SS) * scale;
          const [r, g, b, a] = colorAt(x, y);
          pr += r * a;
          pg += g * a;
          pb += b * a;
          pa += a;
        }
      }
      raw[o++] = pa > 0 ? Math.round(pr / pa) : 0;
      raw[o++] = pa > 0 ? Math.round(pg / pa) : 0;
      raw[o++] = pa > 0 ? Math.round(pb / pa) : 0;
      raw[o++] = Math.round((pa / (SS * SS)) * 255);
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // 位深
  ihdr[9] = 6; // 颜色类型:RGBA
  // 10/11/12 = 压缩/滤波/隔行,均为 0

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------- ICO 编码 ----------------
/** 多尺寸 ICO:每个条目直接内嵌 PNG(Vista+ 支持) */
function renderICO(sizes) {
  const images = sizes.map((size) => ({ size, png: renderPNG(size) }));
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(0, 0); // 保留
  header.writeUInt16LE(1, 2); // 类型:图标
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach((img, i) => {
    const o = 6 + 16 * i;
    header[o] = img.size >= 256 ? 0 : img.size; // 宽(0 表示 256)
    header[o + 1] = img.size >= 256 ? 0 : img.size; // 高
    header[o + 2] = 0; // 调色板色数
    header[o + 3] = 0; // 保留
    header.writeUInt16LE(1, o + 4); // 色彩平面
    header.writeUInt16LE(32, o + 6); // 位深
    header.writeUInt32LE(img.png.length, o + 8);
    header.writeUInt32LE(offset, o + 12);
    offset += img.png.length;
  });
  return Buffer.concat([header, ...images.map((i) => i.png)]);
}

// ---------------- 产出 ----------------
mkdirSync(PUB, { recursive: true });
const outputs = [
  ['apple-touch-icon.png', renderPNG(180)],
  ['favicon.ico', renderICO([16, 32, 48])],
];
for (const [name, buf] of outputs) {
  writeFileSync(join(PUB, name), buf);
  console.log(`✓ public/${name}  ${(buf.length / 1024).toFixed(1)} KB`);
}

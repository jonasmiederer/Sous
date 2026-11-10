// Generates the Sous app icons (PNG) into web/public/icons.
// The mark is a chef's toque (sous chef) on a herb-green rounded square.
// Pure Node (zlib only) so it runs without image tooling:
//   node web/scripts/generate-icons.mjs
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');
mkdirSync(outDir, { recursive: true });

const BG = [0x2f, 0x6b, 0x3a];
const HAT = [0xfb, 0xf1, 0xe0];
const BAND = [0xf5, 0xb9, 0x4e];
const PLEAT = [0xb4, 0xc0, 0xa6];

// All geometry is in unit coordinates (0..1) of the mark's own box.
const inCircle = (x, y, cx, cy, r) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
function inHat(x, y) {
  // Three overlapping lobes plus a slightly tapered body.
  if (inCircle(x, y, 0.22, 0.4, 0.16)) return true;
  if (inCircle(x, y, 0.78, 0.4, 0.16)) return true;
  if (inCircle(x, y, 0.5, 0.25, 0.2)) return true;
  if (y >= 0.38 && y <= 0.8) {
    const half = 0.3 - ((y - 0.38) / 0.42) * 0.04;
    return Math.abs(x - 0.5) <= half;
  }
  return false;
}
function inBand(x, y) {
  const hw = 0.31, r = 0.03, y0 = 0.78, y1 = 0.93;
  const qx = Math.max(Math.abs(x - 0.5) - (hw - r), 0);
  const qy = Math.max(Math.abs(y - (y0 + y1) / 2) - ((y1 - y0) / 2 - r), 0);
  return qx * qx + qy * qy <= r * r;
}
function nearSegment(x, y, x0, y0, x1, y1, w) {
  const dx = x1 - x0, dy = y1 - y0;
  const t = Math.max(0, Math.min(1, ((x - x0) * dx + (y - y0) * dy) / (dx * dx + dy * dy)));
  return inCircle(x, y, x0 + t * dx, y0 + t * dy, w);
}
function inPleat(x, y) {
  return (
    nearSegment(x, y, 0.385, 0.5, 0.365, 0.74, 0.014) ||
    nearSegment(x, y, 0.5, 0.5, 0.5, 0.74, 0.014) ||
    nearSegment(x, y, 0.615, 0.5, 0.635, 0.74, 0.014)
  );
}
function markColor(x, y) {
  if (inBand(x, y)) return BAND;
  if (inHat(x, y)) return inPleat(x, y) ? PLEAT : HAT;
  return null;
}
function inRoundedSquare(x, y, radius) {
  const qx = Math.max(Math.abs(x - 0.5) - (0.5 - radius), 0);
  const qy = Math.max(Math.abs(y - 0.5) - (0.5 - radius), 0);
  return qx * qx + qy * qy <= radius * radius && Math.abs(x - 0.5) <= 0.5 && Math.abs(y - 0.5) <= 0.5;
}

/** markScale: fraction of the icon the mark occupies; maskable icons are full-bleed. */
function render(size, { maskable }) {
  const markScale = maskable ? 0.62 : 0.78;
  const ss = 4;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let py = 0; py < size; py++) {
    raw[py * (size * 4 + 1)] = 0; // filter: none
    for (let px = 0; px < size; px++) {
      let bgCov = 0;
      const sum = [0, 0, 0];
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const x = (px + (sx + 0.5) / ss) / size;
          const y = (py + (sy + 0.5) / ss) / size;
          const inBg = maskable || inRoundedSquare(x, y, 0.22);
          if (!inBg) continue;
          bgCov++;
          const mx = (x - 0.5) / markScale + 0.5;
          // Shift down slightly: the mark's visual centre sits near y = 0.49.
          const my = (y - 0.5) / markScale + 0.51;
          const c = markColor(mx, my) ?? BG;
          sum[0] += c[0]; sum[1] += c[1]; sum[2] += c[2];
        }
      }
      const o = py * (size * 4 + 1) + 1 + px * 4;
      for (let c = 0; c < 3; c++) raw[o + c] = bgCov === 0 ? 0 : Math.round(sum[c] / bgCov);
      raw[o + 3] = Math.round((bgCov / (ss * ss)) * 255);
    }
  }
  return encodePng(size, size, raw);
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePng(w, h, raw) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const targets = [
  ['icon-192.png', 192, false],
  ['icon-512.png', 512, false],
  ['icon-maskable-512.png', 512, true],
  ['apple-touch-icon-180.png', 180, true],
];
for (const [name, size, maskable] of targets) {
  writeFileSync(join(outDir, name), render(size, { maskable }));
  console.log(`wrote ${name}`);
}

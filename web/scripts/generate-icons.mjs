// Generates the Sous app icons (PNG) into web/public/icons.
// The mark is a bowl with a sprouting leaf on a herb-green rounded square.
// Pure Node (zlib only) so it runs without image tooling:
//   node web/scripts/generate-icons.mjs
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');
mkdirSync(outDir, { recursive: true });

const BG = [0x2f, 0x6b, 0x3a];
const FG = [0xff, 0xff, 0xff];

// All geometry is in unit coordinates (0..1) of the mark's own box.
function inLeaf(x, y) {
  // Vesica (intersection of two circles) along an axis tilted 40 degrees.
  const cx = 0.57, cy = 0.3, a = (-45 * Math.PI) / 180;
  const ux = Math.cos(a), uy = Math.sin(a); // leaf axis
  const px = -uy, py = ux; // perpendicular
  const R = 0.19, d = 0.125;
  // Stem from the bowl rim up to the leaf base.
  const stem = Math.abs(x - 0.5) <= 0.018 && y >= 0.36 && y <= 0.53;
  if (stem) return true;
  const dx1 = x - (cx + px * d), dy1 = y - (cy + py * d);
  const dx2 = x - (cx - px * d), dy2 = y - (cy - py * d);
  return dx1 * dx1 + dy1 * dy1 <= R * R && dx2 * dx2 + dy2 * dy2 <= R * R;
}
function inBowl(x, y) {
  const cx = 0.5, cy = 0.55, r = 0.3;
  const rim = y >= cy - 0.03 && y <= cy + 0.025 && Math.abs(x - cx) <= r + 0.04;
  const bowl = y >= cy && (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
  const base = y >= cy + r - 0.01 && y <= cy + r + 0.04 && Math.abs(x - cx) <= 0.12;
  return rim || bowl || base;
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
      let bgCov = 0, fgCov = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const x = (px + (sx + 0.5) / ss) / size;
          const y = (py + (sy + 0.5) / ss) / size;
          const inBg = maskable || inRoundedSquare(x, y, 0.22);
          if (!inBg) continue;
          bgCov++;
          const mx = (x - 0.5) / markScale + 0.5;
          const my = (y - 0.5) / markScale + 0.5;
          if (inLeaf(mx, my) || inBowl(mx, my)) fgCov++;
        }
      }
      const n = ss * ss;
      const alpha = bgCov / n;
      const t = bgCov === 0 ? 0 : fgCov / bgCov;
      const o = py * (size * 4 + 1) + 1 + px * 4;
      for (let c = 0; c < 3; c++) raw[o + c] = Math.round(BG[c] * (1 - t) + FG[c] * t);
      raw[o + 3] = Math.round(alpha * 255);
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

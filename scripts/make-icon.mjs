// scripts/make-icon.mjs — regenerate build/icon.png (dependency-free; run: node scripts/make-icon.mjs)
import { deflateSync } from 'zlib'
import { writeFileSync } from 'fs'

const S = 1024, BG = [0x14, 0x14, 0x18], FG = [0x7c, 0x6c, 0xf0]
// 5x7 blocky glyphs for N and C (row-major, 1 = filled).
const GLYPHS = {
  N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  C: ['01110', '10001', '10000', '10000', '10000', '10001', '01110']
}
const buf = Buffer.alloc(S * S * 4)
const px = (x, y, [r, g, b]) => { const i = (y * S + x) * 4; buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = 255 }
// rounded-square background
const RAD = 180
for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
  const cx = Math.min(x, S - 1 - x), cy = Math.min(y, S - 1 - y)
  const inCorner = cx < RAD && cy < RAD && ((RAD - cx) ** 2 + (RAD - cy) ** 2) > RAD ** 2
  if (!inCorner) px(x, y, BG)
}
// draw "NC": each glyph 5x7, scaled; two glyphs side by side, centered
const CELL = 90, GW = 5 * CELL, GAP = 60, total = GW * 2 + GAP
let ox = (S - total) / 2
const oy = (S - 7 * CELL) / 2
for (const letter of ['N', 'C']) {
  const g = GLYPHS[letter]
  for (let r = 0; r < 7; r++) for (let c = 0; c < 5; c++) if (g[r][c] === '1') {
    for (let dy = 0; dy < CELL; dy++) for (let dx = 0; dx < CELL; dx++) px(ox + c * CELL + dx, oy + r * CELL + dy, FG)
  }
  ox += GW + GAP
}
// --- minimal PNG encoder (RGBA, filter 0) ---
const CRC = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0 } return t })()
const crc32 = (b) => { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}
const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4); ihdr[8] = 8; ihdr[9] = 6 // 8-bit, RGBA
const raw = Buffer.alloc(S * (S * 4 + 1))
for (let y = 0; y < S; y++) { raw[y * (S * 4 + 1)] = 0; buf.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4) }
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))
])
writeFileSync(new URL('../build/icon.png', import.meta.url), png)
console.log('wrote build/icon.png')

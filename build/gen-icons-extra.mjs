/**
 * 从定稿 build/icon.ico 的原始帧生成跨平台图标资产（字节级原帧重组，不重绘）：
 *   build/icon.icns  macOS（仅使用尺寸匹配的 16/32/64/128/256 PNG 帧）
 *   build/icon.png   Linux / electron-builder 回退（256 帧）
 * 素材定稿后勿改几何；仅当 icon.ico 更新时重跑 `node build/gen-icons-extra.mjs`。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath as furl } from 'node:url'

const here = dirname(furl(import.meta.url))
const ico = readFileSync(join(here, 'icon.ico'))
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

if (ico.length < 6 || ico.readUInt16LE(0) !== 0 || ico.readUInt16LE(2) !== 1) {
  throw new Error('Invalid ICO magic: expected an icon directory')
}
const count = ico.readUInt16LE(4)
const directoryEnd = 6 + count * 16
if (count === 0 || directoryEnd > ico.length) {
  throw new Error('Invalid ICO directory bounds')
}

// Validate every source frame, including sizes without a matching ICNS slot.
const frames = new Map()
for (let i = 0; i < count; i++) {
  const off = 6 + i * 16
  const width = ico[off] || 256
  const height = ico[off + 1] || 256
  const length = ico.readUInt32LE(off + 8)
  const offset = ico.readUInt32LE(off + 12)
  if (offset < directoryEnd || offset > ico.length || length > ico.length - offset) {
    throw new Error(`Invalid ICO frame ${i} bounds`)
  }
  const png = ico.subarray(offset, offset + length)
  if (
    png.length < 33 ||
    !png.subarray(0, 8).equals(pngSignature) ||
    png.readUInt32BE(8) !== 13 ||
    png.toString('ascii', 12, 16) !== 'IHDR'
  ) {
    throw new Error(`Invalid PNG header in ICO frame ${i}`)
  }
  if (width !== height || png.readUInt32BE(16) !== width || png.readUInt32BE(20) !== height) {
    throw new Error(`PNG dimensions do not match ICO frame ${i} (${width}x${height})`)
  }
  if (frames.has(width)) throw new Error(`Duplicate ICO frame size: ${width}`)
  frames.set(width, png)
}
const f256 = frames.get(256)
if (!frames.has(128) || !f256) throw new Error('icon.ico 缺少 128/256 帧')

function chunk(type, png) {
  const header = Buffer.alloc(8)
  header.write(type, 0, 'ascii')
  header.writeUInt32BE(png.length + 8, 4)
  return Buffer.concat([header, png])
}

// ICNS sizes are physical pixels; never put a 256px PNG in ic09/ic10.
const slots = [
  ['icp4', 16],
  ['icp5', 32],
  ['icp6', 64],
  ['ic07', 128],
  ['ic08', 256]
].filter(([, size]) => frames.has(size))
const header = Buffer.alloc(8)
header.write('icns', 0, 'ascii')
const icns = Buffer.concat([header, ...slots.map(([type, size]) => chunk(type, frames.get(size)))])
icns.writeUInt32BE(icns.length, 4)
writeFileSync(join(here, 'icon.icns'), icns)

// ---- png（256 原帧直出） ----
writeFileSync(join(here, 'icon.png'), f256)

console.log(
  `assets written: build/icon.icns (${icns.length}B, ${slots.map(([type]) => type).join('/')}) + build/icon.png (${f256.length}B, 256 原帧)`
)
console.log(resolve(join(here, 'icon.icns')))

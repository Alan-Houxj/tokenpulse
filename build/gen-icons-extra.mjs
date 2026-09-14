/**
 * 从定稿 build/icon.ico 的原始帧生成跨平台图标资产（字节级原帧重组，不重绘）：
 *   build/icon.icns  macOS（ic07=128 / ic08=256 / ic09=512槽位用256帧）
 *   build/icon.png   Linux / electron-builder 回退（256 帧）
 * 素材定稿后勿改几何；仅当 icon.ico 更新时重跑 `node build/gen-icons-extra.mjs`。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath as furl } from 'node:url'

const here = dirname(furl(import.meta.url))
const ico = readFileSync(join(here, 'icon.ico'))

// 解析 ICO 目录，取各尺寸 PNG 帧
const frames = new Map()
{
  const count = ico.readUInt16LE(4)
  let off = 6
  for (let i = 0; i < count; i++) {
    const size = ico[off] === 0 ? 256 : ico[off]
    const len = ico.readUInt32LE(off + 8)
    const doff = ico.readUInt32LE(off + 12)
    frames.set(size, ico.subarray(doff, doff + len))
    off += 16
  }
}
const f128 = frames.get(128)
const f256 = frames.get(256)
if (!f128 || !f256) throw new Error('icon.ico 缺少 128/256 帧')

// ---- icns：type + (length) + PNG 数据 ----
function chunk(type, png) {
  const b = Buffer.alloc(8)
  b.write(type, 0, 'ascii')
  b.writeUInt32BE(png.length + 8)
  return Buffer.concat([b, png])
}
const icns = Buffer.concat([
  (() => {
    const h = Buffer.alloc(8)
    h.write('icns', 0, 'ascii')
    return h
  })(),
  chunk('ic07', f128), // 128
  chunk('ic08', f256), // 256
  chunk('ic09', f256), // 512 槽位（256 原帧，系统按需缩放，不引入重绘）
  chunk('ic10', f256) // 1024(512@2x) 槽位
])
icns.writeUInt32BE(icns.length, 4)
writeFileSync(join(here, 'icon.icns'), icns)

// ---- png（256 原帧直出） ----
writeFileSync(join(here, 'icon.png'), f256)

console.log(
  `assets written: build/icon.icns (${icns.length}B, ic07/ic08/ic09/ic10) + build/icon.png (${f256.length}B, 256 原帧)`
)
console.log(resolve(join(here, 'icon.icns')))

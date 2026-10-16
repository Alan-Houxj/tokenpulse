import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const buildDir = fileURLToPath(new URL('../build/', import.meta.url))
const originalIco = readFileSync(join(buildDir, 'icon.ico'))
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const slotSizes: Record<string, number> = { icp4: 16, icp5: 32, icp6: 64, ic07: 128, ic08: 256 }

function readIcoFrames(ico: Buffer): Map<number, Buffer> {
  expect(ico.subarray(0, 4)).toEqual(Buffer.from([0, 0, 1, 0]))
  const count = ico.readUInt16LE(4)
  const directoryEnd = 6 + count * 16
  expect(count).toBeGreaterThan(0)
  expect(directoryEnd).toBeLessThanOrEqual(ico.length)
  const frames = new Map<number, Buffer>()
  for (let i = 0; i < count; i++) {
    const entry = 6 + i * 16
    const size = ico[entry] || 256
    expect(ico[entry + 1] || 256).toBe(size)
    const length = ico.readUInt32LE(entry + 8)
    const offset = ico.readUInt32LE(entry + 12)
    expect(offset).toBeGreaterThanOrEqual(directoryEnd)
    expect(length).toBeGreaterThanOrEqual(33)
    expect(offset + length).toBeLessThanOrEqual(ico.length)
    const png = ico.subarray(offset, offset + length)
    expect(png.subarray(0, 8)).toEqual(pngSignature)
    expect(png.readUInt32BE(8)).toBe(13)
    expect(png.toString('ascii', 12, 16)).toBe('IHDR')
    expect(png.readUInt32BE(16)).toBe(size)
    expect(png.readUInt32BE(20)).toBe(size)
    frames.set(size, png)
  }
  return frames
}

const originalFrames = readIcoFrames(originalIco)

function verifyIcns(icns: Buffer, frames: Map<number, Buffer>) {
  expect(icns.length).toBeGreaterThan(8)
  expect(icns.toString('ascii', 0, 4)).toBe('icns')
  expect(icns.readUInt32BE(4)).toBe(icns.length)
  const types: string[] = []
  let offset = 8
  while (offset < icns.length) {
    expect(offset + 8).toBeLessThanOrEqual(icns.length)
    const type = icns.toString('ascii', offset, offset + 4)
    expect(Object.keys(slotSizes)).toContain(type)
    expect(types).not.toContain(type)
    const length = icns.readUInt32BE(offset + 4)
    expect(length).toBeGreaterThan(8)
    expect(offset + length).toBeLessThanOrEqual(icns.length)
    const png = icns.subarray(offset + 8, offset + length)
    expect(png.length).toBeGreaterThanOrEqual(33)
    expect(png.subarray(0, 8)).toEqual(pngSignature)
    expect(png.toString('ascii', 12, 16)).toBe('IHDR')
    expect(png.readUInt32BE(16)).toBe(slotSizes[type])
    expect(png.readUInt32BE(20)).toBe(slotSizes[type])
    expect(png).toEqual(frames.get(slotSizes[type]!))
    types.push(type)
    offset += length
  }
  expect(offset).toBe(icns.length)
  expect(types.sort()).toEqual(Object.keys(slotSizes).filter(type => frames.has(slotSizes[type]!)).sort())
  expect(types).not.toContain('ic09')
  expect(types).not.toContain('ic10')
}

// Synthetic directories exercise ordering and padding without modifying any PNG.
function makeIco(sizes: number[]) {
  const directory = Buffer.alloc(6 + sizes.length * 16 + 7)
  directory.writeUInt16LE(1, 2)
  directory.writeUInt16LE(sizes.length, 4)
  const parts: Buffer[] = [directory]
  let offset = directory.length
  for (const [i, size] of sizes.entries()) {
    const png = originalFrames.get(size)!
    const entry = 6 + i * 16
    directory[entry] = directory[entry + 1] = size === 256 ? 0 : size
    directory.writeUInt16LE(1, entry + 4)
    directory.writeUInt16LE(32, entry + 6)
    directory.writeUInt32LE(png.length, entry + 8)
    directory.writeUInt32LE(offset, entry + 12)
    const padding = Buffer.alloc(3, 0xa5)
    parts.push(png, padding)
    offset += png.length + padding.length
  }
  return Buffer.concat(parts)
}

function generate(ico: Buffer) {
  const dir = mkdtempSync(join(tmpdir(), 'tokenpulse-icons-'))
  try {
    const script = join(dir, 'gen-icons-extra.mjs')
    copyFileSync(join(buildDir, 'gen-icons-extra.mjs'), script)
    writeFileSync(join(dir, 'icon.ico'), ico)
    const result = spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 10_000 })
    if (result.error) throw result.error
    const readOutput = (name: string) => existsSync(join(dir, name)) ? readFileSync(join(dir, name)) : null
    expect(readFileSync(join(dir, 'icon.ico'))).toEqual(ico)
    return { status: result.status, stderr: result.stderr, icns: readOutput('icon.icns'), png: readOutput('icon.png') }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function invalidFixture(change: (ico: Buffer) => void) {
  const ico = makeIco([20, 16, 32, 64, 128, 256])
  change(ico)
  return ico
}

describe('ICO to ICNS assets', () => {
  it('keeps exact original PNG bytes in legal checked-in ICNS slots', () => {
    expect([...originalFrames.keys()].sort((a, b) => a - b)).toEqual([16, 20, 24, 32, 48, 64, 128, 256])
    verifyIcns(readFileSync(join(buildDir, 'icon.icns')), originalFrames)
    expect(readFileSync(join(buildDir, 'icon.png'))).toEqual(originalFrames.get(256))
  })

  it('regenerates the real assets deterministically without changing the ICO or PNG', () => {
    const result = generate(originalIco)
    expect(result.status, result.stderr).toBe(0)
    verifyIcns(result.icns!, originalFrames)
    expect(result.icns).toEqual(readFileSync(join(buildDir, 'icon.icns')))
    expect(result.png).toEqual(readFileSync(join(buildDir, 'icon.png')))
    expect(result.png).toEqual(originalFrames.get(256))
  })

  it.each([
    { sizes: [256, 48, 128, 24, 64, 20, 32, 16] },
    { sizes: [256, 128] }
  ])('handles synthetic ICO ordering, padding, and available sizes: $sizes', ({ sizes }) => {
    const ico = makeIco(sizes)
    const result = generate(ico)
    expect(result.status, result.stderr).toBe(0)
    verifyIcns(result.icns!, readIcoFrames(ico))
    expect(result.png).toEqual(originalFrames.get(256))
  })

  it.each([
    { name: 'short header', ico: Buffer.alloc(5), error: 'ICO magic' },
    { name: 'bad reserved magic', ico: invalidFixture(b => { b.writeUInt16LE(1, 0) }), error: 'ICO magic' },
    { name: 'cursor instead of icon', ico: invalidFixture(b => { b.writeUInt16LE(2, 2) }), error: 'ICO magic' },
    { name: 'empty directory', ico: invalidFixture(b => { b.writeUInt16LE(0, 4) }), error: 'directory bounds' },
    { name: 'truncated directory', ico: originalIco.subarray(0, 21), error: 'directory bounds' },
    { name: 'frame inside directory', ico: invalidFixture(b => { b.writeUInt32LE(6, 18) }), error: 'frame 0 bounds' },
    { name: 'offset past end', ico: invalidFixture(b => { b.writeUInt32LE(0xffffffff, 18) }), error: 'frame 0 bounds' },
    { name: 'length past end', ico: invalidFixture(b => { b.writeUInt32LE(0xffffffff, 14) }), error: 'frame 0 bounds' },
    { name: 'empty PNG', ico: invalidFixture(b => { b.writeUInt32LE(0, 14) }), error: 'PNG header' },
    { name: 'truncated PNG header', ico: invalidFixture(b => { b.writeUInt32LE(32, 14) }), error: 'PNG header' },
    { name: 'non-PNG frame', ico: invalidFixture(b => { b[b.readUInt32LE(18)] = 0 }), error: 'PNG header' },
    { name: 'invalid IHDR length', ico: invalidFixture(b => { b.writeUInt32BE(12, b.readUInt32LE(18) + 8) }), error: 'PNG header' },
    { name: 'invalid IHDR type', ico: invalidFixture(b => { b.write('IDAT', b.readUInt32LE(18) + 12, 'ascii') }), error: 'PNG header' },
    { name: 'wrong PNG width in unused 20px frame', ico: invalidFixture(b => { b.writeUInt32BE(21, b.readUInt32LE(18) + 16) }), error: 'PNG dimensions' },
    { name: 'wrong PNG height', ico: invalidFixture(b => { b.writeUInt32BE(21, b.readUInt32LE(18) + 20) }), error: 'PNG dimensions' },
    { name: 'non-square directory dimensions', ico: invalidFixture(b => { b[7] = 21 }), error: 'PNG dimensions' },
    { name: 'duplicate size', ico: makeIco([128, 128, 256]), error: 'Duplicate ICO frame size' },
    { name: 'missing 128px frame', ico: makeIco([256]), error: '128/256' },
    { name: 'missing 256px frame', ico: makeIco([128]), error: '128/256' }
  ])('rejects $name before writing assets', ({ ico, error }) => {
    const result = generate(ico)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(error)
    expect(result.icns).toBeNull()
    expect(result.png).toBeNull()
  })
})

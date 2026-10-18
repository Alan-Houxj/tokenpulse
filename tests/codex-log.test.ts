import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import {
  appendFileSync, closeSync, ftruncateSync, mkdtempSync, openSync, readFileSync,
  renameSync, rmSync, statSync, truncateSync, utimesSync, writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { constants, createZstdDecompress, zstdCompressSync } from 'node:zlib'
import { scanCodexLog } from '../src/core/adapters/codex-log'
import type { DiscoveredFile } from '../src/core/model/types'

let dir: string
const MiB = 1024 * 1024
const firstLine = JSON.stringify({ type: 'session_meta', payload: { id: 'synthetic-session' } })
const secondLine = JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: null } })
const raw = Buffer.from(`${firstLine}\n${secondLine}\n`)
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')

function frame(bytes: Buffer | string, checksum = true): Buffer {
  return zstdCompressSync(bytes, { params: { [constants.ZSTD_c_checksumFlag]: checksum ? 1 : 0 } })
}

function file(bytes: Buffer | string, name = 'rollout-test.jsonl.zst'): DiscoveredFile {
  const path = join(dir, name)
  writeFileSync(path, bytes)
  const st = statSync(path)
  return { path, size: st.size, mtimeMs: st.mtimeMs }
}

async function read(source: DiscoveredFile, verifyOffset?: number) {
  const lines: string[] = []
  const offsets: number[] = []
  const snapshot = await scanCodexLog(source, (line, offset) => {
    lines.push(line)
    offsets.push(offset)
  }, verifyOffset)
  return { lines, offsets, snapshot }
}

function skippable(bytes: Buffer, variant = 0): Buffer {
  const header = Buffer.alloc(8)
  header.writeUInt32LE(0x184d2a50 + variant)
  header.writeUInt32LE(bytes.length, 4)
  return Buffer.concat([header, bytes])
}

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tokenpulse-codex-log-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('Codex decoded JSONL snapshots', () => {
  it('has identical plain/compressed lines, decoded offsets and fingerprints', async () => {
    const content = Buffer.from(`${firstLine}\r\n\n${JSON.stringify({ text: '\u4e2d\u6587\ud83d\ude80' })}\npartial`)
    const plain = await read(file(content, 'plain.jsonl'))
    const compressed = await read(file(frame(content)))
    expect(compressed.lines).toEqual(plain.lines)
    expect(compressed.offsets).toEqual(plain.offsets)
    expect(plain.lines).toEqual([firstLine, '', JSON.stringify({ text: '\u4e2d\u6587\ud83d\ude80' })])
    const end = content.lastIndexOf(10) + 1
    expect(plain.snapshot).toMatchObject({ endOffset: end, physicalEndOffset: end, size: content.length, fingerprint: sha(content.subarray(0, end)) })
    expect(compressed.snapshot).toMatchObject({ endOffset: end, physicalEndOffset: compressed.snapshot.size, fingerprint: plain.snapshot.fingerprint, tailLines: plain.lines })
    expect(compressed.snapshot.previousFingerprint).toBeUndefined()
  })

  it('reads current stat rather than stale discovery metadata and leaves the source intact', async () => {
    const source = file(frame(raw))
    const before = readFileSync(source.path)
    const result = await read({ ...source, size: 0, mtimeMs: 0 })
    expect(result.snapshot.size).toBe(before.length)
    expect(result.snapshot.mtimeMs).toBeGreaterThan(0)
    const st = statSync(source.path, { bigint: true })
    expect(result.snapshot.identity).toBe(`${st.dev}:${st.ino}:${st.birthtimeNs}`)
    expect(readFileSync(source.path)).toEqual(before)
  })

  it('handles empty files, empty frames, and a final uncommitted line', async () => {
    for (const source of [
      file('', 'empty.jsonl'), file('', 'empty.jsonl.zst'),
      file(frame(''), 'empty-frame.jsonl.zst'), file(frame('unfinished'), 'partial.jsonl.zst')
    ]) {
      const result = await read(source, 0)
      expect(result.lines).toEqual([])
      expect(result.snapshot).toMatchObject({ endOffset: 0, fingerprint: sha(''), previousFingerprint: sha(''), tailLines: [] })
    }
  })

  it('streams a single frame larger than 16 MiB decoded', async () => {
    const row = Buffer.from(`${JSON.stringify({ text: 'x'.repeat(1024) })}\n`)
    const rows = 17_000
    const content = Buffer.alloc(row.length * rows)
    for (let offset = 0; offset < content.length; offset += row.length) row.copy(content, offset)
    expect(content.length).toBeGreaterThan(16 * MiB)
    let count = 0
    const snapshot = await scanCodexLog(file(frame(content)), (line) => {
      expect(line.length).toBe(row.length - 1)
      count++
    })
    expect(count).toBe(rows)
    expect(snapshot.endOffset).toBe(content.length)
    expect(snapshot.fingerprint).toBe(sha(content))
    expect(snapshot.tailLines.reduce((n, line) => n + Buffer.byteLength(line) + 1, 0)).toBeLessThanOrEqual(64 * 1024)
  }, 15_000)

  it('reassembles a long UTF-8 line across native output chunks', async () => {
    const line = JSON.stringify({ text: '\u4e2d'.repeat(50_000) })
    const result = await read(file(frame(`${line}\n`)))
    expect(result.lines).toEqual([line])
    expect(result.offsets).toEqual([Buffer.byteLength(line) + 1])
    expect(result.snapshot.tailLines).toEqual([])
  })

  it('hashes exact decoded prefixes, including an offset inside a UTF-8 character', async () => {
    const content = Buffer.from(`${JSON.stringify({ text: '\u4e2d' })}\n${secondLine}\npartial`)
    const end = content.lastIndexOf(10) + 1
    for (const offset of [0, content.indexOf(Buffer.from('\u4e2d')) + 1, end]) {
      const result = await read(file(frame(content)), offset)
      expect(result.snapshot.previousFingerprint).toBe(sha(content.subarray(0, offset)))
      expect(result.snapshot.fingerprint).toBe(sha(content.subarray(0, end)))
    }
    for (const offset of [end + 1, content.length, content.length + 1]) {
      expect((await read(file(frame(content)), offset)).snapshot.previousFingerprint).toBeUndefined()
    }
  })

  it('keeps only complete lines entirely within the last 64 KiB committed bytes', async () => {
    const old = 'o'.repeat(40 * 1024)
    const recent = 'r'.repeat(30 * 1024)
    const final = '{"final":true}'
    const result = await read(file(frame(`${old}\n${recent}\r\n${final}\npartial`)))
    expect(result.snapshot.tailLines).toEqual([recent, final])
    const oversize = await read(file(frame(`${final}\n${'x'.repeat(64 * 1024)}\nlast\n`)))
    expect(oversize.snapshot.tailLines).toEqual(['last'])
  })

  it('does not parse or persist incomplete JSON and rejects invalid complete UTF-8', async () => {
    const invalid = await read(file(frame('{not-json}\npartial')))
    expect(invalid.lines).toEqual(['{not-json}'])
    expect(invalid.snapshot).not.toHaveProperty('partialLine')
    await expect(read(file(frame(Buffer.from([0xff, 10]))))).rejects.toThrow(/Codex log.*UTF-8/)
    expect((await read(file(frame(Buffer.from([0xff]))))).snapshot.endOffset).toBe(0)
  })
})

describe('Codex exact Zstandard frame boundaries', () => {
  it('works around the native stream stopping at the first concatenated frame', async () => {
    const a = frame(`${firstLine}\n`)
    const b = frame(`${secondLine}\n`)
    const decoder = createZstdDecompress()
    const nativeParts: Buffer[] = []
    decoder.end(Buffer.concat([a, b]))
    for await (const chunk of decoder) nativeParts.push(chunk as Buffer)
    expect(Buffer.concat(nativeParts)).toEqual(Buffer.from(`${firstLine}\n`))
    const result = await read(file(Buffer.concat([a, b])))
    expect(result.lines).toEqual([firstLine, secondLine])
    expect(result.snapshot).toMatchObject({ endOffset: raw.length, physicalEndOffset: a.length + b.length, fingerprint: sha(raw) })
  })

  it('accepts checksum-free and unknown-content-size frames', async () => {
    const unknown = Buffer.concat([
      Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0, 0, 25, 0, 0]), Buffer.from('{}\n')
    ])
    const result = await read(file(Buffer.concat([frame(raw, false), unknown])))
    expect(result.lines).toEqual([firstLine, secondLine, '{}'])
    expect(result.snapshot.fingerprint).toBe(sha(Buffer.concat([raw, Buffer.from('{}\n')])))
  })

  it('allows JSON and a multibyte UTF-8 character to cross frames and skippable data', async () => {
    const content = Buffer.from(`${JSON.stringify({ text: '\u4e2d\ud83d\ude80' })}\n${secondLine}\n`)
    const split = content.indexOf(Buffer.from('\u4e2d')) + 1
    const bytes = Buffer.concat([
      frame(content.subarray(0, split)), skippable(Buffer.from('ignored'), 15),
      frame(content.subarray(split, split + 1)), frame(content.subarray(split + 1))
    ])
    const result = await read(file(bytes))
    expect(result.lines).toEqual(content.toString('utf8').trimEnd().split('\n'))
    expect(result.snapshot).toMatchObject({ endOffset: content.length, physicalEndOffset: bytes.length, fingerprint: sha(content) })
  })

  it('excludes every structurally incomplete frame prefix, including torn checksum trailers', async () => {
    const a = frame(`${firstLine}\n`)
    const b = frame(`${secondLine}\n`)
    for (let cut = 0; cut < b.length; cut++) {
      const result = await read(file(Buffer.concat([a, b.subarray(0, cut)])))
      expect(result.lines, `prefix length ${cut}`).toEqual([firstLine])
      expect(result.snapshot.physicalEndOffset).toBe(a.length)
      expect(result.snapshot.endOffset).toBe(Buffer.byteLength(firstLine) + 1)
      expect(result.snapshot.fingerprint).toBe(sha(`${firstLine}\n`))
    }
    for (let cut = 1; cut < a.length; cut++) {
      const result = await read(file(a.subarray(0, cut)))
      expect(result.lines).toEqual([])
      expect(result.snapshot.physicalEndOffset).toBe(0)
    }
  }, 20_000)

  it('does not decode an incomplete checksum even after the payload is available', async () => {
    const bytes = frame(raw)
    const source = file(bytes.subarray(0, -1))
    const first = await read(source)
    expect(first.lines).toEqual([])
    expect(first.snapshot.physicalEndOffset).toBe(0)
    appendFileSync(source.path, bytes.subarray(-1))
    const next = await read(source)
    expect(next.lines).toEqual([firstLine, secondLine])
    expect(next.snapshot.physicalEndOffset).toBe(bytes.length)
  })

  it('supports every skippable magic, including initial/trailing and zero-length frames', async () => {
    const skips = Array.from({ length: 16 }, (_, i) => skippable(Buffer.alloc(i), i))
    const bytes = Buffer.concat([...skips, frame(raw), skippable(Buffer.alloc(0))])
    const result = await read(file(bytes))
    expect(result.lines).toEqual([firstLine, secondLine])
    expect(result.snapshot.physicalEndOffset).toBe(bytes.length)
    expect(result.snapshot.fingerprint).toBe(sha(raw))
    const onlySkip = await read(file(skippable(Buffer.from('not JSONL'))))
    expect(onlySkip.lines).toEqual([])
    expect(onlySkip.snapshot.physicalEndOffset).toBe(onlySkip.snapshot.size)
  })

  it('holds every incomplete skippable prefix without consuming it', async () => {
    const a = frame(raw)
    const b = skippable(Buffer.from('ignored payload'))
    for (let cut = 1; cut < b.length; cut++) {
      const result = await read(file(Buffer.concat([a, b.subarray(0, cut)])))
      expect(result.snapshot.physicalEndOffset).toBe(a.length)
      expect(result.lines).toEqual([firstLine, secondLine])
    }
  })

  it('retains a line spanning a complete frame and an incomplete following frame', async () => {
    const a = frame(`${firstLine}\n{"part":`)
    const b = frame('true}\n')
    const source = file(Buffer.concat([a, b.subarray(0, -2)]))
    const initial = await read(source)
    expect(initial.lines).toEqual([firstLine])
    expect(initial.snapshot.physicalEndOffset).toBe(a.length)
    appendFileSync(source.path, b.subarray(-2))
    const complete = await read(source, initial.snapshot.endOffset)
    expect(complete.lines).toEqual([firstLine, '{"part":true}'])
    expect(complete.snapshot.previousFingerprint).toBe(initial.snapshot.fingerprint)
  })

  it('rejects checksum corruption and never returns a partial successful snapshot', async () => {
    const corrupt = frame(`${secondLine}\n`)
    corrupt[corrupt.length - 1] = corrupt[corrupt.length - 1]! ^ 1
    const source = file(Buffer.concat([frame(`${firstLine}\n`), corrupt, frame('later\n')]))
    const before = readFileSync(source.path)
    const received: string[] = []
    await expect(scanCodexLog(source, line => received.push(line))).rejects.toThrow(/Codex log.*integrity/)
    expect(received).not.toContain('later')
    expect(readFileSync(source.path)).toEqual(before)
  })

  it('rejects malformed structure and a structurally complete corrupt compressed block', async () => {
    const magic = Buffer.from(frame(raw))
    magic[0] = 0
    const reserved = Buffer.from(frame(raw))
    reserved[4] = reserved[4]! | 8
    const badBlock = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x20, 0, 7, 0, 0])
    const corruptPayload = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x20, 1, 13, 0, 0, 0xff])
    for (const bytes of [magic, reserved, badBlock, corruptPayload]) {
      await expect(read(file(bytes))).rejects.toThrow(/^Codex log /)
    }
    const before = frame(raw)
    await expect(read(file(Buffer.concat([before, Buffer.from('BAD!')])))).rejects.toThrow(/magic/)
  })
})

describe('Codex snapshot consistency and bounds', () => {
  it.each(['plain', 'compressed'])('permits append beyond the initial %s snapshot only', async (format) => {
    const compressed = format === 'compressed'
    const initial = compressed ? frame(raw) : raw
    const source = file(initial, compressed ? 'append.jsonl.zst' : 'append.jsonl')
    let appended = false
    const snapshot = await scanCodexLog(source, () => {
      if (!appended) {
        appended = true
        appendFileSync(source.path, compressed ? frame('later\n') : 'later\n')
      }
    })
    expect(snapshot).toMatchObject({ size: initial.length, endOffset: raw.length, fingerprint: sha(raw) })
    const next = await read(source, snapshot.endOffset)
    expect(next.lines).toEqual([firstLine, secondLine, 'later'])
    expect(next.snapshot.previousFingerprint).toBe(snapshot.fingerprint)
  })

  it('rejects prefix rewrites even with appended bytes and a restored mtime', async () => {
    const source = file(raw, 'rewrite.jsonl')
    const before = statSync(source.path)
    let changed = false
    await expect(scanCodexLog(source, () => {
      if (changed) return
      changed = true
      writeFileSync(source.path, Buffer.concat([Buffer.alloc(raw.length, 120), Buffer.from('extra\n')]))
      utimesSync(source.path, before.atime, before.mtime)
    })).rejects.toThrow(/changed/)
  })

  it('rejects same-size rewrites and truncation during callbacks', async () => {
    for (const truncate of [false, true]) {
      const source = file(raw, 'changed.jsonl')
      let changed = false
      await expect(scanCodexLog(source, () => {
        if (changed) return
        changed = true
        if (truncate) truncateSync(source.path, 0)
        else writeFileSync(source.path, Buffer.alloc(raw.length, 120))
      })).rejects.toThrow(/changed/)
    }
  })

  it('rejects replacement of the pathname while the original handle remains open', async () => {
    const source = file(raw, 'replace.jsonl')
    let changed = false
    await expect(scanCodexLog(source, () => {
      if (changed) return
      changed = true
      renameSync(source.path, join(dir, 'old.jsonl'))
      writeFileSync(source.path, raw)
    })).rejects.toThrow(/changed/)
  })

  it('reconciles rewritten/truncated prefixes and distinguishes replacement identities between scans', async () => {
    const source = file(raw, 'history.jsonl')
    const first = await read(source)
    writeFileSync(source.path, 'x'.repeat(raw.length - 1) + '\n')
    const rewritten = await read(source, first.snapshot.endOffset)
    expect(rewritten.snapshot.identity).toBe(first.snapshot.identity)
    expect(rewritten.snapshot.previousFingerprint).not.toBe(first.snapshot.fingerprint)
    writeFileSync(source.path, '{}\n')
    const truncated = await read(source, first.snapshot.endOffset)
    expect(truncated.snapshot.previousFingerprint).toBeUndefined()
    renameSync(source.path, join(dir, 'previous.jsonl'))
    writeFileSync(source.path, '{}\n')
    expect((await read(source)).snapshot.identity).not.toBe(truncated.snapshot.identity)
  })

  it('enforces the source limit before reading an oversized sparse file', async () => {
    const source = file('', 'large.jsonl')
    const fd = openSync(source.path, 'r+')
    try { ftruncateSync(fd, 512 * MiB + 1) } finally { closeSync(fd) }
    await expect(read(source)).rejects.toThrow(/512 MiB/)
    expect(statSync(source.path).size).toBe(512 * MiB + 1)
  })

  it('enforces declared output, window, dictionary and line bounds', async () => {
    const largeContent = Buffer.alloc(16)
    Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0xe0]).copy(largeContent)
    largeContent.writeBigUInt64LE(BigInt(1024 * MiB + 1), 5)
    Buffer.from([1, 0, 0]).copy(largeContent, 13)
    await expect(read(file(largeContent))).rejects.toThrow(/1 GiB/)
    const largeWindow = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0, 144, 1, 0, 0])
    await expect(read(file(largeWindow))).rejects.toThrow(/128 MiB/)
    const dictionary = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x21, 1, 0, 1, 0, 0])
    await expect(read(file(dictionary))).rejects.toThrow(/dictionary/)
    await expect(read(file(frame(Buffer.alloc(32 * MiB + 1, 120))))).rejects.toThrow(/32 MiB.*line/)
  }, 15_000)

  it('sanitizes errors without paths, native details or callback content', async () => {
    const source = { path: join(dir, 'private-missing.jsonl.zst'), size: 0, mtimeMs: 0 }
    await expect(read(source)).rejects.toThrow(/^Codex log could not be read$/)
    for (const name of ['error.jsonl', 'error.jsonl.zst']) {
      const input = file(name.endsWith('.zst') ? frame(raw) : raw, name)
      await expect(scanCodexLog(input, () => { throw new Error('private callback content') })).rejects.toThrow(/^Codex log /)
      try { await scanCodexLog(input, () => { throw new Error('private callback content') }) } catch (error) {
        expect((error as Error).message).not.toMatch(/private|error\.jsonl/)
      }
    }
    for (const offset of [-1, 1.5, Number.NaN]) {
      await expect(read(file(frame(raw)), offset)).rejects.toThrow(/verification offset/)
    }
  })
})

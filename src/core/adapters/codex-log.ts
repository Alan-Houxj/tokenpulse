import { isUtf8 } from 'node:buffer'
import { createHash, type Hash } from 'node:crypto'
import type { BigIntStats } from 'node:fs'
import { open, stat, type FileHandle } from 'node:fs/promises'
import { Readable, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { constants, createZstdDecompress } from 'node:zlib'
import type { DiscoveredFile } from '../model/types'

const MAX_INPUT_BYTES = 512 * 1024 * 1024
const MAX_DECODED_BYTES = 1024 * 1024 * 1024
const MAX_WINDOW_BYTES = 128 * 1024 * 1024
const MAX_LINE_BYTES = 32 * 1024 * 1024
const CHUNK_BYTES = 64 * 1024
const TAIL_BYTES = 64 * 1024
const MAX_FRAMES = 100_000
const ZSTD_MAGIC = 0xfd2fb528

export interface CodexLogSnapshot {
  endOffset: number
  physicalEndOffset: number
  size: number
  mtimeMs: number
  identity: string
  fingerprint: string
  previousFingerprint?: string
  tailLines: string[]
}

class CodexLogError extends Error {}

function fail(message: string): never {
  throw new CodexLogError(`Codex log ${message}`)
}

function identity(st: BigIntStats): string {
  return `${st.dev}:${st.ino}:${st.birthtimeNs}`
}

async function* chunks(handle: FileHandle, start: number, end: number, hash?: Hash): AsyncGenerator<Buffer> {
  while (start < end) {
    const data = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, end - start))
    const { bytesRead } = await handle.read(data, 0, data.length, start)
    if (bytesRead === 0) fail('changed or became unreadable during the scan')
    start += bytesRead
    const part = data.subarray(0, bytesRead)
    hash?.update(part)
    yield part
  }
}

/** Sequential physical reads also fingerprint skippable data and incomplete trailers. */
class PhysicalReader {
  position = 0
  private buffer: Buffer = Buffer.alloc(0)
  private index = 0
  private readonly hash = createHash('sha256')
  private readonly input: AsyncGenerator<Buffer>

  constructor(handle: FileHandle, readonly size: number) {
    this.input = chunks(handle, 0, size)
  }

  private async available(): Promise<void> {
    if (this.index < this.buffer.length) return
    const next = await this.input.next()
    if (next.done) fail('changed or became unreadable during the scan')
    this.buffer = next.value
    this.index = 0
    this.hash.update(this.buffer)
  }

  async take(length: number): Promise<Buffer | undefined> {
    if (length > this.size - this.position) return undefined
    const data = Buffer.allocUnsafe(length)
    let offset = 0
    while (offset < length) {
      await this.available()
      const count = Math.min(length - offset, this.buffer.length - this.index)
      this.buffer.copy(data, offset, this.index, this.index + count)
      this.index += count
      this.position += count
      offset += count
    }
    return data
  }

  async skip(length: number): Promise<boolean> {
    if (length > this.size - this.position) return false
    while (length > 0) {
      await this.available()
      const count = Math.min(length, this.buffer.length - this.index)
      this.index += count
      this.position += count
      length -= count
    }
    return true
  }

  async finish(): Promise<string> {
    await this.skip(this.size - this.position)
    return this.hash.digest('hex')
  }
}

interface Frame {
  start: number
  end: number
  contentSize?: number
}

async function scanFrames(reader: PhysicalReader): Promise<{ frames: Frame[]; physicalEndOffset: number }> {
  const frames: Frame[] = []
  let physicalEndOffset = 0
  let count = 0
  let declaredBytes = 0
  while (reader.position < reader.size) {
    if (++count > MAX_FRAMES) fail('exceeds the frame-count limit')
    const start = reader.position
    const magicBytes = await reader.take(4)
    if (!magicBytes) break
    const magic = magicBytes.readUInt32LE()
    if (((magic & 0xfffffff0) >>> 0) === 0x184d2a50) {
      const length = await reader.take(4)
      if (!length || !await reader.skip(length.readUInt32LE())) break
      physicalEndOffset = reader.position
      continue
    }
    if (magic !== ZSTD_MAGIC) fail('has unsupported Zstandard frame magic')
    const descriptor = await reader.take(1)
    if (!descriptor) break
    const d = descriptor[0]!
    if ((d & 0x18) !== 0) fail('has reserved Zstandard header bits')
    const singleSegment = (d & 0x20) !== 0
    const dictionaryBytes = [0, 1, 2, 4][d & 3]!
    const contentFlag = d >>> 6
    const contentBytes = contentFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentFlag
    const header = await reader.take((singleSegment ? 0 : 1) + dictionaryBytes + contentBytes)
    if (!header) break
    let cursor = 0
    let window = 0
    if (!singleSegment) {
      const w = header[cursor++]!
      const base = 2 ** (10 + (w >>> 3))
      window = base + (base / 8) * (w & 7)
    }
    if (dictionaryBytes > 0) {
      if (header.readUIntLE(cursor, dictionaryBytes) !== 0) fail('requires an unsupported Zstandard dictionary')
      cursor += dictionaryBytes
    }
    let contentSize: number | undefined
    if (contentBytes > 0) {
      const value = contentBytes === 8
        ? header.readBigUInt64LE(cursor)
        : BigInt(header.readUIntLE(cursor, contentBytes) + (contentBytes === 2 ? 256 : 0))
      if (value > BigInt(MAX_DECODED_BYTES)) fail('exceeds the 1 GiB decoded limit')
      contentSize = Number(value)
      if (singleSegment) window = contentSize
    }
    if (window > MAX_WINDOW_BYTES) fail('exceeds the 128 MiB Zstandard window limit')
    let complete = false
    while (reader.position < reader.size) {
      const blockBytes = await reader.take(3)
      if (!blockBytes) break
      const block = blockBytes.readUIntLE(0, 3)
      const blockType = (block >>> 1) & 3
      const blockSize = block >>> 3
      if (blockType === 3) fail('has a reserved Zstandard block type')
      if (blockSize > 128 * 1024) fail('has an invalid Zstandard block size')
      if (!await reader.skip(blockType === 1 ? 1 : blockSize)) break
      if ((block & 1) !== 0) {
        if ((d & 4) !== 0 && !await reader.take(4)) break
        complete = true
        break
      }
    }
    if (!complete) break
    declaredBytes += contentSize ?? 0
    if (declaredBytes > MAX_DECODED_BYTES) fail('exceeds the 1 GiB decoded limit')
    frames.push({ start, end: reader.position, contentSize })
    physicalEndOffset = reader.position
  }
  return { frames, physicalEndOffset }
}

class Lines {
  endOffset = 0
  decodedBytes = 0
  private pending: Buffer = Buffer.alloc(0)
  private pendingLength = 0
  private readonly hash = createHash('sha256')
  private readonly previousHash = createHash('sha256')
  private tail: { line: string; bytes: number }[] = []
  private tailStart = 0
  private tailSize = 0

  constructor(private readonly onLine: (line: string, endOffset: number) => void, private readonly verifyOffset?: number) {}

  accept(chunk: Buffer): void {
    this.decodedBytes += chunk.length
    if (this.decodedBytes > MAX_DECODED_BYTES) fail('exceeds the 1 GiB decoded limit')
    let start = 0
    while (start < chunk.length) {
      const lf = chunk.indexOf(10, start)
      const end = lf === -1 ? chunk.length : lf + 1
      const part = chunk.subarray(start, end)
      if (this.pendingLength + part.length > MAX_LINE_BYTES) fail('exceeds the 32 MiB JSONL line limit')
      if (this.pendingLength === 0 && lf !== -1) {
        this.commit(part)
      } else {
        const length = this.pendingLength + part.length
        if (length > this.pending.length) {
          const next = Buffer.allocUnsafe(Math.min(MAX_LINE_BYTES, Math.max(CHUNK_BYTES, length, this.pending.length * 2)))
          this.pending.copy(next, 0, 0, this.pendingLength)
          this.pending = next
        }
        part.copy(this.pending, this.pendingLength)
        this.pendingLength = length
        if (lf !== -1) {
          this.commit(this.pending.subarray(0, this.pendingLength))
          this.pendingLength = 0
        }
      }
      start = end
    }
  }

  private commit(raw: Buffer): void {
    if (!isUtf8(raw)) fail('contains invalid UTF-8 in a complete JSONL line')
    this.hash.update(raw)
    if (this.verifyOffset !== undefined && this.endOffset < this.verifyOffset) {
      this.previousHash.update(raw.subarray(0, Math.min(raw.length, this.verifyOffset - this.endOffset)))
    }
    this.endOffset += raw.length
    const textEnd = raw.length > 1 && raw[raw.length - 2] === 13 ? raw.length - 2 : raw.length - 1
    const line = raw.toString('utf8', 0, textEnd)
    this.onLine(line, this.endOffset)
    if (raw.length > TAIL_BYTES) {
      this.tail = []
      this.tailStart = 0
      this.tailSize = 0
      return
    }
    this.tail.push({ line, bytes: raw.length })
    this.tailSize += raw.length
    while (this.tailSize > TAIL_BYTES) {
      const entry = this.tail[this.tailStart++]!
      this.tailSize -= entry.bytes
      entry.line = ''
    }
    if (this.tailStart > 1024 && this.tailStart * 2 > this.tail.length) {
      this.tail = this.tail.slice(this.tailStart)
      this.tailStart = 0
    }
  }

  finish(): Pick<CodexLogSnapshot, 'endOffset' | 'fingerprint' | 'previousFingerprint' | 'tailLines'> {
    return {
      endOffset: this.endOffset,
      fingerprint: this.hash.digest('hex'),
      previousFingerprint: this.verifyOffset !== undefined && this.endOffset >= this.verifyOffset
        ? this.previousHash.digest('hex') : undefined,
      tailLines: this.tail.slice(this.tailStart).map(entry => entry.line)
    }
  }
}

function checkSnapshot(initial: BigIntStats, current: BigIntStats): void {
  if (!current.isFile() || identity(initial) !== identity(current) || current.size < initial.size) {
    fail('changed during the scan')
  }
  if (current.size === initial.size && (current.mtimeNs !== initial.mtimeNs || current.ctimeNs !== initial.ctimeNs)) {
    fail('changed during the scan')
  }
}

/** Callbacks are provisional: callers must commit only after this promise succeeds. */
export async function scanCodexLog(
  file: DiscoveredFile,
  onLine: (line: string, endOffset: number) => void,
  verifyOffset?: number
): Promise<CodexLogSnapshot> {
  let handle: FileHandle | undefined
  try {
    if (verifyOffset !== undefined && (!Number.isSafeInteger(verifyOffset) || verifyOffset < 0)) {
      fail('has an invalid verification offset')
    }
    const compressed = file.path.endsWith('.jsonl.zst')
    if (!compressed && !file.path.endsWith('.jsonl')) fail('has an unsupported file format')
    handle = await open(file.path, 'r')
    const initial = await handle.stat({ bigint: true })
    if (!initial.isFile()) fail('is not a regular file')
    if (initial.size > BigInt(MAX_INPUT_BYTES)) fail('exceeds the 512 MiB input limit')
    const size = Number(initial.size)
    const reader = new PhysicalReader(handle, size)
    const layout = compressed ? await scanFrames(reader) : undefined
    const sourceFingerprint = await reader.finish()
    checkSnapshot(initial, await handle.stat({ bigint: true }))
    checkSnapshot(initial, await stat(file.path, { bigint: true }))
    const lines = new Lines(onLine, verifyOffset)
    const consumed = createHash('sha256')
    let physicalPosition = 0
    if (layout) {
      for (const frame of layout.frames) {
        for await (const part of chunks(handle, physicalPosition, frame.start)) consumed.update(part)
        const before = lines.decodedBytes
        // A fresh native decoder is required: the stream stops after its first frame.
        const decoder = createZstdDecompress({
          chunkSize: CHUNK_BYTES,
          params: { [constants.ZSTD_d_windowLogMax]: 27 }
        })
        const sink = new Writable({
          write(chunk: Buffer, _encoding, done) {
            try { lines.accept(chunk); done() } catch (error) { done(error as Error) }
          }
        })
        try {
          await pipeline(Readable.from(chunks(handle, frame.start, frame.end, consumed), { objectMode: false }), decoder, sink)
        } catch (error) {
          if (error instanceof CodexLogError) throw error
          fail('failed Zstandard integrity validation or could not be read')
        }
        if (frame.contentSize !== undefined && lines.decodedBytes - before !== frame.contentSize) {
          fail('failed Zstandard content-size validation')
        }
        physicalPosition = frame.end
      }
      for await (const part of chunks(handle, physicalPosition, size)) consumed.update(part)
    } else {
      for await (const chunk of chunks(handle, 0, size, consumed)) lines.accept(chunk)
    }
    if (consumed.digest('hex') !== sourceFingerprint) fail('changed during the scan')
    checkSnapshot(initial, await handle.stat({ bigint: true }))
    checkSnapshot(initial, await stat(file.path, { bigint: true }))
    const verified = createHash('sha256')
    for await (const chunk of chunks(handle, 0, size)) verified.update(chunk)
    if (verified.digest('hex') !== sourceFingerprint) fail('changed during the scan')
    checkSnapshot(initial, await handle.stat({ bigint: true }))
    checkSnapshot(initial, await stat(file.path, { bigint: true }))
    return {
      ...lines.finish(),
      physicalEndOffset: layout?.physicalEndOffset ?? lines.endOffset,
      size,
      mtimeMs: Number(initial.mtimeNs) / 1_000_000,
      identity: identity(initial)
    }
  } catch (error) {
    if (error instanceof CodexLogError) throw error
    return fail('could not be read')
  } finally {
    if (handle) {
      try { await handle.close() } catch { fail('could not be closed after reading') }
    }
  }
}

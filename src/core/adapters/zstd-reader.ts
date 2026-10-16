import { zstdDecompressSync } from 'node:zlib'

export const MAX_DSH_SOURCE_BYTES = 32 * 1024 * 1024
export const MAX_DSH_DECODED_BYTES = 64 * 1024 * 1024
const MAX_FRAME_OUTPUT_BYTES = 16 * 1024 * 1024
const MAX_FRAMES = 100_000
const MAGIC = 0xfd2fb528

export interface DecodedZstdFrame {
  start: number
  end: number
  data: Buffer
}

/** Only complete physical frames are admitted; native zlib accepts some torn trailers. */
export function* decodeDshFrames(source: Buffer): Generator<DecodedZstdFrame> {
  if (source.length > MAX_DSH_SOURCE_BYTES) throw new Error('DSH compressed file exceeds the 32 MiB read limit')
  let offset = 0
  let decoded = 0
  let frames = 0
  while (offset < source.length) {
    if (++frames > MAX_FRAMES) throw new Error('DSH file exceeds the frame-count limit')
    const start = offset
    if (source.length - offset < 4) return
    if (source.readUInt32LE(offset) !== MAGIC) throw new Error('DSH file has invalid Zstandard frame magic')
    offset += 4
    if (offset === source.length) return
    const descriptor = source[offset++]!
    if ((descriptor & 0x18) !== 0) throw new Error('DSH Zstandard frame has reserved header bits')
    const singleSegment = (descriptor & 0x20) !== 0
    const dictionaryFlag = descriptor & 3
    const contentSizeFlag = descriptor >>> 6
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const headerBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (source.length - offset < headerBytes) return
    if (!singleSegment) {
      const window = source[offset]!
      const base = 2 ** (10 + (window >>> 3))
      if (base + (base / 8) * (window & 7) > MAX_FRAME_OUTPUT_BYTES) {
        throw new Error('DSH Zstandard window exceeds the 16 MiB memory limit')
      }
    }
    if (contentSizeBytes > 0) {
      const position = offset + (singleSegment ? 0 : 1) + dictionaryBytes
      const size = contentSizeBytes === 8
        ? source.readBigUInt64LE(position)
        : BigInt(source.readUIntLE(position, contentSizeBytes) + (contentSizeBytes === 2 ? 256 : 0))
      if (size > BigInt(MAX_FRAME_OUTPUT_BYTES)) throw new Error('DSH Zstandard frame exceeds the decoded-size limit')
    }
    offset += headerBytes
    for (;;) {
      if (source.length - offset < 3) return
      const block = source.readUIntLE(offset, 3)
      offset += 3
      const blockType = (block >>> 1) & 3
      if (blockType === 3) throw new Error('DSH Zstandard frame has a reserved block type')
      const blockSize = block >>> 3
      if (blockSize > 128 * 1024) throw new Error('DSH Zstandard block exceeds the format limit')
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (source.length - offset < payloadBytes) return
      offset += payloadBytes
      if ((block & 1) !== 0) break
    }
    if ((descriptor & 4) !== 0) {
      if (source.length - offset < 4) return
      offset += 4
    }
    if (decoded >= MAX_DSH_DECODED_BYTES) throw new Error('DSH decoded log exceeds the 64 MiB limit')
    let data: Buffer
    try {
      data = zstdDecompressSync(source.subarray(start, offset), {
        maxOutputLength: Math.min(MAX_FRAME_OUTPUT_BYTES, MAX_DSH_DECODED_BYTES - decoded)
      })
    } catch {
      throw new Error('DSH Zstandard frame failed integrity validation or exceeded the decoded-size limit')
    }
    decoded += data.length
    yield { start, end: offset, data }
  }
}

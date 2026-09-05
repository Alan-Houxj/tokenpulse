/**
 * 适配器共享工具：路径规范化、目录遍历、jsonl 增量读取。
 */
import { readdirSync, statSync, openSync, readSync, closeSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** 规范化为稳定的文件键：正斜杠 + Windows 盘符小写 */
export function normalizePathKey(p: string): string {
  const abs = resolve(p)
  const fwd = abs.replace(/\\/g, '/')
  return /^\/[A-Z]\//.test(fwd.slice(0, 3)) || /^[A-Z]:\//.test(fwd)
    ? fwd.slice(0, 1).toLowerCase() + fwd.slice(1)
    : fwd
}

export function homePath(...segments: string[]): string {
  return join(homedir(), ...segments)
}

export interface FileStatInfo {
  path: string
  size: number
  mtimeMs: number
}

/** 递归遍历目录，收集匹配后缀的文件（排除常见的临时/锁文件） */
export function walkFiles(root: string, test: (name: string) => boolean): FileStatInfo[] {
  const out: FileStatInfo[] = []
  const queue: string[] = [root]
  while (queue.length > 0) {
    const dir = queue.shift()!
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const ent of entries) {
      const full = join(dir, ent.name)
      if (ent.isDirectory()) {
        queue.push(full)
      } else if (ent.isFile() && test(ent.name)) {
        try {
          const st = statSync(full)
          out.push({ path: normalizePathKey(full), size: st.size, mtimeMs: st.mtimeMs })
        } catch {
          /* 文件消失则跳过 */
        }
      }
    }
  }
  return out
}

export function statFile(path: string): FileStatInfo | undefined {
  try {
    const st = statSync(path)
    return { path: normalizePathKey(path), size: st.size, mtimeMs: st.mtimeMs }
  } catch {
    return undefined
  }
}

export function dirExists(p: string): boolean {
  try {
    return existsSync(p) && statSync(p).isDirectory()
  } catch {
    return false
  }
}

export interface IncrementalLines {
  lines: string[]
  /** 消费到的字节位（不含未完成的尾行） */
  endOffset: number
}

/**
 * 从 fromOffset 起增量读取 jsonl 行。
 * 只返回「以换行结束」的完整行，残缺尾行留到下次（append 写入的常态）。
 * 文件被截断/轮换（当前大小 < offset）时自动从 0 重读。
 */
export function readLinesIncremental(path: string, fromOffset: number): IncrementalLines {
  const st = statFile(path)
  if (!st) return { lines: [], endOffset: fromOffset }
  let start = fromOffset
  if (st.size < fromOffset) start = 0 // 截断/轮换
  const length = st.size - start
  if (length <= 0) return { lines: [], endOffset: fromOffset }

  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(length)
    let read = 0
    while (read < length) {
      const n = readSync(fd, buf, read, length - read, start + read)
      if (n === 0) break
      read += n
    }
    const text = buf.subarray(0, read).toString('utf8')
    const lastNl = text.lastIndexOf('\n')
    if (lastNl === -1) return { lines: [], endOffset: fromOffset } // 没有完整行
    const complete = text.slice(0, lastNl)
    const lines = complete.split('\n').map((l) => l.replace(/\r$/, ''))
    return { lines, endOffset: start + Buffer.byteLength(complete, 'utf8') + 1 }
  } finally {
    closeSync(fd)
  }
}

/** 安全解析一行 JSON；坏行（Agent 写入中断的常见现场）直接丢弃 */
export function parseJsonLine<T>(line: string): T | undefined {
  const t = line.trim()
  if (!t) return undefined
  try {
    return JSON.parse(t) as T
  } catch {
    return undefined
  }
}

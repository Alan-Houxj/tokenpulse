/**
 * Agent 执行驱动：spawn 一个 headless CLI，把输入文本交给它，收回完整 stdout。
 * 契约极简——输入文本 → 输出文本，中间过程黑盒（不解析流式事件，规避 CLI schema 漂移）。
 * 输入走 stdin（默认）或模板 {prompt} 替换；codex 的 banner 头做确定性裁剪。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import type { Participant, RunResult } from './types'

export interface RunHandle {
  kill: () => void
  promise: Promise<RunResult>
}

/**
 * 杀整棵进程树：Windows 上 shell:true 只杀 cmd.exe，孙进程仍占着 stdio
 * 导致 close 永不触发，必须 taskkill /T /F。
 */
function killTree(child: ChildProcess): void {
  if (process.platform === 'win32' && child.pid != null) {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
  } else {
    child.kill('SIGKILL')
  }
}

/** 渲染命令：含 {prompt} 则替换（调用方保证转义）；否则命令原样、输入走 stdin */
export function renderCommand(participant: Pick<Participant, 'command'>, prompt: string): string {
  return participant.command.includes('{prompt}')
    ? participant.command.replaceAll('{prompt}', prompt)
    : participant.command
}

/** 是否走 stdin（模板里没有 {prompt} 占位符即 stdin 模式） */
export function usesStdin(command: string): boolean {
  return !command.includes('{prompt}')
}

/**
 * 裁掉 codex exec 输出头部的横幅（model/provider/… 直到 '--------' 行）与
 * 'user' 回显块（回显的输入提示词，直到下一个空行）。纯确定性文本处理。
 */
export function trimBanner(out: string): string {
  const lines = out.split('\n')
  const idx = lines.findIndex((l) => /^-{6,}\s*$/.test(l.trim()))
  if (idx === -1 || idx > 20) return out
  let i = idx + 1
  // 跳过 user 回显行 + 紧随的回显内容块（连续非空行）
  if (/^\s*user\s*$/.test(lines[i] ?? '')) {
    i++
    while (i < lines.length && lines[i]!.trim() !== '') i++
    while (i < lines.length && lines[i]!.trim() === '') i++
  }
  return lines.slice(i).join('\n').trimStart()
}

/** 运行一个参与者：cwd 为房间工作区，超时强杀。 */
export function runAgent(
  participant: Participant,
  prompt: string,
  opts: { cwd: string; timeoutMs: number }
): RunHandle {
  const cmd = renderCommand(participant, prompt)
  const child = spawn(cmd, {
    shell: true,
    cwd: opts.cwd,
    windowsHide: true,
    env: { ...process.env, NO_COLOR: '1' }
  })

  let stdout = ''
  let stderr = ''
  let timedOut = false
  let settled = false
  child.stdout.on('data', (d: Buffer) => {
    stdout += d.toString()
    // 输出异常膨胀视为失控（如死循环 cat 大文件），防止内存爆掉
    if (stdout.length > 4 * 1024 * 1024) child.kill()
  })
  child.stderr.on('data', (d: Buffer) => {
    stderr += d.toString()
  })

  const timer = setTimeout(() => {
    timedOut = true
    killTree(child)
  }, Math.max(1000, opts.timeoutMs))

  if (usesStdin(participant.command)) {
    child.stdin.on('error', () => {
      /* 命令不读 stdin 时 EPIPE 可忽略 */
    })
    child.stdin.write(prompt)
    child.stdin.end()
  }

  const promise = new Promise<RunResult>((resolve) => {
    const finish = (code: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ stdout, stderr, code, timedOut })
    }
    child.on('close', finish)
    child.on('error', (e) => {
      stderr += String(e)
      finish(null)
    })
  })

  return { kill: () => killTree(child), promise }
}

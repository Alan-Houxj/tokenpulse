/**
 * Agent 执行驱动：按 AgentKind 构建命令，spawn headless 进程，
 * 输入文本（stdin 或参数）→ 最终输出整包收回 + 捕获原生 session id。
 * 契约极简——中间过程黑盒，不解析流式事件（规避 CLI schema 漂移）。
 * 红线：只调用各 Agent 现成入口，不做任何改造。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Participant, RunResult } from './types'
import type { AgentId } from '../model/types'

export interface RunHandle {
  kill: () => void
  promise: Promise<RunResult>
}

export interface CommandSpec {
  /** spawn 的命令（executable + args 数组，不经 shell，无转义问题） */
  args: string[]
  /** true = 拼好的输入文本经 stdin 管入；false = 文本作为最后一个参数 */
  stdinMode: boolean
}

/** ZCode CLI 的候选安装路径 */
export function findZcodeCli(): string | null {
  const candidates = [
    join('C:', 'Program Files', 'ZCode', 'resources', 'glm', 'zcode.cjs'),
    join(process.env['LOCALAPPDATA'] ?? '', 'Programs', 'ZCode', 'resources', 'glm', 'zcode.cjs')
  ]
  for (const c of candidates) if (existsSync(c)) return c
  return null
}

/** ZCode headless 就绪 = CLI 存在且 ~/.zcode/cli/config.json 已配置 provider */
export function zcodeHeadlessReady(homeDir: string): { ready: boolean; cliPath: string | null; reason?: string } {
  const cliPath = findZcodeCli()
  if (!cliPath) return { ready: false, cliPath: null, reason: '未找到 ZCode CLI（需要桌面版安装）' }
  try {
    const cfg = JSON.parse(readFileSync(join(homeDir, '.zcode', 'cli', 'config.json'), 'utf8'))
    if (!cfg || typeof cfg !== 'object' || !('provider' in cfg)) {
      return {
        ready: false,
        cliPath,
        reason: 'ZCode CLI 缺少模型配置（~/.zcode/cli/config.json 需要 provider 段）'
      }
    }
    return { ready: true, cliPath }
  } catch {
    return {
      ready: false,
      cliPath,
      reason: 'ZCode CLI 缺少模型配置（~/.zcode/cli/config.json 需要 provider 段）'
    }
  }
}

/** 各 Agent 的推理强度 → CLI 参数值（空 = 不传） */
function reasoningArg(kind: AgentId, level: string | undefined): string | null {
  if (!level || level === 'default') return null
  // codex: minimal/low/medium/high/xhigh；zcode 定义 low/max/high 但 headless 暂不支持
  if (kind === 'codex') return level
  return null
}

/** 构建某 Agent 一次运行的命令（含会话恢复与模型/强度覆盖） */
export function buildCommand(
  kind: AgentId,
  opts: { sessionId?: string; model?: string; reasoning?: string; zcodeCli?: string | null }
): CommandSpec {
  switch (kind) {
    case 'codex': {
      // resume 时沙箱等 flag 沿用；prompt 经 stdin（-）
      const args = opts.sessionId
        ? ['codex', 'exec', 'resume', opts.sessionId]
        : ['codex', 'exec', '-s', 'workspace-write', '--skip-git-repo-check']
      if (opts.model) args.push('-m', opts.model)
      const ra = reasoningArg(kind, opts.reasoning)
      if (ra) args.push('-c', `model_reasoning_effort="${ra}"`)
      args.push('-')
      return { args, stdinMode: true }
    }
    case 'zcode': {
      // zcode --prompt 收参数；不经 shell 直传避免转义问题
      const args = [process.execPath, opts.zcodeCli ?? findZcodeCli() ?? 'zcode.cjs']
      if (opts.sessionId) args.push('--resume', opts.sessionId)
      if (opts.model) args.push('--model', opts.model)
      args.push('--prompt')
      return { args, stdinMode: false }
    }
    case 'claude-code': {
      const args = ['claude', '-p']
      if (opts.sessionId) args.push('--resume', opts.sessionId)
      if (opts.model) args.push('--model', opts.model)
      return { args, stdinMode: true }
    }
    case 'gemini-cli': {
      const args = ['gemini']
      if (opts.model) args.push('-m', opts.model)
      return { args, stdinMode: true }
    }
    case 'qwen': {
      const args = ['qwen']
      if (opts.model) args.push('--model', opts.model)
      return { args, stdinMode: true }
    }
    default: {
      // 穷尽性保护：AgentId 新增成员时编译期即报错
      const never: never = kind satisfies never
      throw new Error(`不支持的 Agent：${String(never)}`)
    }
  }
}

/** 从原始输出捕获原生 session id（各 Agent 的确定性标记） */
export function captureSessionId(kind: AgentId, raw: string): string | undefined {
  if (kind === 'codex') {
    const m = /session id:\s*([0-9a-f-]{36})/i.exec(raw)
    return m?.[1]
  }
  if (kind === 'zcode') {
    const m = /(sess_[0-9a-f-]{36})/i.exec(raw)
    return m?.[1]
  }
  if (kind === 'claude-code') {
    const m = /"session_id"\s*:\s*"([^"]+)"/.exec(raw)
    return m?.[1]
  }
  return undefined
}

/**
 * 裁掉 codex exec 输出头部的横幅（model/provider/… 直到 '--------' 行）与
 * 'user' 回显块。纯确定性文本处理。
 */
export function trimBanner(out: string): string {
  const lines = out.split('\n')
  const idx = lines.findIndex((l) => /^-{6,}\s*$/.test(l.trim()))
  if (idx === -1 || idx > 20) return out
  let i = idx + 1
  if (/^\s*user\s*$/.test(lines[i] ?? '')) {
    i++
    while (i < lines.length && lines[i]!.trim() !== '') i++
    while (i < lines.length && lines[i]!.trim() === '') i++
  }
  return lines.slice(i).join('\n').trimStart()
}

/** prompt 规模粗估（tokens）：CJK ~1.6 字符/token，拉丁 ~4 字符/token */
export function estimatePromptTokens(text: string): number {
  let cjk = 0
  let other = 0
  for (const ch of text) {
    if (/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch)) cjk++
    else other++
  }
  return Math.ceil(cjk / 1.6 + other / 4)
}

/**
 * 杀整棵进程树：Windows 上 shell 启动的子进程，孙进程仍占 stdio 导致
 * close 永不触发，必须 taskkill /T /F。
 */
function killTree(child: ChildProcess): void {
  if (process.platform === 'win32' && child.pid != null) {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
  } else {
    child.kill('SIGKILL')
  }
}

/** 底层进程执行：spawn 命令数组 + stdin/参数输入 + 超时强杀（测试可直接注入任意命令） */
export function runSpec(
  spec: CommandSpec,
  prompt: string,
  opts: { cwd: string; timeoutMs: number; captureKind?: AgentId }
): RunHandle {
  const child = spawn(spec.args[0]!, spec.args.slice(1), {
    cwd: opts.cwd,
    windowsHide: true,
    env: { ...process.env, NO_COLOR: '1' },
    shell: false
  })

  let stdout = ''
  let stderr = ''
  let timedOut = false
  let settled = false
  child.stdout.on('data', (d: Buffer) => {
    stdout += d.toString()
    if (stdout.length > 8 * 1024 * 1024) killTree(child) // 失控输出保护
  })
  child.stderr.on('data', (d: Buffer) => {
    stderr += d.toString()
  })

  const timer = setTimeout(() => {
    timedOut = true
    killTree(child)
  }, Math.max(1000, opts.timeoutMs))

  if (spec.stdinMode) {
    child.stdin.on('error', () => {
      /* 命令不读 stdin 时 EPIPE 可忽略 */
    })
    child.stdin.write(prompt)
    child.stdin.end()
  } else {
    child.stdin.end()
  }

  const promise = new Promise<RunResult>((resolve) => {
    const finish = (code: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({
        stdout,
        stderr,
        code,
        timedOut,
        sessionId: opts.captureKind ? captureSessionId(opts.captureKind, stdout + stderr) : undefined
      })
    }
    child.on('close', finish)
    child.on('error', (e) => {
      stderr += String(e)
      finish(null)
    })
  })

  return { kill: () => killTree(child), promise }
}

/** 运行一个参与者：按 AgentKind 构建命令并执行（cwd 为房间工作区，超时强杀） */
export function runAgent(
  participant: Participant,
  prompt: string,
  opts: { cwd: string; timeoutMs: number; sessionId?: string; zcodeCli?: string | null }
): RunHandle {
  const spec = buildCommand(participant.agentKind, {
    sessionId: opts.sessionId,
    model: participant.model,
    reasoning: participant.reasoning,
    zcodeCli: opts.zcodeCli
  })
  // 参数模式：prompt 作为最后一个参数（zcode --prompt <text>）
  if (!spec.stdinMode) spec.args.push(prompt)
  return runSpec(spec, prompt, { cwd: opts.cwd, timeoutMs: opts.timeoutMs, captureKind: participant.agentKind })
}

/**
 * infra-process —— **本机命令执行**的最小适配器。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么它在 infra 而不是某个 domain 里
 * ══════════════════════════════════════════════════════════════════════
 * `child_process` / `fs` 是平台能力，不是业务。任何"调用外部 CLI"的域
 * （密码域的 Bitwarden、未来的导入器/转换器）都应该只声明自己需要的端口，
 * 由 main 把本适配器注入进去 —— 域代码里出现 `require('child_process')`
 * 就意味着它再也无法在纯函数测试/沙箱里跑。
 *
 * 契约（调用方按这个契约注入，不关心底层是 execFile 还是别的实现）：
 *   resolveCommand(name): Promise<string|null>   PATH 中可执行文件的绝对路径
 *   exists(filePath):     Promise<boolean>       文件存在且可执行（Windows 只看存在）
 *   run(command, args, { env, timeoutMs, cwd, stdin }): Promise<{ stdout, stderr }>
 *
 * `stdin` 用于"必须从标准输入读密文"的 CLI（例如 1Password 的
 * `op signin --raw`）——它把主密码从 stdin 读走，从而**不出现在进程列表**里。
 * 不传 `stdin` 时行为与以前完全一致（立刻关闭 stdin，走非交互模式）。
 *
 * `run` 失败时 reject 一个 Error：message = stderr 首段（便于直接展示），
 * 并附带 `{ code, stdout, stderr, timedOut }`，调用方据此区分"未登录/锁定/超时"。
 */

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export interface ProcessRunOptions {
  env?: Record<string, string>
  timeoutMs?: number
  cwd?: string
  stdin?: string
  signal?: AbortSignal
  windowsVerbatimArguments?: boolean
}
export interface ProcessRunResult { stdout: string; stderr: string }
export interface ProcessRunnerOptions {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  defaultTimeoutMs?: number
  maxBuffer?: number
}
export interface ProcessRunError extends Error {
  code?: string | number
  stdout: string
  stderr: string
  timedOut: boolean
}
export interface ProcessRunner {
  run(command: string, args?: readonly string[], options?: ProcessRunOptions): Promise<ProcessRunResult>
  resolveCommand(name: string): Promise<string | null>
  exists(filePath: string): Promise<boolean>
  platform: NodeJS.Platform
}

export function createProcessRunner(options: ProcessRunnerOptions = {}): ProcessRunner {
  const platform = options.platform || process.platform
  const baseEnv = options.env || process.env
  const defaultTimeoutMs = options.defaultTimeoutMs || 15000
  const maxBuffer = options.maxBuffer || 16 * 1024 * 1024
  const isWindows = platform === 'win32'

  /**
   * @param {string} command
   * @param {string[]} args
   * @param {{ env?: Record<string,string>, timeoutMs?: number, cwd?: string, stdin?: string }} [opts]
   * @returns {Promise<{ stdout: string, stderr: string }>}
   */
  function runRaw(command: string, args: readonly string[] = [], opts: ProcessRunOptions = {}): Promise<ProcessRunResult> {
    return new Promise((resolve, reject) => {
      const child = execFile(
        command,
        Array.isArray(args) ? args : [],
        {
          timeout: opts.timeoutMs || defaultTimeoutMs,
          windowsHide: true,
          maxBuffer,
          cwd: opts.cwd,
          signal: opts.signal,
          windowsVerbatimArguments: opts.windowsVerbatimArguments,
          env: opts.env ? { ...baseEnv, ...opts.env } : baseEnv
        },
        (error, stdout, stderr) => {
          const out = String(stdout == null ? '' : stdout)
          const err = String(stderr == null ? '' : stderr)
          if (error) {
            const wrapped = new Error(err.trim() || error.message || '命令执行失败') as ProcessRunError
            wrapped.code = error.code == null ? undefined : error.code
            wrapped.stdout = out
            wrapped.stderr = err
            wrapped.timedOut = error.killed === true
            reject(wrapped)
            return
          }
          resolve({ stdout: out, stderr: err })
        }
      )
      // 有些 CLI（bw）在 stdin 是打开的管道时会等待输入，必须立刻关闭；
      // 另一些（op signin）**要求**从 stdin 读走密文。两者用同一个出口：
      // 有 `opts.stdin` 就写入后关闭，没有就空关闭。
      if (child.stdin) {
        // 子进程提前退出时写入会 EPIPE，吞掉即可（错误仍以 exit code 为准）
        child.stdin.on('error', () => {})
        try {
          child.stdin.end(opts.stdin == null ? undefined : String(opts.stdin))
        } catch (_) {
          try { child.stdin.destroy() } catch (__) { /* 已关闭 */ }
        }
      }
    })
  }

  function cmdLineArg(value: unknown): string {
    const text = String(value)
    if (/[\r\n\u0000%]/.test(text)) throw new Error('命令参数包含非法的命令解释字符')
    return `"${text.replace(/"/g, '""')}"`
  }

  async function run(command: string, args: readonly string[] = [], opts: ProcessRunOptions = {}): Promise<ProcessRunResult> {
    const binary = String(command || '').trim()
    if (!binary) throw new Error('命令不能为空')
    const resolved = path.isAbsolute(binary) ? binary : (await resolveCommand(binary)) || binary
    if (isWindows && /\.(?:cmd|bat)$/i.test(resolved)) {
      const comspec = String(baseEnv.ComSpec || baseEnv.COMSPEC || 'cmd.exe')
      // .cmd/.bat 不能被 execFile 直接启动。参数逐项加引号后交给 cmd /c；
      // 不接受换行 / 百分号等会触发命令解释的字符。
      const line = [resolved, ...(Array.isArray(args) ? args : [])].map(cmdLineArg).join(' ')
      return runRaw(comspec, ['/d', '/s', '/c', `"${line}"`], {
        ...opts,
        windowsVerbatimArguments: true
      })
    }
    return runRaw(resolved, Array.isArray(args) ? args : [], opts)
  }

  /**
   * 在 PATH 中查找可执行文件。
   * Windows 用 `where`（可能返回多行，取第一条），其余用 `which`。
   */
  async function resolveCommand(name: unknown): Promise<string | null> {
    const binary = String(name || '').trim()
    if (!binary) return null
    try {
      const { stdout } = await runRaw(isWindows ? 'where' : 'which', [binary], { timeoutMs: 5000 })
      const first = String(stdout)
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)[0]
      return first || null
    } catch (_) {
      return null
    }
  }

  /**
   * 本地随包工具（例如用户拖进 tools/ 的 bw.exe）是否可用。
   * Windows 没有可靠的 X_OK 语义，只判存在。
   */
  async function exists(filePath: string): Promise<boolean> {
    if (!filePath) return false
    try {
      await fs.promises.access(filePath, isWindows ? fs.constants.F_OK : fs.constants.X_OK)
      return true
    } catch (_) {
      return false
    }
  }

  return { run, resolveCommand, exists, platform }
}

export default { createProcessRunner }

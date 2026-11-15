#!/usr/bin/env node
'use strict'

/**
 * Hira CLI —— 任意 Agent 产品的本机桥接器。
 *
 * 只需要 Node.js；不依赖 npm 包。它读取 Hira 写入 ~/.hira/cli/runtime.json 的
 * 随机令牌，通过 127.0.0.1 上的 JSON-RPC 面提交后台浏览与自然语言任务。
 */

const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const CLI_VERSION = '1.0.0'
const CLIENT_HEADER = `hira-cli/${CLI_VERSION}`
const DEFAULT_TIMEOUT_MS = 120_000
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024

const HELP = `Hira CLI ${CLI_VERSION}

用法：
  hira doctor
  hira open <url> [--context daily] [--json]
  hira read [url...] [--context daily] [--max-chars 20000] [--json]
  hira search <关键词> [--engine "https://.../?q={query}"] [--json]
  hira click <selector> --allow-actions
  hira click --text "按钮文字" --allow-actions
  hira fill <selector> <文字> --allow-actions [--submit]
  hira scroll [up|down|top|bottom] [--amount 800]
  hira screenshot [url] [--out ./page.png]
  hira contexts
  hira close [--context daily]

  hira run "<自然语言任务>" [--wait] [--model provider:model] [--json]
  hira task status <taskId>
  hira task result <taskId> [--json]
  hira task cancel <taskId>
  hira task list

  hira setup
  hira install [--no-path]
  hira agent install [--target codex|claude|all]
  hira guide [--json]
  hira rpc <method> '<json-params>'

说明：
  · Hira 必须正在运行；CLI 自己不会另起第二套浏览器。
  · open/read/search/scroll/screenshot 是只读动作。
  · click/fill 只有在用户已明确授权时加 --allow-actions。
  · --json 输出稳定的机器可读结构，Agent 集成应始终使用它。
`

const GUIDE = {
  service: 'hira-cli',
  protocol: 1,
  summary: '通过本机 Hira 后台浏览器搜索、阅读、点击、填写、截图并把结果交付给任意 Agent。',
  prerequisites: ['Hira 正在运行', 'Hira 已配置可用模型（使用 hira run 时）'],
  rules: [
    '先运行 hira doctor --json；state=ready 后再执行任务。',
    '机器调用始终加 --json，并直接读取返回的 data。',
    '只读动作可直接执行；click/fill 仅在用户明确要求且授权后加 --allow-actions。',
    '需要多个来源时优先 hira read URL1 URL2 ...，不要伪造网页正文。',
    '自然语言任务优先 hira run "<完整任务>" --wait --json；低层命令用于外部 Agent 自己编排。',
    '任务耗时超过等待窗口时，保存 taskId，之后用 hira task result <taskId> --json 取结果。'
  ],
  examples: [
    {
      intent: '追踪今日 AI 更新',
      command: 'hira run "阅读以下网站今天最相关的 AI 更新并写报告：https://... https://..." --wait --json'
    },
    {
      intent: '批量读网页但不抢当前标签',
      command: 'hira read https://example.com/a https://example.com/b --max-chars 30000 --json'
    },
    {
      intent: '在已登录后台填写筛选条件',
      command: 'hira fill "#search" "待处理订单" --allow-actions --json'
    }
  ],
  rpcMethods: [
    'doctor', 'browser.open', 'browser.read', 'browser.read_many', 'browser.search',
    'browser.click', 'browser.fill', 'browser.scroll', 'browser.screenshot',
    'browser.list', 'browser.close', 'task.start', 'task.status', 'task.result',
    'task.cancel', 'task.list'
  ]
}

class CliError extends Error {
  constructor(code, message, details) {
    super(message)
    this.name = 'CliError'
    this.code = code
    this.details = details || null
  }
}

function parseArgs(argv) {
  const flags = {
    json: false,
    wait: false,
    allowActions: false,
    submit: false,
    help: false,
    noPath: false
  }
  const values = {}
  const positionals = []
  const valueFlags = new Map([
    ['--context', 'context'],
    ['--max-chars', 'maxChars'],
    ['--max-links', 'maxLinks'],
    ['--engine', 'engine'],
    ['--out', 'out'],
    ['--model', 'model'],
    ['--reasoning', 'reasoning'],
    ['--timeout', 'timeout'],
    ['--target', 'target'],
    ['--bin', 'bin'],
    ['--text', 'text'],
    ['--selector', 'selector']
  ])
  const boolFlags = new Map([
    ['--json', 'json'],
    ['--wait', 'wait'],
    ['--allow-actions', 'allowActions'],
    ['--submit', 'submit'],
    ['--help', 'help'],
    ['-h', 'help'],
    ['--no-path', 'noPath']
  ])

  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i])
    if (boolFlags.has(arg)) {
      flags[boolFlags.get(arg)] = true
      continue
    }
    const eq = arg.indexOf('=')
    const key = eq > 0 ? arg.slice(0, eq) : arg
    if (valueFlags.has(key)) {
      const value = eq > 0 ? arg.slice(eq + 1) : argv[++i]
      if (value === undefined) throw new CliError('CLI_BAD_ARGS', `${key} 缺少值`)
      values[valueFlags.get(key)] = String(value)
      continue
    }
    if (arg.startsWith('--')) throw new CliError('CLI_BAD_ARGS', `未知参数：${arg}`)
    positionals.push(arg)
  }
  return { flags, values, positionals }
}

function runtimeCandidates() {
  const candidates = []
  if (process.env.HIRA_CLI_RUNTIME) candidates.push(path.resolve(process.env.HIRA_CLI_RUNTIME))
  candidates.push(path.join(os.homedir(), '.hira', 'cli', 'runtime.json'))
  if (process.env.LOCALAPPDATA) candidates.push(path.join(process.env.LOCALAPPDATA, 'Hira', 'cli', 'runtime.json'))
  return [...new Set(candidates)]
}

function tryReadRuntime() {
  for (const file of runtimeCandidates()) {
    try {
      const value = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (!value || value.service !== 'hira-cli') continue
      if (value.state === 'disabled') return { ...value, runtimeFile: file }
      if (!value.port || !value.token) continue
      return { ...value, runtimeFile: file }
    } catch (_) {}
  }
  return null
}

function readRuntime() {
  const runtime = tryReadRuntime()
  if (runtime && runtime.state === 'disabled') {
    throw new CliError(
      'HIRA_CLI_DISABLED',
      'hira-cli 插件处于停用状态。请启动 Hira，并在插件中心启用“Hira CLI · Agent 接入”后重试。'
    )
  }
  if (runtime) return runtime
  throw new CliError(
    'HIRA_NOT_RUNNING',
    '没有发现运行中的 Hira。请先启动 STAR Hira，再运行 hira doctor。'
  )
}

function postJson(host, port, token, payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false
    const succeed = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    const failWith = (error) => {
      if (settled) return
      settled = true
      reject(error)
    }
    const body = Buffer.from(JSON.stringify(payload))
    const req = http.request({
      hostname: host,
      port,
      path: '/v1/rpc',
      method: 'POST',
      agent: false,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'content-length': String(body.length),
        authorization: `Bearer ${token}`,
        'x-hira-client': CLIENT_HEADER,
        'cache-control': 'no-store'
      },
      timeout: timeoutMs || DEFAULT_TIMEOUT_MS
    }, (res) => {
      const chunks = []
      let received = 0
      res.on('data', (chunk) => {
        if (settled) return
        received += chunk.length
        if (received > MAX_RESPONSE_BYTES) {
          failWith(new CliError('CLI_RESPONSE_TOO_LARGE', 'Hira CLI 响应超过 16 MB'))
          res.destroy()
          return
        }
        chunks.push(chunk)
      })
      res.on('error', (error) => failWith(new CliError('CLI_BAD_RESPONSE', error instanceof Error ? error.message : String(error))))
      res.on('end', () => {
        if (settled) return
        const text = Buffer.concat(chunks).toString('utf8')
        let parsed
        try {
          parsed = text ? JSON.parse(text) : {}
        } catch (_) {
          failWith(new CliError('CLI_BAD_RESPONSE', `Hira 返回了非 JSON 响应（HTTP ${res.statusCode}）`))
          return
        }
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300 || parsed.ok !== true) {
          const error = parsed && parsed.error && typeof parsed.error === 'object' ? parsed.error : {}
          failWith(new CliError(
            String(error.code || `HTTP_${res.statusCode || 0}`),
            String(error.message || `Hira CLI 请求失败（HTTP ${res.statusCode || 0}）`)
          ))
          return
        }
        succeed(parsed.data)
      })
    })
    req.on('timeout', () => {
      failWith(new CliError('CLI_TIMEOUT', 'Hira 响应超时'))
      req.destroy()
    })
    req.on('error', (error) => {
      if (error instanceof CliError) failWith(error)
      else if (error && error.code === 'ECONNREFUSED') {
        failWith(new CliError('HIRA_NOT_RUNNING', 'Hira CLI 端口已关闭，请确认 STAR Hira 仍在运行。'))
      } else {
        failWith(new CliError('CLI_CONNECTION_FAILED', error instanceof Error ? error.message : String(error)))
      }
    })
    req.end(body)
  })
}

async function rpc(method, params, options) {
  let lastAuthError = null
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const runtime = readRuntime()
    try {
      return await postJson(
        runtime.host || '127.0.0.1',
        runtime.port,
        runtime.token,
        { method, params: params || {} },
        options && options.timeoutMs
      )
    } catch (error) {
      if (error instanceof CliError && error.code === 'CLI_UNAUTHORIZED' && attempt === 0) {
        lastAuthError = error
        continue
      }
      throw error
    }
  }
  throw lastAuthError || new CliError('CLI_UNAUTHORIZED', 'Hira CLI 令牌无效')
}

function emit(value, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
    return
  }
  if (typeof value === 'string') {
    process.stdout.write(`${value}\n`)
    return
  }
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

function humanRead(data) {
  const lines = []
  lines.push(`${data.title || '(无标题)'}`)
  lines.push(String(data.url || ''))
  if (data.truncated) lines.push('（正文超出限制，已截断）')
  if (data.text) {
    lines.push('')
    lines.push(String(data.text).slice(0, 20_000))
  }
  if (Array.isArray(data.links) && data.links.length) {
    lines.push('')
    lines.push('链接：')
    for (const link of data.links.slice(0, 30)) lines.push(`- ${link.text || link.url}: ${link.url}`)
  }
  return lines.join('\n')
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function taskTerminal(status) {
  return ['completed', 'failed', 'cancelled', 'interrupted'].includes(String(status))
}

async function waitForTask(taskId, timeoutMs, json) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    last = await rpc('task.status', { taskId })
    if (taskTerminal(last.status)) {
      const result = await rpc('task.result', { taskId })
      emit(result, json)
      if (result.status !== 'completed') process.exitCode = 2
      return result
    }
    await sleep(1_500)
  }
  throw new CliError(
    'CLI_TASK_TIMEOUT',
    `等待超时，任务仍在 Hira 内运行。稍后运行：hira task result ${taskId} --json`,
    { taskId, last }
  )
}

function homeFile(...parts) {
  return path.join(os.homedir(), ...parts)
}

function currentCliPath() {
  return path.resolve(__filename)
}

function skillTemplate(command) {
  return `---
name: hira-cli
description: 使用本机 Hira CLI 在后台浏览网页、搜索、读取、点击、填写和交付研究结果。用户说接入 Hira、使用 Hira CLI、/hira，或要求不抢浏览器地批量读网页时使用。
---

# Hira CLI

先运行：

\`\`\`powershell
${command} doctor --json
\`\`\`

只有返回 \`data.state === "ready"\` 才继续。Hira 未运行时，请让用户先启动 STAR Hira。

## 原则

- 所有调用加 \`--json\` 并读取 \`data\`。
- Hira 在隐藏窗口里复用自己的登录态，不会切用户标签或抢焦点。
- 只读动作可直接执行；\`click\` / \`fill\` 只有在用户当前请求明确授权时才加 \`--allow-actions\`。
- 需要多个来源时用 \`read URL1 URL2 ...\`；只基于实际读到的页面下结论，附来源 URL。
- 简单批读由你直接编排；完整自然语言任务可交给 \`run --wait\`，它复用 Hira 自己的 AI 与工具。

## 常用命令

\`\`\`powershell
${command} read https://example.com/a https://example.com/b --max-chars 30000 --json
${command} search "AI news today" --json
${command} open https://example.com --context research --json
${command} read --context research --max-links 80 --json
${command} click --text "下一页" --allow-actions --json
${command} fill "#query" "关键词" --allow-actions --json
${command} run "阅读这些网站今天最相关的更新并汇总" --wait --json
${command} task result <taskId> --json
\`\`\`

交付时先给结论，再给关键事实和来源。不要把工具过程写进最终答案。
`
}

function promptTemplate(command) {
  return `使用 Hira CLI 完成下面的任务。

先执行 \`${command} doctor --json\`。ready 后，优先调用：

\`${command} run "$ARGUMENTS" --wait --json\`

如果任务是外部 Agent 自己编排，则按需使用：

- \`${command} read <url...> --json\`
- \`${command} search "<query>" --json\`
- \`${command} click <selector> --allow-actions --json\`
- \`${command} fill <selector> "<text>" --allow-actions --json\`

Hira 在后台运行，不应切换用户当前标签或抢焦点。只根据实际读到的内容作答并保留来源 URL。写操作必须由用户当前请求明确授权。
`
}

function skillMetadata() {
  return `interface:
  display_name: "Hira CLI"
  short_description: "后台浏览网页、读取来源并交付研究结果"
  default_prompt: "使用 Hira CLI 完成后台浏览任务。"
policy:
  allow_implicit_invocation: true
`
}

function writeAgentFiles(target, command) {
  const installed = []
  const add = (file, body) => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, body, 'utf8')
    installed.push(file)
  }
  const which = target || 'all'
  if (which === 'codex' || which === 'all') {
    // Codex 的用户级 Skill 目录；自然语言触发由 description 负责。
    add(homeFile('.agents', 'skills', 'hira-cli', 'SKILL.md'), skillTemplate(command))
    add(homeFile('.agents', 'skills', 'hira-cli', 'agents', 'openai.yaml'), skillMetadata())
    // 自定义 Prompt 仍是 Codex 的 Slash Command 入口（/prompts:hira）。
    add(homeFile('.codex', 'prompts', 'hira.md'), promptTemplate(command))
  }
  if (which === 'claude' || which === 'all') {
    const body = `---
description: 使用 Hira CLI 在后台浏览网页并交付结果
argument-hint: <要完成的任务>
---

${promptTemplate(command)}`
    add(homeFile('.claude', 'commands', 'hira.md'), body)
  }
  if (which === 'generic' || which === 'all') {
    add(homeFile('.hira', 'agents', 'HIRA_CLI.md'), skillTemplate(command))
  }
  if (!['codex', 'claude', 'generic', 'all'].includes(which)) {
    throw new CliError('CLI_BAD_TARGET', 'target 只能是 codex / claude / generic / all')
  }
  return { command, files: installed }
}

function installCli(options) {
  const source = currentCliPath()
  const base = process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA || homeFile('.hira'), 'Hira')
    : homeFile('.local', 'share', 'hira')
  const cliDir = path.join(base, 'cli')
  const binDir = options.bin ? path.resolve(options.bin) : (
    process.platform === 'win32' ? path.join(base, 'bin') : homeFile('.local', 'bin')
  )
  fs.mkdirSync(cliDir, { recursive: true })
  fs.mkdirSync(binDir, { recursive: true })
  const installedCli = path.join(cliDir, 'hira.cjs')
  if (path.resolve(installedCli) !== source) fs.copyFileSync(source, installedCli)
  try { fs.chmodSync(installedCli, 0o755) } catch (_) {}

  let shim
  const runtime = tryReadRuntime()
  const electronPath = runtime && runtime.executablePath && fs.existsSync(String(runtime.executablePath))
    ? path.resolve(String(runtime.executablePath))
    : null
  if (process.platform === 'win32') {
    shim = path.join(binDir, 'hira.cmd')
    const command = electronPath
      ? `set "ELECTRON_RUN_AS_NODE=1"\r\n"${electronPath}" "${installedCli}" %*`
      : `node "${installedCli}" %*`
    fs.writeFileSync(shim, `@echo off\r\n${command}\r\n`, 'utf8')
  } else {
    shim = path.join(binDir, 'hira')
    const command = electronPath
      ? `ELECTRON_RUN_AS_NODE=1 exec "${electronPath.replace(/"/g, '\\"')}" "${installedCli.replace(/"/g, '\\"')}" "$@"`
      : `exec node "${installedCli.replace(/"/g, '\\"')}" "$@"`
    fs.writeFileSync(shim, `#!/bin/sh\n${command}\n`, 'utf8')
    try { fs.chmodSync(shim, 0o755) } catch (_) {}
  }

  let pathUpdated = false
  if (!options.noPath) {
    if (process.platform === 'win32') {
      const escaped = binDir.replace(/'/g, "''")
      const script = [
        `$bin = '${escaped}'`,
        "$current = [Environment]::GetEnvironmentVariable('Path', 'User')",
        "$parts = @($current -split ';' | Where-Object { $_ })",
        "if ($parts -notcontains $bin) {",
        "  $next = if ($current) { $current.TrimEnd(';') + ';' + $bin } else { $bin }",
        "  [Environment]::SetEnvironmentVariable('Path', $next, 'User')",
        "  Write-Output 'updated'",
        "} else { Write-Output 'present' }"
      ].join('\n')
      const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        encoding: 'utf8',
        windowsHide: true
      })
      if (result.status !== 0) {
        throw new CliError('CLI_PATH_UPDATE_FAILED', `更新用户 PATH 失败：${(result.stderr || '').trim()}`)
      }
      pathUpdated = String(result.stdout || '').includes('updated')
    } else {
      pathUpdated = false
    }
  }

  return {
    ok: true,
    source,
    cli: installedCli,
    shim,
    binDir,
    pathUpdated,
    runtime: electronPath || 'node',
    note: pathUpdated ? '新开的终端会自动找到 hira' : undefined
  }
}

async function doctor(json) {
  const data = await rpc('doctor', {})
  if (json) return emit(data, true)
  const lines = [
    'Hira CLI 已连接',
    `版本：${data.app && data.app.version ? data.app.version : 'unknown'}`,
    `后台浏览器：${data.browser && data.browser.mode === 'background' ? '就绪（共享登录态，不抢焦点）' : '不可用'}`,
    `AI：${data.ai && data.ai.ready ? '就绪' : '未配置可用模型'}`,
    `后台上下文：${data.browser && Array.isArray(data.browser.contexts) ? data.browser.contexts.length : 0}`
  ]
  emit(lines.join('\n'), false)
}

async function main() {
  const { flags, values, positionals } = parseArgs(process.argv.slice(2))
  if (flags.help || !positionals.length) {
    process.stdout.write(HELP)
    return
  }
  const command = positionals.shift()
  const context = values.context

  if (command === 'guide') {
    if (flags.json) return emit(GUIDE, true)
    return emit([
      'Hira CLI Agent 指南',
      '',
      ...GUIDE.rules.map((rule) => `- ${rule}`),
      '',
      '接入：hira agent install --target all',
      '检查：hira doctor --json',
      '示例：hira run "阅读今天最相关的 AI 更新并汇总" --wait --json'
    ].join('\n'), false)
  }

  if (command === 'install') {
    const result = installCli({ bin: values.bin, noPath: flags.noPath })
    return emit(result, flags.json)
  }

  if (command === 'setup') {
    const installed = installCli({ bin: values.bin, noPath: flags.noPath })
    const agents = writeAgentFiles(values.target || 'all', 'hira')
    return emit({ ...installed, agents }, flags.json)
  }

  if (command === 'agent') {
    const action = positionals.shift()
    if (action !== 'install') throw new CliError('CLI_BAD_ARGS', '用法：hira agent install [--target codex|claude|all]')
    const target = values.target || positionals.shift() || 'all'
    return emit(writeAgentFiles(target, 'hira'), flags.json)
  }

  if (command === 'doctor') return doctor(flags.json)

  if (command === 'contexts') return emit(await rpc('browser.list', {}), flags.json)

  if (command === 'open') {
    const url = positionals.shift()
    if (!url) throw new CliError('CLI_BAD_ARGS', '缺少网址')
    const data = await rpc('browser.open', { url, context, timeoutMs: Number(values.timeout) || undefined })
    if (flags.json) return emit(data, true)
    return emit(`已在后台打开\n${data.title || ''}\n${data.url || url}`, false)
  }

  if (command === 'read') {
    const common = {
      context,
      maxChars: Number(values.maxChars) || undefined,
      maxLinks: Number(values.maxLinks) || undefined,
      timeoutMs: Number(values.timeout) || undefined
    }
    const batchMs = Math.max(
      DEFAULT_TIMEOUT_MS,
      positionals.length * (Number(values.timeout) || 30_000) + 15_000
    )
    const data = positionals.length
      ? await rpc('browser.read_many', { ...common, urls: positionals }, { timeoutMs: batchMs })
      : await rpc('browser.read', common)
    if (flags.json) return emit(data, true)
    if (Array.isArray(data.items)) {
      return emit(data.items.map((item) => item.ok ? humanRead(item) : `读取失败 ${item.url}\n${item.error}`).join('\n\n---\n\n'), false)
    }
    return emit(humanRead(data), false)
  }

  if (command === 'search') {
    const query = positionals.join(' ').trim()
    if (!query) throw new CliError('CLI_BAD_ARGS', '缺少搜索词')
    const data = await rpc('browser.search', {
      context,
      query,
      engine: values.engine,
      maxChars: Number(values.maxChars) || undefined,
      maxLinks: Number(values.maxLinks) || undefined
    })
    if (flags.json) return emit(data, true)
    return emit(humanRead(data), false)
  }

  if (command === 'click') {
    const selector = values.selector || positionals.shift()
    const text = values.text
    if (!selector && !text) throw new CliError('CLI_BAD_ARGS', '提供 selector 或 --text')
    const data = await rpc('browser.click', {
      context,
      selector,
      text,
      allowActions: flags.allowActions
    })
    if (flags.json) return emit(data, true)
    return emit(data.ok ? `已点击：${data.text || selector || text}` : `未找到目标：${data.reason || 'unknown'}`, false)
  }

  if (command === 'fill') {
    const selector = values.selector || positionals.shift()
    const text = values.text !== undefined ? values.text : positionals.join(' ')
    if (!selector) throw new CliError('CLI_BAD_ARGS', '缺少 selector')
    const data = await rpc('browser.fill', {
      context,
      selector,
      text,
      submit: flags.submit,
      allowActions: flags.allowActions
    })
    if (flags.json) return emit(data, true)
    return emit(data.ok ? `已填写${data.submitted ? '并提交' : ''}` : `填写失败：${data.reason || 'unknown'}`, false)
  }

  if (command === 'scroll') {
    const direction = positionals.shift() || 'down'
    const data = await rpc('browser.scroll', {
      context,
      direction,
      amount: Number(positionals.shift()) || undefined
    })
    return flags.json ? emit(data, true) : emit(`已滚动到 ${data.y} / ${data.height}`, false)
  }

  if (command === 'screenshot') {
    const url = positionals.shift()
    const data = await rpc('browser.screenshot', { context, url })
    if (values.out) {
      const output = path.resolve(values.out)
      fs.mkdirSync(path.dirname(output), { recursive: true })
      fs.copyFileSync(data.path, output)
      data.path = output
    }
    return flags.json ? emit(data, true) : emit(data.path, false)
  }

  if (command === 'close') {
    const data = await rpc('browser.close', { context: context || 'default' })
    return flags.json ? emit(data, true) : emit(data.closed ? '后台上下文已释放' : '没有找到该后台上下文', false)
  }

  if (command === 'run') {
    const prompt = positionals.join(' ').trim()
    if (!prompt) throw new CliError('CLI_BAD_ARGS', '缺少自然语言任务')
    const started = await rpc('task.start', {
      prompt,
      model: values.model,
      reasoning: values.reasoning
    })
    if (!flags.wait) return emit(started, flags.json)
    return waitForTask(started.taskId, Number(values.timeout) || 30 * 60_000, flags.json)
  }

  if (command === 'task') {
    const action = positionals.shift()
    const taskId = positionals.shift()
    if (action === 'list') {
      const data = await rpc('task.list', { limit: Number(taskId) || 20 })
      if (flags.json) return emit(data, true)
      return emit(data.tasks.map((task) => `${task.status.padEnd(10)} ${task.taskId}  ${task.prompt.slice(0, 80)}`).join('\n') || '没有任务', false)
    }
    if (!taskId) throw new CliError('CLI_BAD_ARGS', `task ${action || ''} 缺少 taskId`)
    if (action === 'status') {
      const data = await rpc('task.status', { taskId })
      if (flags.json) return emit(data, true)
      return emit(`${data.status}\n${data.taskId}\n${data.error || ''}`.trim(), false)
    }
    if (action === 'result') {
      const data = await rpc('task.result', { taskId })
      if (flags.json) return emit(data, true)
      return emit(data.result || data.error || `任务状态：${data.status}`, false)
    }
    if (action === 'cancel') {
      const data = await rpc('task.cancel', { taskId })
      return flags.json ? emit(data, true) : emit(`任务 ${data.taskId}：${data.status}`, false)
    }
    throw new CliError('CLI_BAD_ARGS', 'task 只支持 status / result / cancel / list')
  }

  if (command === 'rpc') {
    const method = positionals.shift()
    if (!method) throw new CliError('CLI_BAD_ARGS', '缺少 RPC 方法')
    let params = {}
    if (positionals.length) {
      try { params = JSON.parse(positionals.join(' ')) } catch (_) {
        throw new CliError('CLI_BAD_ARGS', 'RPC 参数必须是 JSON 对象')
      }
    }
    return emit(await rpc(method, params), true)
  }

  throw new CliError('CLI_BAD_COMMAND', `未知命令：${command}`)
}

main().catch((error) => {
  const code = error && typeof error.code === 'string' ? error.code : 'CLI_ERROR'
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`[${code}] ${message}\n`)
  if (error && error.details) process.stderr.write(`${JSON.stringify(error.details, null, 2)}\n`)
  process.exitCode = 1
})

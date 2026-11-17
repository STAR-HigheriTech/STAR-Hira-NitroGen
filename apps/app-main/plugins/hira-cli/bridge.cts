/**
 * Hira CLI 插件 · 本机协议桥。
 *
 * 只监听 127.0.0.1 的随机端口；每次启动生成一次性令牌，并写到当前用户目录。
 * CLI 只拿“调用 Hira”的令牌，不接触 AI 密钥、Cookie 或 profile 数据库。
 *
 * 传输层刻意保持成一个极小 JSON-RPC 面：浏览器、任务、医生检查都是同一条协议，
 * 以后增加电商、飞书、行情等能力时只注册方法，不改启动方式和 CLI 连接逻辑。
 */

const crypto = require('crypto')
const fs = require('fs')
const fsp = require('fs/promises')
const http = require('http')
const os = require('os')
const path = require('path')

import type { IncomingMessage, Server, ServerResponse } from 'node:http'

interface BridgeApi {
  doctor(): unknown
  browser: {
    open(input: Record<string, unknown>): unknown
    read(input: Record<string, unknown>): unknown
    readMany(input: Record<string, unknown>): unknown
    search(input: Record<string, unknown>): unknown
    click(input: Record<string, unknown>): unknown
    fill(input: Record<string, unknown>): unknown
    scroll(input: Record<string, unknown>): unknown
    screenshot(input: Record<string, unknown>): unknown
    list(): unknown
    close(input: Record<string, unknown>): unknown
  }
  tasks: {
    start(input: Record<string, unknown>): unknown
    status(input: Record<string, unknown>): unknown
    result(input: Record<string, unknown>): unknown
    cancel(input: Record<string, unknown>): unknown
    list(input: Record<string, unknown>): unknown
  }
}

interface AgentBridgeDeps {
  api: BridgeApi
  userDataPath: string
  appRoot: string
  version: string
  logger?: Pick<Console, 'warn' | 'info'>
}

interface RuntimeDescriptor {
  protocol: number
  service: string
  state: 'ready'
  host: string
  port: number
  token: string
  pid: number
  startedAt: number
  version: string
  appRoot: string
  executablePath: string
}

class ProtocolError extends Error {
  code: string
  status: number

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'ProtocolError'
    this.status = status
    this.code = code
  }
}

const PROTOCOL_VERSION = 1
const MAX_BODY_BYTES = 2 * 1024 * 1024
const MAX_ACTIVE_REQUESTS = 64

function runtimeFile(): string {
  return path.join(os.homedir(), '.hira', 'cli', 'runtime.json')
}

function localRuntimeFile(userDataPath: string): string {
  return path.join(userDataPath, 'cli', 'runtime.json')
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
  try {
    fs.chmodSync(temp, 0o600)
  } catch (_) {}
  try {
    fs.renameSync(temp, file)
  } catch (_) {
    try { fs.rmSync(file, { force: true }) } catch (_) {}
    fs.renameSync(temp, file)
  }
  try { fs.chmodSync(file, 0o600) } catch (_) {}
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'))
    return value && typeof value === 'object' ? value : null
  } catch (_) {
    return null
  }
}

function removeOwnRuntimeFile(file: string, token: string): void {
  const current = readJson(file)
  if (!current || String(current.token || '') !== token) return
  try { fs.rmSync(file, { force: true }) } catch (_) {}
}

function tokenMatches(actual: unknown, expected: string): boolean {
  const left = Buffer.from(String(actual || ''))
  const right = Buffer.from(expected)
  return left.length === right.length && crypto.timingSafeEqual(left, right)
}

function bearer(req: IncomingMessage): string {
  const header = String(req.headers.authorization || '')
  const match = /^Bearer\s+(.+)$/i.exec(header)
  return match ? match[1] : ''
}

async function bodyOf(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.length
    if (bytes > MAX_BODY_BYTES) throw new ProtocolError(413, 'CLI_BODY_TOO_LARGE', '请求体超过 2 MB')
    chunks.push(buffer)
  }
  if (!chunks.length) return {}
  let value: unknown
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch (_) {
    throw new ProtocolError(400, 'CLI_BAD_JSON', '请求体不是合法 JSON')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProtocolError(400, 'CLI_BAD_JSON', '请求体必须是 JSON 对象')
  }
  return value as Record<string, unknown>
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = Buffer.from(JSON.stringify(payload))
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('content-length', String(body.length))
  res.setHeader('cache-control', 'no-store')
  res.setHeader('x-content-type-options', 'nosniff')
  res.end(body)
}

function createAgentBridge({ api, userDataPath, appRoot, version, logger = console }: AgentBridgeDeps) {
  const token = crypto.randomBytes(32).toString('hex')
  const startedAt = Date.now()
  const globalFile = runtimeFile()
  const localFile = localRuntimeFile(userDataPath)
  let server: Server | null = null
  let descriptor: RuntimeDescriptor | null = null
  let activeRequests = 0

  const methods = new Map<string, (input: Record<string, unknown>) => unknown>([
    ['doctor', () => api.doctor()],
    ['browser.open', (input) => api.browser.open(input)],
    ['browser.read', (input) => api.browser.read(input)],
    ['browser.read_many', (input) => api.browser.readMany(input)],
    ['browser.search', (input) => api.browser.search(input)],
    ['browser.click', (input) => api.browser.click(input)],
    ['browser.fill', (input) => api.browser.fill(input)],
    ['browser.scroll', (input) => api.browser.scroll(input)],
    ['browser.screenshot', (input) => api.browser.screenshot(input)],
    ['browser.list', () => api.browser.list()],
    ['browser.close', (input) => api.browser.close(input)],
    ['task.start', (input) => api.tasks.start(input)],
    ['task.status', (input) => api.tasks.status(input)],
    ['task.result', (input) => api.tasks.result(input)],
    ['task.cancel', (input) => api.tasks.cancel(input)],
    ['task.list', (input) => api.tasks.list(input)]
  ])

  function loopback(req: IncomingMessage): boolean {
    const address = String(req.socket.remoteAddress || '')
    return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const requestUrl = new URL(String(req.url || '/'), 'http://127.0.0.1')
    if (!loopback(req)) throw new ProtocolError(403, 'CLI_FORBIDDEN', '只允许本机连接')
    if (req.headers.origin) throw new ProtocolError(403, 'CLI_FORBIDDEN', '浏览器页面不能调用 CLI')

    if (req.method === 'GET' && requestUrl.pathname === '/v1/health') {
      sendJson(res, 200, {
        ok: true,
        service: 'hira-cli',
        protocol: PROTOCOL_VERSION,
        version,
        pid: process.pid,
        startedAt
      })
      return
    }
    if (requestUrl.pathname !== '/v1/rpc') {
      throw new ProtocolError(404, 'CLI_NOT_FOUND', '未知的 CLI 地址')
    }
    if (req.method !== 'POST') throw new ProtocolError(405, 'CLI_METHOD_NOT_ALLOWED', '只接受 POST')
    if (!String(req.headers['x-hira-client'] || '').startsWith('hira-cli/')) {
      throw new ProtocolError(400, 'CLI_CLIENT_REQUIRED', '缺少 x-hira-client 请求头')
    }
    if (!tokenMatches(bearer(req), token)) {
      throw new ProtocolError(401, 'CLI_UNAUTHORIZED', 'CLI 令牌无效；请重新读取 ~/.hira/cli/runtime.json')
    }

    const body = await bodyOf(req)
    const method = String(body.method || '').trim()
    const fn = methods.get(method)
    if (!fn) throw new ProtocolError(404, 'CLI_METHOD_NOT_FOUND', `未知方法：${method || '(empty)'}`)
    if (body.params !== undefined && (
      !body.params ||
      typeof body.params !== 'object' ||
      Array.isArray(body.params)
    )) {
      throw new ProtocolError(400, 'CLI_BAD_ARGS', 'params 必须是 JSON 对象')
    }
    const params = body.params ? body.params as Record<string, unknown> : {}
    sendJson(res, 200, { ok: true, method, data: await fn(params) })
  }

  async function start(): Promise<RuntimeDescriptor> {
    if (server && descriptor) return descriptor
    const activeServer = http.createServer((req: IncomingMessage, res: ServerResponse) => {
      if (activeRequests >= MAX_ACTIVE_REQUESTS) {
        sendJson(res, 503, { ok: false, error: { code: 'CLI_BUSY', message: 'Hira CLI 并发请求过多' } })
        return
      }
      activeRequests += 1
      void handle(req, res)
        .catch((error: unknown) => {
          const protocol = error instanceof ProtocolError ? error : null
          const record = error && typeof error === 'object' ? error as Record<string, unknown> : {}
          const status = protocol ? protocol.status : 500
          const code = protocol ? protocol.code : String(record.code || 'CLI_INTERNAL')
          const message = error instanceof Error ? error.message : 'Hira CLI 内部错误'
          if (!protocol) logger.warn?.('[hira-cli] request failed:', message)
          if (!res.headersSent) {
            sendJson(res, status, { ok: false, error: { code, message } })
          } else {
            try { res.end() } catch (_) {}
          }
        })
        .finally(() => {
          activeRequests = Math.max(0, activeRequests - 1)
        })
    })
    server = activeServer
    activeServer.keepAliveTimeout = 5_000
    activeServer.headersTimeout = 10_000
    activeServer.requestTimeout = 120_000
    await new Promise<void>((resolve, reject) => {
      activeServer.once('error', reject)
      activeServer.listen(0, '127.0.0.1', () => {
        activeServer.removeListener('error', reject)
        resolve()
      })
    })
    const address = activeServer.address()
    if (!address || typeof address === 'string') throw new Error('CLI 服务未能取得本机端口')
    descriptor = {
      protocol: PROTOCOL_VERSION,
      service: 'hira-cli',
      state: 'ready',
      host: '127.0.0.1',
      port: address.port,
      token,
      pid: process.pid,
      startedAt,
      version,
      appRoot,
      executablePath: process.execPath
    }
    writeJson(globalFile, descriptor)
    writeJson(localFile, descriptor)
    logger.info?.(`[hira-cli] listening on 127.0.0.1:${address.port}`)
    return descriptor
  }

  function stop(options: { disabled?: boolean } = {}): void {
    const active = server
    server = null
    descriptor = null
    if (options.disabled) {
      const marker = {
        protocol: PROTOCOL_VERSION,
        service: 'hira-cli',
        state: 'disabled',
        pluginId: 'hira-cli',
        stoppedAt: Date.now(),
        version,
        appRoot,
        executablePath: process.execPath
      }
      writeJson(globalFile, marker)
      writeJson(localFile, marker)
    } else {
      removeOwnRuntimeFile(globalFile, token)
      removeOwnRuntimeFile(localFile, token)
    }
    if (!active) return
    try { active.close() } catch (_) {}
    try { active.closeAllConnections?.() } catch (_) {}
  }

  return {
    start,
    stop,
    runtimePath: globalFile,
    localRuntimePath: localFile,
    version: PROTOCOL_VERSION
  }
}

module.exports = { createAgentBridge }

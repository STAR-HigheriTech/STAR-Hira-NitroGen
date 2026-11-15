import { describe, it, expect, vi } from 'vitest'
import {
  createDownloadSecurity,
  createSpeedTracker,
  createGlobalRateLimiter,
  createMcdFactory,
  shouldUseMultiThread,
  isDangerousFile
} from './index.ts'

/** 内存版 FilePort：够 Security 用，单测替换成本为零 */
function memFilePort() {
  const files = new Map() // path → content
  const ops = []
  const sep = '\\'
  const norm = (p) => p.split('/').join(sep)
  return {
    files, ops,
    sep,
    basename: (p) => { const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')); return i < 0 ? p : p.slice(i + 1) },
    dirname: (p) => { const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')); return i < 0 ? '.' : p.slice(0, i) },
    join: (...parts) => norm(parts.join(sep)),
    resolve: (...parts) => norm(parts.join(sep)),
    existsSync: (p) => files.has(norm(p)),
    mkdirSync: (p) => { ops.push(['mkdir', norm(p)]) },
    writeFileSync: (p, text) => { ops.push(['write', norm(p), text]); files.set(norm(p), text) }
  }
}

describe('Security · 文件名清洗', () => {
  const sec = createDownloadSecurity({ filePort: memFilePort(), platform: 'win32' })

  it('basename：去前置目录', () => {
    expect(sec.sanitizeDownloadFilename('../../etc/passwd')).toBe('passwd')
    expect(sec.sanitizeDownloadFilename('C:\\evil\\a.exe')).toBe('a.exe')
  })
  it('非法字符 → 下划线', () => {
    expect(sec.sanitizeDownloadFilename('a:b*c?.txt')).toBe('a_b_c_.txt')
  })
  it('Windows 保留名加前缀', () => {
    expect(sec.sanitizeDownloadFilename('CON')).toBe('_CON')
    expect(sec.sanitizeDownloadFilename('com1.txt')).toBe('_com1.txt')
  })
  it('空/点 → download', () => {
    expect(sec.sanitizeDownloadFilename('')).toBe('download')
    expect(sec.sanitizeDownloadFilename('..')).toBe('download')
    expect(sec.sanitizeDownloadFilename(null)).toBe('download')
  })
})

describe('Security · 盘符逃逸防御', () => {
  const sec = createDownloadSecurity({ filePort: memFilePort(), platform: 'win32' })

  it('正常拼接留在目录内', () => {
    const r = sec.safeJoinDownloadPath('C:\\Downloads', 'a.exe')
    expect(r.safeName).toBe('a.exe')
    expect(r.path.startsWith('C:\\Downloads')).toBe(true)
  })
  it('绝对路径文件名不逃逸出目录', () => {
    // basename 已把 'D:\\a.exe' 清成 'a.exe'，天然无法逃逸；这里验证拼接结果仍在目录内
    const r = sec.safeJoinDownloadPath('C:\\Downloads', 'D:\\evil\\a.exe')
    expect(r.path.startsWith('C:\\Downloads')).toBe(true)
  })
})

describe('Security · 同名不覆盖', () => {
  it('依次尝试 (1)(2)…', () => {
    const fp = memFilePort()
    fp.files.set('C:\\Downloads\\a.txt', 'x')
    fp.files.set('C:\\Downloads\\a (1).txt', 'x')
    const sec = createDownloadSecurity({ filePort: fp, platform: 'win32' })
    expect(sec.uniqueDownloadPath('C:\\Downloads', 'a.txt')).toBe('C:\\Downloads\\a (2).txt')
  })
  it('无冲突直接用原名', () => {
    const fp = memFilePort()
    const sec = createDownloadSecurity({ filePort: fp, platform: 'win32' })
    expect(sec.uniqueDownloadPath('C:\\Downloads', 'b.txt')).toBe('C:\\Downloads\\b.txt')
  })
})

describe('Security · Mark-of-the-Web', () => {
  it('win32 写 ADS 流', () => {
    const fp = memFilePort()
    const sec = createDownloadSecurity({ filePort: fp, platform: 'win32' })
    sec.writeMarkOfTheWeb('C:\\D\\a.zip', { referrerUrl: 'https://x/', hostUrl: 'https://x/a.zip' })
    expect(fp.files.get('C:\\D\\a.zip:Zone.Identifier')).toContain('ZoneId=3')
  })
  it('非 win32 不写', () => {
    const fp = memFilePort()
    const sec = createDownloadSecurity({ filePort: fp, platform: 'linux' })
    sec.writeMarkOfTheWeb('/tmp/a.zip', {})
    expect(fp.ops.length).toBe(0)
  })
  it('ADS 写失败静默', () => {
    const fp = memFilePort()
    fp.writeFileSync = () => { throw new Error('no ADS') }
    const sec = createDownloadSecurity({ filePort: fp, platform: 'win32' })
    expect(() => sec.writeMarkOfTheWeb('C:\\D\\a.zip', {})).not.toThrow()
  })
})

describe('SpeedTracker', () => {
  it('未采样 → 零速', () => {
    const t = createSpeedTracker()
    expect(t.getETA('a', 100, 1000)).toEqual({ speed: 0, eta: 0 })
  })
  it('暂停 → 速度归零', async () => {
    const t = createSpeedTracker()
    t.updateSample('a', 0)
    await new Promise((r) => setTimeout(r, 210))
    t.updateSample('a', 1000)
    const moving = t.getETA('a', 1000, 10000)
    expect(moving.speed).toBeGreaterThan(0)
    expect(t.getETA('a', 1000, 10000, true)).toEqual({ speed: 0, eta: 0 })
  })
  it('采样窗口最多 5 个（ indirectly：不会因长采样爆内存）', async () => {
    const t = createSpeedTracker()
    let received = 0
    t.updateSample('a', 0)
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 205))
      received += 5000
      t.updateSample('a', received)
    }
    expect(t.getETA('a', received, 1000000).speed).toBeGreaterThan(0)
  })
})

describe('RateLimiter', () => {
  it('不限速一律放行', () => {
    const rl = createGlobalRateLimiter({})
    expect(rl.tryConsume(1e12)).toBe('ok')
  })
  it('令牌不足 → throttle；有新字节流入时恢复等待方', async () => {
    const rl = createGlobalRateLimiter({ rateLimitBytesPerSec: 100 })
    expect(rl.tryConsume(50)).toBe('ok')
    expect(rl.tryConsume(1e6)).toBe('throttle')
    const resumed = vi.fn()
    rl.onNextTick(resumed)
    await new Promise((r) => setTimeout(r, 10))
    // 生产语义：throttle 后下载继续，下一次 tryConsume 触发 refill 并冲刷等待者
    // （dt=0 时 refill 会提前返回、回调延后 —— 原实现即如此，非下沉引入）
    rl.tryConsume(1)
    expect(resumed).toHaveBeenCalled()
  })
  it('setRate(0) = 不限速', () => {
    const rl = createGlobalRateLimiter({ rateLimitBytesPerSec: 100 })
    rl.setRate(0)
    expect(rl.getRate()).toBe(0)
    expect(rl.tryConsume(1e9)).toBe('ok')
  })
})

describe('DangerousFiles', () => {
  it('可执行扩展名 → true', () => {
    expect(isDangerousFile('setup.exe')).toBe(true)
    expect(isDangerousFile('SCRIPT.VBS')).toBe(true)
  })
  it('普通文件 → false', () => {
    expect(isDangerousFile('photo.png')).toBe(false)
    expect(isDangerousFile('')).toBe(false)
  })
})

describe('MCD（假 netPort + 假 fileOps）', () => {
  function fakeNet({ head }) {
    const reqs = []
    return {
      reqs,
      request({ method, url }) {
        const handlers = {}
        const req = {
          aborted: false,
          setHeader() {},
          end() {
            // HEAD 探测自动应答（range 请求由测试手工应答）
            if (method === 'HEAD') {
              queueMicrotask(() => {
                req.handlers.response?.({
                  statusCode: 200,
                  headers: head || { 'content-length': '0' }
                })
              })
            }
          },
          abort() { req.aborted = true },
          on(ev, cb) { req.handlers[ev] = cb; return req }
        }
        req.handlers = handlers
        reqs.push({ req, method, handlers, spec: { head } })
        return req
      }
    }
  }
  function fakeFileOps() {
    const ops = { writes: [], closed: 0, removed: 0 }
    return {
      ops,
      openWriteSync: () => 7,
      truncateSync: (fd, len) => { ops.truncated = len },
      // 异步写端口：domain 内置串行写链，落盘完成于微任务里
      writeAt: (fd, chunk, offset) => { ops.writes.push({ offset, chunk }); return Promise.resolve() },
      closeSync: () => { ops.closed++ },
      unlinkSync: () => { ops.removed++ }
    }
  }
  function respond(req, { status, headers }) {
    const respHandlers = {}
    const resp = {
      statusCode: status,
      headers,
      on(ev, cb) { respHandlers[ev] = cb }
    }
    req.handlers.response?.(resp)
    return { push: (chunk) => respHandlers.data?.(chunk), end: () => respHandlers.end?.() }
  }

  it('shouldUseMultiThread：仅 http(s)', () => {
    expect(shouldUseMultiThread('https://a/f')).toBe(true)
    expect(shouldUseMultiThread('data:x')).toBe(false)
    expect(shouldUseMultiThread('blob:x')).toBe(false)
    expect(shouldUseMultiThread('file:///x')).toBe(false)
    expect(shouldUseMultiThread('')).toBe(false)
  })
  it('缺端口 fail-fast', () => {
    expect(() => createMcdFactory({})).toThrow(/netPort/)
    expect(() => createMcdFactory({ netPort: { request() {} } })).toThrow(/fileOps/)
  })
  it('HEAD 探测成功 → 分段并发 → 全部完成触发 done + MotW', async () => {
    const net = fakeNet({ head: { 'content-length': '10000000', 'accept-ranges': 'bytes' } })
    const fo = fakeFileOps()
    const motw = vi.fn()
    const events = []
    const createMcd = createMcdFactory({ netPort: net, fileOps: fo, markOfTheWeb: motw })
    const mcd = createMcd({
      url: 'https://cdn/a.bin', savePath: 'C:\\D\\a.bin', connections: 2,
      emit: (name, payload) => events.push([name, payload])
    })
    const started = await mcd.start()
    expect(started).toBe(true)
    expect(fo.ops.truncated).toBe(10_000_000)

    // 两个 GET Range 请求
    const gets = net.reqs.filter((r) => r.method === 'GET')
    expect(gets.length).toBe(2)
    const half = 5_000_000
    // 段 0：写 2 块；段 1：写 1 块后 end
    const r0 = respond(gets[0].req, { status: 206, headers: {} })
    r0.push(Buffer.alloc(1000, 1))
    r0.push(Buffer.alloc(1000, 2))
    const r1 = respond(gets[1].req, { status: 206, headers: {} })
    r1.push(Buffer.alloc(500, 3))
    r1.end()
    // 段 0 结束 → 全部完成；done 事件在写队列冲刷后异步发出
    r0.end()
    await vi.waitFor(() => {
      expect(events.at(-1)[0]).toBe('done')
    })
    expect(events.at(-1)[1].state).toBe('completed')
    expect(events.at(-1)[1].receivedBytes).toBe(2500)
    expect(fo.ops.writes.length).toBe(3)
    expect(fo.ops.closed).toBe(1)
    expect(motw).toHaveBeenCalledWith('C:\\D\\a.bin', expect.objectContaining({ hostUrl: 'https://cdn/a.bin' }))
  })
  it('限速 throttle → abort 并等下一拍续传', async () => {
    const net = fakeNet({ head: { 'content-length': '10000000', 'accept-ranges': 'bytes' } })
    const fo = fakeFileOps()
    let tickCb = null
    const limiter = {
      tryConsume: () => 'throttle',
      onNextTick: (cb) => { tickCb = cb }
    }
    const createMcd = createMcdFactory({ netPort: net, fileOps: fo, markOfTheWeb: vi.fn() })
    const mcd = createMcd({ url: 'https://cdn/a.bin', savePath: 'C:\\D\\a.bin', connections: 1, rateLimiter: limiter, emit: () => {} })
    await mcd.start()
    const get = net.reqs.filter((r) => r.method === 'GET')[0]
    const r = respond(get.req, { status: 206, headers: {} })
    r.push(Buffer.alloc(100, 1))
    expect(get.req.aborted).toBe(true) // 被 throttle abort
    expect(typeof tickCb).toBe('function')
  })
  it('cancel → 关闭 + 删除文件 + done(cancelled)', async () => {
    const net = fakeNet({ head: { 'content-length': '10000000', 'accept-ranges': 'bytes' } })
    const fo = fakeFileOps()
    const events = []
    const createMcd = createMcdFactory({ netPort: net, fileOps: fo, markOfTheWeb: vi.fn() })
    const mcd = createMcd({ url: 'https://cdn/a.bin', savePath: 'C:\\D\\a.bin', connections: 1, emit: (n, p) => events.push([n, p]) })
    await mcd.start()
    await mcd.cancel() // 取消是异步的：排空写队列 → 关 fd → 删文件 → done(cancelled)
    expect(fo.ops.removed).toBe(1)
    expect(events.at(-1)[1].state).toBe('cancelled')
    expect(mcd.canResume()).toBe(false)
  })
})

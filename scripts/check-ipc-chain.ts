#!/usr/bin/env node
/**
 * IPC 全链矩阵静态核查（P0-3 闸门）
 *
 * 契约（IPC_ROUTES / IPC_EVENTS，shared-types）是唯一真源。本脚本只做静态事实核对：
 *   1. 主进程侧：谁注册了这条路由？（typedMain.handle / ipcMain.handle / ipcMain.on）
 *   2. 渲染侧 / preload：谁在调用这条路由？（IPC_ROUTES.<key> / 字面量通道）
 *   3. 事件侧：谁在发（IPC_EVENTS.<key> 出现在 main）、谁在订（renderer / preload）
 *   4. 反向孤儿：主进程/渲染侧引用了契约表里不存在的 key（拼错或漏登记）
 *
 * 退出码 1 的条件：
 *   - 存在未注册 handler 的 invoke 路由（渲染层会拿到 "No handler registered"）
 *   - 存在未登记进契约表的 key 引用
 * 只报告、不判失败的两类（允许合法缺席）：
 *   - 「契约声明了但无人调用」的路由（保留给扩展 / 后续 UI）
 *   - 「事件无人订阅」的路由（订阅是运行期行为，静态不可判定）
 *
 * 用法：node scripts/check-ipc-chain.ts [--json]
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { asRecord, errorMessage } from './lib/type-guards.ts'

interface SourceFile { file: string; text: string }
interface ChannelRef { key: string; files: string[] }
interface ChannelDescriptor { key: string; channel: string }
type RefMap = Map<string, Set<string>>

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MAIN_DIR = path.join(ROOT, 'apps', 'app-main', 'src', 'main')
const RENDERER_DIR = path.join(ROOT, 'apps', 'app-main', 'src', 'renderer')
const PRELOAD_DIR = path.join(ROOT, 'infra', 'infra-window', 'preload')
const PLUGIN_DIR = path.join(ROOT, 'apps', 'app-main', 'plugins')
const CONTRACT = path.join(ROOT, 'packages', 'shared-types', 'dist', 'esm', 'ipc-channels.mjs')

const CODE_EXT = new Set(['.js', '.cjs', '.mjs', '.ts', '.tsx', '.cts', '.mts'])

/**
 * legacy raw 通道：第三方页面 / 进程内 EventEmitter 使用，故意不进入 ngipc 契约
 * （发送方不是受控的 renderer 客户端）。
 *
 * 不要按前缀豁免。`jsDialog:*` 曾经在这里整段放行，结果裸字面量可以随便写、
 * 门禁看不见。现在它们收敛到 js-dialog-channels.ts#JS_DIALOG_CHANNELS，
 * 谁再手抄裸字面量就会被 classifyRendererRef 当作 orphan 拦下。
 */
const LEGACY_RAW_CHANNELS = new Set(['tab:webcontents-ready', 'window-controls:action'])

function isLegacyRaw(channel: string): boolean {
  return LEGACY_RAW_CHANNELS.has(channel)
}

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'out') continue
      walk(full, out)
    } else if (CODE_EXT.has(path.extname(entry.name))) {
      out.push(full)
    }
  }
  return out
}

function isTestFile(file: string): boolean {
  return /\.(test|spec)\.[cm]?[jt]s$/.test(file) || file.includes(`${path.sep}__tests__${path.sep}`)
}

function collect(fileList: readonly string[]): SourceFile[] {
  const files: SourceFile[] = []
  for (const file of fileList) {
    if (isTestFile(file)) continue
    files.push({ file, text: fs.readFileSync(file, 'utf8') })
  }
  return files
}

function collectMatches(files: readonly SourceFile[], re: RegExp): RefMap {
  const hits: RefMap = new Map()
  for (const { file, text } of files) {
    re.lastIndex = 0
    let m
    while ((m = re.exec(text))) {
      const key = m[1]
      if (!hits.has(key)) hits.set(key, new Set())
      hits.get(key)?.add(path.relative(ROOT, file))
    }
  }
  return hits
}

function keyRefs(files: readonly SourceFile[], objectName: string): RefMap {
  return collectMatches(files, new RegExp(`${objectName}\\.([A-Za-z0-9_]+)`, 'g'))
}

/**
 * 主进程注册：`typedMain.handle(routes.X)` / `ipcMain.on(sendCh(routes.X))` /
 * 别名包装（`const zoneSend = routes.X; ipcMain.on(sendCh(zoneSend))`）/
 * 常量包装（`const ROUTE_X = 'a:b'; ipcMain.on(SEND(ROUTE_X))`）/
 * 注册助手（`pwaSend(routes.X)`）/ 动态浮层族。
 */
function handlerRefs(files: readonly SourceFile[]): RefMap {
  const map: RefMap = new Map()
  const add = (key: string | undefined, file: string): void => {
    if (!key) return
    if (!map.has(key)) map.set(key, new Set())
    map.get(key)?.add(path.relative(ROOT, file))
  }
  const patterns = [
    /\.(?:handle|on|once)\(\s*(?:sendCh|evtCh|channel|scopedChannel)\(\s*(?:routes|route|IPC_ROUTES)\.([A-Za-z0-9_]+)/g,
    /\.(?:handle|on|once)\(\s*(?:routes|route|IPC_ROUTES)\.([A-Za-z0-9_]+)/g,
    /\.(?:handle|on|once)\(\s*[`'"][^`'"]*?\$\{\s*(?:routes|route|IPC_ROUTES)\.([A-Za-z0-9_]+)\s*\}/g,
    /\.(?:handle|on|once)\(\s*['"]([a-z0-9-]+:[a-z0-9-:]+)['"]/gi,
    // 包装器字面量：ipcMain.on(sendCh('overlay:commit')) / on(evtCh('x'))
    /\.(?:handle|on|once)\(\s*(?:sendCh|evtCh|channel|scopedChannel)\(\s*['"]([a-z0-9-]+:[a-z0-9-:]+)['"]/gi,
    // 注册助手：pwaSend(routes.x, schema, handler) 等
    /[A-Za-z0-9_$]+Send\(\s*(?:routes|route|IPC_ROUTES)\.([A-Za-z0-9_]+)/g,
    // 插件 / 组合根常用薄包装：handle(IPC_ROUTES.aiState) / forwardToUiShell(routes.key)
    /\b(?:handle|forwardToUiShell|forwardToRenderer|registerRoute)\(\s*(?:routes|route|IPC_ROUTES)\.([A-Za-z0-9_]+)/g
  ]
  for (const { file, text } of files) {
    for (const re of patterns) {
      re.lastIndex = 0
      let m
      while ((m = re.exec(text))) add(m[1], file)
    }

    // `const zoneSend = routes.buttonsEditZone` + `on(sendCh(zoneSend))`
    const aliases = text.matchAll(/(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*(?:\(?\s*(?:routes|route|IPC_ROUTES)\s*&&\s*(?:routes|route|IPC_ROUTES)\.([A-Za-z0-9_]+)|(?:routes|route|IPC_ROUTES)\.([A-Za-z0-9_]+))/g)
    for (const m of aliases) {
      const alias = m[1]
      const key = m[2] || m[3]
      const re = new RegExp(`(?:sendCh|evtCh|channel|scopedChannel|[A-Za-z0-9_$]+Send)\\(\\s*${alias.replace(/[$]/g, '\\$&')}\\b`)
      if (re.test(text)) add(key, file)
    }

    // `const ROUTE_SELECT = 'capture-overlay:select'` + `on(SEND(ROUTE_SELECT))`
    const consts = new Map<string, string>(
      [...text.matchAll(/(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*['"]([a-z0-9-]+:[a-z0-9-:]+)['"]/gi)]
        .map((m) => [m[1], m[2]])
    )
    if (consts.size) {
      const re = /\.(?:handle|on|once)\(\s*[A-Za-z0-9_$]+\(\s*([A-Za-z0-9_$]+)\s*\)/g
      let m
      while ((m = re.exec(text))) {
        if (consts.has(m[1])) add(consts.get(m[1]), file)
      }
    }

    // 注册助手：`const forward = (route) => { ipcMain.on(sendCh(route), ...) }` + `forward(routes.X)`
    // （`ipc/layout.js` 的 forwardToUiShell 属此类，静态正则直接看调用点看不到注册）
    const esc = (value: string): string => value.replace(/\$/g, '\\$&')
    for (const m of text.matchAll(/(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*(?:function\s*)?\(?\s*([A-Za-z0-9_$]+)\s*\)?\s*(?:=>|\{)/g)) {
      const name = m[1]
      const param = m[2]
      const bodyRe = new RegExp(
        `(?:const|let|var)\\s+${esc(name)}\\s*=[\\s\\S]{0,600}?\\.(?:handle|on|once)\\(\\s*(?:sendCh|evtCh|channel|scopedChannel)\\s*\\(\\s*${esc(param)}\\b`
      )
      if (!bodyRe.test(text)) continue
      const callRe = new RegExp(`\\b${esc(name)}\\(\\s*(?:routes|route|IPC_ROUTES)\\.([A-Za-z0-9_]+)`, 'g')
      let c
      while ((c = callRe.exec(text))) add(c[1], file)
    }
  }
  return map
}

/**
 * 动态浮层族：`ipc/layout.js` 的 FLOAT_NAMES 循环会为每个名字注册
 * show / hide / hidden / display 四条单向通道 + set-bounds / set-interactive / ready 三条 invoke。
 * 静态扫描看不到模板串，这里把这张表还原成实际通道集合。
 */
function dynamicFloatChannels(mainFiles: readonly SourceFile[]): Set<string> {
  const channels = new Set<string>()
  const layout = mainFiles.find((f) => /ipc[\\/]layout\.[cm]?[jt]s$/.test(f.file))
  if (!layout) return channels
  const block = layout.text.match(/FLOAT_NAMES\s*=\s*\[([\s\S]*?)\]/)
  if (!block) return channels
  const names = [...block[1].matchAll(/['"]([a-z0-9-]+)['"]/g)].map((m) => m[1])
  for (const name of names) {
    for (const suffix of ['show', 'hide', 'hidden', 'display', 'set-bounds', 'set-interactive', 'ready']) {
      channels.add(`${name}:${suffix}`)
    }
  }
  return channels
}

/** 主进程发送事件：emit(routes/EVENTS.X) 或 broadcaster.send(...) —— 静态只看 IPC_EVENTS 引用 */
function emitterRefs(files: readonly SourceFile[]): RefMap {
  return collectMatches(files, /IPC_EVENTS\.([A-Za-z0-9_]+)/g)
}

function rendererInvokeRefs(files: readonly SourceFile[]): RefMap {
  const map: RefMap = new Map()
  const patterns = [
    // 只要渲染侧引用了 IPC_ROUTES / PRELOAD_ROUTES.key，就视为「会发这条路由」：
    // 发送可能经过 sendRoute / overlay-scope 三元表达式等间接包装。
    // （PRELOAD_ROUTES 是 preload 用的零依赖子集，key 与主表一致 —— 见 ipc-channels-preload.mjs）
    /(?:IPC_ROUTES|PRELOAD_ROUTES)\.([A-Za-z0-9_]+)/g,
    /(?:invoke|send)\(\s*['"]([a-z0-9-]+:[a-z0-9-:]+)['"]/gi
  ]
  for (const re of patterns) {
    const hits = collectMatches(files, re)
    for (const [key, set] of hits) {
      if (!map.has(key)) map.set(key, new Set())
      for (const f of set) map.get(key)?.add(f)
    }
  }
  return map
}

function subscribeRefs(files: readonly SourceFile[]): RefMap {
  const map: RefMap = new Map()
  const add = (key: string, file: string): void => {
    if (!key) return
    if (!map.has(key)) map.set(key, new Set())
    map.get(key)?.add(path.relative(ROOT, file))
  }
  const patterns = [
    // IPC_EVENTS 是全量表；PRELOAD_EVENTS 是 preload 内联的同一批 key（见 ipc-channels-preload.mjs）
    /(?:IPC_EVENTS|PRELOAD_EVENTS)\.([A-Za-z0-9_]+)/g,
    /(?:subscribe|on)\(\s*['"]([a-z0-9-]+:[a-z0-9-:]+)['"]/gi,
    // 通过形参 / 上下文注入：`subscribe(events.qrScanSettled)`、`ctx.on(ctx.events.noteOpenView, ...)`
    /(?:subscribe|on|once|addListener)\(\s*(?:[A-Za-z0-9_$]+\.)*(?:events|EVENTS|IPC_EVENTS)\.([A-Za-z0-9_]+)/g
  ]
  for (const { file, text } of files) {
    for (const re of patterns) {
      re.lastIndex = 0
      let m
      while ((m = re.exec(text))) add(m[1], file)
    }
    // 常量订阅：`const EVENT_CHANNEL = 'ngipc:event:translate:page'` + `ipcRenderer.on(EVENT_CHANNEL, ...)`
    for (const m of text.matchAll(/(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*['"](?:ngipc:event:)?([a-z0-9-]+:[a-z0-9-:]+)['"]/gi)) {
      const name = m[1].replace(/\$/g, '\\$&')
      if (!new RegExp(`\\.(?:on|once|subscribe|addListener)\\(\\s*${name}\\b`).test(text)) continue
      add(m[2], file)
    }
  }
  return map
}

/** 主进程裸事件发送：`wc.send('ngipc:event:x')` / `evtCh('x')` / 模板串 */
function rawEventChannels(mainFiles: readonly SourceFile[], routeValues: ReadonlyMap<string, string>, eventValues: ReadonlyMap<string, string>): Set<string> {
  const channels = new Set<string>()
  for (const { text } of mainFiles) {
    for (const m of text.matchAll(/ngipc:event:([a-z0-9-]+:[a-z0-9-:]+)/gi)) channels.add(m[1])
    for (const m of text.matchAll(/(?:evtCh|eventChannel)\(\s*['"]([a-z0-9-]+:[a-z0-9-:]+)['"]/gi)) channels.add(m[1])
    for (const m of text.matchAll(/ngipc:event:\$\{\s*(?:routes|route|IPC_ROUTES)\.([A-Za-z0-9_]+)\s*\}/g)) {
      const v = routeValues.get(m[1])
      if (v) channels.add(v)
    }
    for (const m of text.matchAll(/ngipc:event:\$\{\s*(?:events|IPC_EVENTS)\.([A-Za-z0-9_]+)\s*\}/g)) {
      const v = eventValues.get(m[1])
      if (v) channels.add(v)
    }
  }
  return channels
}

async function main(): Promise<void> {
  const contract = asRecord(await import(pathToFileURL(CONTRACT).href))
  const ROUTES = asRecord(contract.IPC_ROUTES)
  const EVENTS = asRecord(contract.IPC_EVENTS)

  const routeValues = new Map(Object.entries(ROUTES).map(([k, v]) => [k, String(v)]))
  const eventValues = new Map(Object.entries(EVENTS).map(([k, v]) => [k, String(v)]))
  const routeValueSet = new Set(routeValues.values())
  const eventValueSet = new Set(eventValues.values())

  const pluginMainFiles = walk(PLUGIN_DIR).filter((file) => !/[\\/](?:ui|renderer|assets)[\\/]/.test(file))
  const mainFiles = collect([...walk(MAIN_DIR), ...pluginMainFiles])
  const rendererFiles = collect([
    ...walk(RENDERER_DIR),
    ...walk(PRELOAD_DIR),
    ...walk(path.join(ROOT, 'ui')),
    // pages（history / settings 等独立页面渲染进程）与 plugins（面板 renderer）也走 preload 桥
    ...walk(path.join(ROOT, 'apps', 'app-main', 'src', 'pages')),
    ...walk(path.join(ROOT, 'apps', 'app-main', 'plugins'))
  ])

  const handled = handlerRefs(mainFiles)
  const floatChannels = dynamicFloatChannels(mainFiles)

  const hasHandler = (key: string, channel: string): boolean =>
    handled.has(channel) || handled.has(key) || floatChannels.has(channel) || floatChannels.has(key)

  // 只认「invoke 型」路由做缺口判定：单向 send 通道（overlay:show 等）由 ipcMain.on 注册，
  // 同样被 handlerRefs 收到；两类都要求有注册方。
  const missingHandlers: ChannelDescriptor[] = []
  for (const [key, channel] of routeValues) {
    if (key === 'listenersAdd' || key === 'listenersRemove') continue // 由 shell-preload + ListenerRegistry 自闭环
    if (isLegacyRaw(channel)) continue
    if (!hasHandler(key, channel)) missingHandlers.push({ key, channel })
  }

  const handledKeySet = new Set(handled.keys())
  const unknownRouteRefs: ChannelRef[] = []
  const legacyRawRefs: ChannelRef[] = []
  for (const key of handledKeySet) {
    if (routeValues.has(key)) continue
    if (routeValueSet.has(key)) continue
    // 事件通道也会被 ipcMain.on 注册（renderer→main 通知），归入事件侧核对
    if (eventValues.has(key) || eventValueSet.has(key)) continue
    if (isLegacyRaw(key)) { legacyRawRefs.push({ key, files: [...(handled.get(key) || [])] }); continue }
    unknownRouteRefs.push({ key, files: [...(handled.get(key) || [])] })
  }

  const rendererInvokes = rendererInvokeRefs(rendererFiles)
  const rendererSubscribes = subscribeRefs(rendererFiles)
  const emitters = emitterRefs(mainFiles)
  const rawEvents = rawEventChannels(mainFiles, routeValues, eventValues)

  const knownRoute = (key: string): boolean =>
    routeValues.has(key) || routeValueSet.has(key) || eventValues.has(key) || eventValueSet.has(key) ||
    handled.has(key) || floatChannels.has(key)
  const knownEvent = (key: string): boolean =>
    routeValues.has(key) || routeValueSet.has(key) || eventValues.has(key) || eventValueSet.has(key) ||
    handled.has(key) || floatChannels.has(key) || rawEvents.has(key)
  // 契约登记：key 命中，或裸通道字面量命中了契约里的某个 value。
  const inContract = (key: string): boolean =>
    routeValues.has(key) || eventValues.has(key) ||
    routeValueSet.has(key) || eventValueSet.has(key)

  const orphanRendererKeys: ChannelRef[] = []
  const contractDrift: ChannelRef[] = []
  const dynamicRefs: ChannelRef[] = []
  const classifyRendererRef = (key: string, files: string[], known: (key: string) => boolean): void => {
    if (isLegacyRaw(key)) { legacyRawRefs.push({ key, files }); return }
    if (inContract(key)) return
    // 动态浮层族 / 主进程裸事件：主进程确有注册，只是未逐条登记契约（非失败项）。
    if (floatChannels.has(key) || rawEvents.has(key)) { dynamicRefs.push({ key, files }); return }
    if (known(key)) { contractDrift.push({ key, files }); return }
    orphanRendererKeys.push({ key, files })
  }
  for (const key of rendererInvokes.keys()) classifyRendererRef(key, [...(rendererInvokes.get(key) ?? [])], knownRoute)
  for (const key of rendererSubscribes.keys()) classifyRendererRef(key, [...(rendererSubscribes.get(key) ?? [])], knownEvent)
  for (const key of emitters.keys()) classifyRendererRef(key, [...(emitters.get(key) ?? [])], knownEvent)

  // 真断链：渲染侧会 invoke / send，但主进程没有任何注册方。
  const brokenRoutes = missingHandlers.filter(({ key, channel }) => {
    return rendererInvokes.has(key) || rendererInvokes.has(channel)
  })
  // 死契约：契约声明了，但主进程无注册、渲染侧也无调用 —— 属于死代码，必须清理。
  const deadContractRoutes = missingHandlers.filter(({ key, channel }) => {
    return !rendererInvokes.has(key) && !rendererInvokes.has(channel)
  })

  // 契约里声明、但渲染侧无人调用（仅提示）
  const unconsumedRoutes: ChannelDescriptor[] = []
  for (const [key, channel] of routeValues) {
    const usedByKey = rendererInvokes.has(key)
    const usedByLiteral = rendererInvokes.has(channel)
    // 主进程内部也会互相 send（overlay 中转），算「已消费」
    const usedInMain = hasHandler(key, channel)
    if (!usedByKey && !usedByLiteral && !usedInMain && key !== 'listenersAdd' && key !== 'listenersRemove') {
      unconsumedRoutes.push({ key, channel })
    }
  }

  const unsubscribedEvents: ChannelDescriptor[] = []
  for (const [key, channel] of eventValues) {
    const byKey = rendererSubscribes.has(key)
    const byLiteral = rendererSubscribes.has(channel)
    if (!byKey && !byLiteral) unsubscribedEvents.push({ key, channel })
  }

  const report = {
    contract: { routes: routeValues.size, events: eventValues.size },
    main: { files: mainFiles.length, handledKeys: handledKeySet.size, floatChannels: floatChannels.size },
    renderer: { files: rendererFiles.length, invokeKeys: rendererInvokes.size, subscribeKeys: rendererSubscribes.size },
    brokenRoutes,
    deadContractRoutes,
    unknownRouteRefs,
    orphanRendererKeys,
    legacyRawRefs,
    contractDrift,
    dynamicRefs,
    unconsumedRoutes,
    unsubscribedEvents
  }

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(JSON.stringify({
      contract: report.contract,
      main: report.main,
      renderer: report.renderer,
      brokenRouteCount: brokenRoutes.length,
      deadContractCount: deadContractRoutes.length,
      unknownRefCount: unknownRouteRefs.length + orphanRendererKeys.length,
      legacyRawCount: legacyRawRefs.length,
      contractDriftCount: contractDrift.length,
      dynamicRefCount: dynamicRefs.length,
      unconsumedCount: unconsumedRoutes.length,
      unsubscribedEventCount: unsubscribedEvents.length,
      brokenRoutes: brokenRoutes.slice(0, 40),
      deadContractRoutes: deadContractRoutes.slice(0, 60),
      unknownRouteRefs,
      orphanRendererKeys: orphanRendererKeys.slice(0, 40),
      legacyRawRefs,
      contractDrift: contractDrift.slice(0, 40),
      dynamicRefs: dynamicRefs.slice(0, 40),
      unconsumedRoutes,
      unsubscribedEvents
    }, null, 2))
  }

  const failed = brokenRoutes.length > 0 || deadContractRoutes.length > 0 ||
    unknownRouteRefs.length > 0 || orphanRendererKeys.length > 0
  process.exit(failed ? 1 : 0)
}

main().catch((error) => {
  console.error(errorMessage(error))
  process.exit(1)
})

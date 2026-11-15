import * as fs from 'node:fs'
import * as path from 'node:path'
import * as builder from 'electron-builder'
import type { CliOptions, Configuration } from 'electron-builder'
import { APP_NAME, URL_SCHEMES } from '@hira-ng/shared-types/src/associations.mjs'

// 安装器里的关联注册宏（hiraRegisterAssociations / hiraUnregisterAssociations）
// 不是手写的：打包前先从 shared-types/src/associations.ts 渲染进
// build/installer.nsh 的生成区，保证安装期与运行期写的是同一份 schema。
import './gen-associations.ts'

interface PackageManifest {
  version: string
  [key: string]: unknown
}

interface AsarEntry {
  files?: Record<string, AsarEntry>
  size?: number | string
  offset?: number | string
  unpacked?: boolean
}

interface AsarPackageManifest {
  main?: string
}

// 默认只打包、不发布；显式传 --publish 才会上传 GitHub Release。
// 打包配置统一来自 package.json 的 build 字段（不要在这里再传整份 config，
// 否则 electron-builder 会把 publish 数组二次合并到自身，触发 schema 校验失败）。
//
// 通道：
//   · 默认（不带参数）→ 稳定版，产出 latest.yml，对应应用内 stable 通道；
//   · --preview      → 预览版，channel=preview，产出 preview.yml，
//                      对应应用内 preview 通道（electron-updater 会按
//                      `allowPrerelease` 去找预发布 Release）。
//   版本号由 package.json 的 version 决定，且必须与通道严格一致：
//   预览版用 `x.y.z-preview.n`，并在 GitHub Release 上勾选「Pre-release」。
//   原因（electron-updater GitHubProvider）：预发布场景下它用 release tag 的
//   预发布标签（`-preview.1` 里的 `preview`）去找通道文件；标签不是 preview
//   就会去请求 `beta.yml` 之类的文件、404 后回落到 latest.yml，
//   结果是「静默地永远收不到预览版」，所以这里直接拦死。
const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')) as PackageManifest
const shouldPublish = process.argv.includes('--publish')
const isPreview = process.argv.includes('--preview')
const publishMode = shouldPublish ? 'always' : 'never'
const channel = isPreview ? 'preview' : 'latest'

/** `8.0.1-preview.2` → `preview`；正式版 → null */
function prereleaseTagOf(version: string): string | null {
  const dash = version.indexOf('-')
  if (dash < 0) return null
  return version.slice(dash + 1).split('.')[0]
}

/**
 * 打包后自检：app.asar 的偏移表必须与实际数据**严丝合缝**。
 *
 * 为什么必须校验：asar 头部记录每个文件的 `offset/size`，内容紧随其后。
 * 若打包期间有源文件被外部进程改写（编辑器自动保存、监听型脚本、tsc --watch …），
 * 头部尺寸与真实数据就会错位 —— Electron 读不到 `package.json` 的 main 入口，
 * 直接退化成默认应用：stdout 打印 `Usage: electron [options] [path]`、
 * 弹出一个标题为 "Electron" 的空白窗口。这类坏包一旦发出，用户侧表现为
 * 「所有链接都用 Electron 打开」，极难从现象反推，所以必须在打包时就拦死。
 *
 * 校验三项：
 *   1. 所有非 unpacked 条目的 offset+size 最大值 === 实际数据区长度（无错位/无截断）；
 *   2. asar 内 package.json 可解析且带 main；
 *   3. main 指向的入口文件确实在包内。
 */
function verifyAsar(appOutDir: string): void {
  const asarPath = path.join(appOutDir, 'resources', 'app.asar')
  const size = fs.statSync(asarPath).size
  const fd = fs.openSync(asarPath, 'r')
  try {
    const head = Buffer.alloc(16)
    fs.readSync(fd, head, 0, 16, 0)
    const headerSize = head.readUInt32LE(4)
    const jsonSize = head.readUInt32LE(12)
    const json = Buffer.alloc(jsonSize)
    fs.readSync(fd, json, 0, jsonSize, 16)
    const header = JSON.parse(json.toString('utf8')) as AsarEntry
    // 数据区起点：8 字节头部长度字段 + headerSize + 4 字节 jsonLen 字段。
    // 注意 headerSize 是从「16 字节固定头之后」算起的偏移，故 +8 而非 +16。
    const dataOffset = 8 + headerSize
    // 用「求和」而非「取最大 offset+size」：asar 的数据区是紧密平铺的，
    // 所有未 unpack 条目的大小之和必然等于数据区长度；求和与条目排列顺序无关，
    // 末尾恰好有 unpacked 文件时也不会误判。
    let declared = 0
    const walk = (node: AsarEntry): void => {
      for (const entry of Object.values(node.files || {})) {
        if (entry.files) walk(entry)
        else if (!entry.unpacked) declared += Number(entry.size)
      }
    }
    walk(header)
    const actual = size - dataOffset
    if (declared !== actual) {
      throw new Error(
        `[pack-win] app.asar 偏移表与实际数据不一致（声明 ${declared}，实际 ${actual}）：`
        + '打包期间有源文件被改写，产物会让 Electron 退化成默认应用。'
        + '请关闭编辑器自动保存 / 监听型脚本后重新打包。'
      )
    }
    const readEntry = (relPath: string): Buffer | null => {
      const segs = relPath.split('/')
      let node = header
      for (const seg of segs) {
        if (!node || !node.files) return null
        node = node.files[seg]
      }
      if (!node || node.files) return null
      const buf = Buffer.alloc(Number(node.size))
      fs.readSync(fd, buf, 0, buf.length, dataOffset + Number(node.offset))
      return buf
    }
    const pkgBuf = readEntry('package.json')
    if (!pkgBuf) throw new Error('[pack-win] app.asar 内缺少 package.json')
    const appPkg = JSON.parse(pkgBuf.toString('utf8')) as AsarPackageManifest
    if (!appPkg.main) throw new Error('[pack-win] app.asar 内 package.json 缺少 main')
    if (!readEntry(appPkg.main)) {
      throw new Error(`[pack-win] app.asar 内缺少入口文件 ${appPkg.main}`)
    }
    console.log(`[pack-win] asar 自检通过（${declared} B 数据区、main=${appPkg.main}）`)
  } finally {
    fs.closeSync(fd)
  }
}

async function main() {
  const version = pkg.version
  const tag = prereleaseTagOf(version)
  if (isPreview && tag !== 'preview') {
    throw new Error(`--preview 要求 version 形如 x.y.z-preview.n，当前为 ${version}`)
  }
  if (!isPreview && tag !== null) {
    throw new Error(`稳定版构建不接受预发布版本号，当前为 ${version}`)
  }

  const targets = builder.Platform.WINDOWS.createTarget(['nsis'], builder.Arch.x64)
  /**
   * 只覆盖必要字段：其余（appId / nsis / files / publish …）继续取自
   * package.json 的 build 段，避免把整份配置搬到这里形成第二份真源。
   *   · channel  —— 仅预览版；
   *   · afterPack —— 产物 asar 自检（坏包直接 fail，绝不静默发布）。
   * @type {import('electron-builder').Configuration}
   */
  const config: Configuration & { channel?: string } = {
    // 跨平台打包器也要与应用内注册共用同一份协议清单。
    protocols: [
      {
        name: `${APP_NAME} Web Protocol`,
        schemes: [...URL_SCHEMES]
      }
    ],
    afterPack: async (context) => {
      verifyAsar(context.appOutDir)
    }
  }
  if (isPreview) config.channel = channel
  const options: CliOptions = { targets, publish: publishMode, config }
  console.log(`[pack-win] channel=${channel} publish=${publishMode}`)
  await builder.build(options)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

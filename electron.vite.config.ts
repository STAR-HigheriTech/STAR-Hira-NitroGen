import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import type { Plugin } from 'vite'
import { extname, isAbsolute, resolve } from 'node:path'
import * as fs from 'node:fs'
// esbuild 由 vite 带入（构建期工具，非运行时依赖）：把 main 侧的 *.ts 就地转译成 .js，
// 把内部页共享运行时打成自包含单文件（bundleSharedRuntimePlugin），
// 并把多模块页面的模块图并成单文件（bundlePageEntriesPlugin）。
import { build as esbuildBuild, transform as esbuildTransform, transformSync } from 'esbuild'
// 内部页 favicon 的唯一真源（host → 图标 URL）—— 与主进程的 hira://page-icon 端点同源。
import { pageIconUrl } from '@hira-ng/shared-types/src/page-icon.mjs'

const ROOT_DIR = import.meta.dirname

interface ShellRules {
  attr: string
  reservesRail(host: string): boolean
}

interface WalkedFile {
  full: string
  rel: string
}

interface RunnablePlugin extends Plugin {
  run(): unknown | Promise<unknown>
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 可注入 favicon 的页面 HTML —— 只认 `pages/<host>/index.html`（页面目录的入口页）。
 * 页面内部的子目录（widgets/、sections/…）不注入：它们不是文档。
 */
const INJECTABLE_PAGE_HTML = /^pages\/([^/]+)\/index\.html$/i

/** 页面是否**自己**声明了图标（只为判断要不要注入；只认真实 rel 值里的 icon 整词）。 */
function declaresOwnIcon(html: string): boolean {
  const re = /\brel\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi
  let m
  while ((m = re.exec(html))) {
    const value = String(m[2] ?? m[3] ?? m[4] ?? '').toLowerCase()
    if (/(^|\s)icon(\s|$)/.test(value)) return true
  }
  return false
}

/**
 * 给内部页统一注入 favicon 的 link[rel=icon]（构建期，**一处**）。
 *
 * 为什么统一注入而不是逐页手写一行：
 *   · 页面数是会长的（插件还能新增内部页），逐页手放必然漏，而漏掉的那一页在标签条上
 *     只会显示"标题首字"—— 这正是内部页长期以来的样子；
 *   · 图标本体不在这里 —— 只放一个短 URL（hira://page-icon/?p=<host>），
 *     字节由协议端点按 shared-types/src/page-icon.ts 那张表吐。换图标 = 改那张表。
 *
 * 为什么是构建期而不是运行期：协议层只做"协议 + 分发 + 静态读盘"（见
 * main/hira-protocol.js 的文件头），改写页面内容不属于它的职责；而构建期改写与上面
 * rewriteSharedSpecifiers 完全同构（同一支插件、同一个"落盘那一刻"）。
 */
function injectPageIcon(html: string, rel: string): string {
  // 页面自己声明过 → 原样放行（作者意图优先，重复构建也不会叠加）
  if (declaresOwnIcon(html)) return html
  const at = html.search(/<\/head\s*>/i)
  if (at < 0) return html // 不是完整文档（不该发生）→ 别硬塞
  const match = INJECTABLE_PAGE_HTML.exec(rel)
  if (!match) return html
  const host = match[1]
  const tag =
    '<link rel="icon" href="' + pageIconUrl(host) + '" />\n' +
    '    <!-- ↑ 由 electron.vite.config.js 统一注入（请勿手改）：图标真源见\n' +
    '         packages/shared-types/src/page-icon.ts，字节由 hira://page-icon 端点给出。 -->\n  '
  return html.slice(0, at) + tag + html.slice(at)
}

/**
 * 读出「哪些页面要左侧导航」的判定与标记名（真源 = `pages/_shared/shell-registry.ts`）。
 *
 * 真源是 TypeScript。这里在每次构建时用 esbuild 打包成一次性 CJS 并求值，
 * 避免 Node 对 `.ts` / ESM 的缓存与模块类型差异；代价只有一次几十行的编译。
 *
 * 读不到时**退化**为"一个页面都不预留"：构建照常完成（页面仍有运行期兜底），
 * 只是那一轮没有首帧占位 —— 比让构建失败好。
 *
 * @returns {Promise<{ attr: string, reservesRail: (host: string) => boolean }>}
 */
async function loadShellRules(): Promise<ShellRules> {
  const file = resolve(ROOT_DIR, 'apps/app-main/src/pages/_shared/shell-registry.ts')
  const fallback: ShellRules = { attr: 'data-hira-shell', reservesRail: () => false }
  try {
    const result = await esbuildBuild({
      entryPoints: [file],
      bundle: true,
      write: false,
      format: 'cjs',
      platform: 'node',
      target: 'node20',
      logLevel: 'silent'
    })
    const code = result.outputFiles && result.outputFiles[0] && result.outputFiles[0].text
    if (!code) return fallback
    const module: { exports: unknown } = { exports: {} }
    new Function('module', 'exports', 'require', '__dirname', '__filename', code)(
      module,
      module.exports,
      require,
      resolve(file, '..'),
      file
    )
    const mod: unknown = module.exports
    if (!mod || typeof mod !== 'object' || !('usesSharedShell' in mod) || !('SHELL_ATTR' in mod)) return fallback
    const usesSharedShell = mod.usesSharedShell
    const shellAttr = mod.SHELL_ATTR
    if (typeof usesSharedShell !== 'function' || typeof shellAttr !== 'string') return fallback
    return { attr: shellAttr, reservesRail: usesSharedShell as (host: string) => boolean }
  } catch (err) {
    console.warn(
      '[copy-main-sources] shell-registry 读取失败，本轮跳过左侧导航占位注入:',
      errorMessage(err)
    )
    return fallback
  }
}

/**
 * 把「为左侧导航让位」的标记写进 `<html>`（构建期，**一处**）。
 *
 * 为什么必须是构建期：`data-hira-shell` 之前是 `runtime.js`（deferred module）求值时
 * 才打上的，而那时首帧已经按"无侧栏"满宽画完了 —— 于是每次切内部页都会看到内容
 * 先满宽、再被 228px 的侧栏挤过去（layout shift）。既然共享 CSS 已经内联进 HTML，
 * 把标记也写进 HTML，首帧就直接按"有侧栏"排版，一次都不抖。
 *
 * 幂等 / 自纠：先剥掉已有的同名属性再按当前注册表重写 —— 因此页面从"要外壳"改成
 * "自带外壳"（或反过来）时，重建一次就干净，不会残留旧标记。
 *
 * @param {string} html
 * @param {string} host `pages/<host>/index.html` 里的 host
 * @param {{ attr: string, reservesRail: (host: string) => boolean }} shell
 */
function markShellPlaceholder(html: string, host: string, shell: ShellRules): string {
  const open = /<html\b([^>]*)>/i.exec(html)
  if (!open) return html // 不是完整文档 → 别硬塞
  const escaped = shell.attr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const attrs = open[1].replace(
    new RegExp(`\\s${escaped}(?:\\s*=\\s*("[^"]*"|'[^']*'|[^\\s>]+))?`, 'gi'),
    ''
  )
  const next = shell.reservesRail(host) ? `${attrs} ${shell.attr}="1"` : attrs
  if (next === open[1]) return html // 无需改动 → 一个字节都不动
  return html.slice(0, open.index) + '<html' + next + '>' + html.slice(open.index + open[0].length)
}

/**
 * 收集内部页可用的共享样式表：`hira://shared/<name>.css` → 源码真源路径。
 *
 * **每次构建都重新读**：dev 是 watch 模式，配置模块只求值一次 —— 在这里做模块级缓存
 * 会让「改了 CSS 但页面还是旧样式」变成一个必须重启才消失的幽灵问题。
 *
 * 真源分两处：`base.css` 在页面源码目录里；`layers.css` 的真源在
 * `packages/shared-ui-tokens/`（见 SHARED_PAGES_ASSETS，这里是**同一份清单**，
 * 不再另维护一份名字表 —— 新增共享样式只要登记到那里，内联就自动跟上）。
 *
 * @returns {Map<string, string>} 读不到的文件直接缺席（页面退回外链版本）
 */
function readSharedCss(): Map<string, string> {
  const map = new Map<string, string>()
  const add = (name: string, file: string): void => {
    try {
      map.set(name, fs.readFileSync(file, 'utf8'))
    } catch {
      // 读不到 → 不内联，页面保持外链（比构建失败好）
    }
  }
  add('base.css', resolve(ROOT_DIR, 'apps/app-main/src/pages/_shared/base.css'))
  for (const asset of SHARED_PAGES_ASSETS) {
    if (asset.name.endsWith('.css')) add(asset.name, asset.from)
  }
  return map
}

/** `<link rel="stylesheet" href="hira://shared/<name>.css">` 那一条（含行尾空白）。 */
const SHARED_CSS_LINK = /[ \t]*<link\b[^>]*href=["']hira:\/\/shared\/([^"'/?]+\.css)["'][^>]*>[ \t]*\r?\n?/gi

/**
 * 把**跨源**的共享样式表就地内联进页面 HTML（构建期，一处）。
 *
 * 为什么内联：`hira://shared` 与页面 `hira://<host>` 不同源 → Chromium 按 top-level
 * site 分区缓存，**每个内部页都要重新走一次协议请求**。那条请求正好压在首帧之前 ——
 * 页面自己的 CSS/DOM 都好了，还得等它回来才画。内联后首帧只依赖 HTML 本身，
 * 少一个 round-trip、也少一次样式表资源装配。
 *
 * 覆盖面由页面自己决定：**页面引了哪条就内联哪条**；少数页面自带全部样式、
 * 压根没引 —— 不强行注入（作者意图优先）。清单里没有的共享 css 也原样保留外链。
 *
 * 前提：这些样式表里**没有** `url()` / `@import`（已核对），所以搬到别的 origin
 * 下不会让任何相对资源解析失效。
 */
function inlineSharedCss(html: string, cssMap: Map<string, string>): string {
  if (!cssMap.size) return html
  return html.replace(SHARED_CSS_LINK, (full: string, name: string) => {
    const css = cssMap.get(name)
    if (!css) return full
    // 幂等：link 被替换掉后已是 <style>，对产物再跑一遍也不会叠加
    return '<style data-hira-shared-css="' + name + '">\n' + css + '\n    </style>\n    '
  })
}

/**
 * 把**页面自己目录下**的样式表也内联进 HTML（`<link rel="stylesheet" href="./x.css">`）。
 *
 * 与共享样式同理：那条 link 是**渲染阻塞**的 —— HTML 到了，还得等它回来才能首绘。
 * 页面 CSS 全是纯规则（已核对：`pages/**` 下没有任何相对 `url()` 或 `@import`），
 * 所以内联不会让任何相对资源解析失效。
 *
 * 不内联带 `media` / `disabled` 的 link：那是有意为之的条件加载，不能抹平。
 * 找不到对应文件时原样保留（宁可多一次请求，不要少一块样式）。
 *
 * @param {string} html
 * @param {string} pageDir 页面在**源码**里的目录（读 .css 用）
 */
function inlinePageCss(html: string, pageDir: string): string {
  return html.replace(
    /[ \t]*<link\b([^>]*)>[ \t]*\r?\n?/gi,
    (full: string, attrs: string) => {
      if (/\bmedia\s*=|\bdisabled\b/i.test(attrs)) return full
      const m = /\brel=["']stylesheet["']/i.test(attrs) && /\bhref=["']\.\/([^"']+\.css)["']/i.exec(attrs)
      if (!m) return full
      const name = m[1]
      let css
      try {
        css = fs.readFileSync(resolve(pageDir, name), 'utf8')
      } catch {
        return full
      }
      return '<style data-hira-page-css="' + name + '">\n' + css + '\n    </style>\n    '
    }
  )
}

/**
 * Vite 插件：main 构建完成后，把 apps/app-main/src/ 下所有资源文件
 * 按目录结构递归复制到 out/，保证 require('./app-root') / require('../shared/ipc-contract')
 * 等本地依赖可正确解析，以及 pages/<host>/ 下的 html/css/js/图片能被 hira:// 协议读到。
 * 原因：当前 electron-vite + Vite 7 的 SSR 构建不会 bundle 本地 CJS require。
 *
 * **TypeScript 支持**：`*.ts` 不直接拷贝（Node 无法 require .ts），而是用 esbuild
 * 就地转译为同名的 `.js` 落到 out/。于是 `require('./foo')` 依旧零改动解析到
 * `out/**\/foo.js` —— main 进程可以用 TS 写新模块，而**无需**tsconfig/tsc 参与构建
 * （类型检查是独立的一步，见根 tsconfig.json）。
 *
 * **排除 `renderer/`**：该子树归 Vite 的 renderer 构建管（产物是 out/renderer/**\/*.html
 * + out/renderer/assets/*.js），main / pages 都不 require 它。若不排除，本插件的
 * closeBundle（main 构建结束时触发）会把源码版 renderer HTML **覆盖**掉 Vite 的构建产物：
 *   · `pnpm dev` 只构建 main → out/renderer/panels/index.html 变成引用 `./main.js`
 *     （源码版，里面是 `@hira-ng/ui-common` 这类裸模块说明符）→ 浏览器解析不了
 *     → 之后跑构建版时**所有「首次加载」的面板/页面全白屏**（已实测复现）。
 *
 * **内部页要改写共享层裸名**：`pages/**` 下的 js 落盘前会过一遍
 * `rewriteSharedSpecifiers`，把 `@hira-ng/shared-types/src/…` 改成 `hira://shared/…`。
 * 原因同上 —— 裸名进浏览器就是白屏；这一步让源码两种写法都能用（详见该函数说明）。
 */
function copyMainSourcesPlugin(): RunnablePlugin {
  const root = resolve(ROOT_DIR, 'apps/app-main/src')
  const outRoot = resolve(ROOT_DIR, 'out')
  /**
   * electron-vite 的 dev watcher 会反复执行本插件。旧实现每次都把 main / pages
   * 全量复制、逐文件同步转译并重新扫描陈旧产物；渲染层改一行，主进程仍要付整笔
   * 成本。缓存只活在当前配置实例内，重启后自动全量校验，不引入跨版本脏缓存。
   */
  const sourceStamps = new Map<string, string>()
  const outputStamps = new Map<string, string>()
  // 这些文件会被后续 esbuild 流水线就地覆盖；mtime 不再代表 copy 步骤的产物状态。
  const downstreamOutputs = new Set(['pages/_shared/runtime.js'])
  let lastExpectedKey = ''
  const statStamp = (file: string): string => {
    const stat = fs.statSync(file)
    return `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`
  }
  const outputStamp = (file: string): string => {
    const stat = fs.statSync(file)
    return `${stat.size}:${stat.mtimeMs}`
  }
  const canReuse = (rel: string, source: string, dependencyStamp = ''): boolean => {
    const dest = resolve(outRoot, rel)
    if (!fs.existsSync(dest)) return false
    const sourceStamp = statStamp(source)
    if (sourceStamps.get(rel) !== sourceStamp + '\0' + dependencyStamp) return false
    return downstreamOutputs.has(rel) || outputStamps.get(rel) === outputStamp(dest)
  }
  const rememberOutput = (rel: string, source: string, dependencyStamp = ''): void => {
    const dest = resolve(outRoot, rel)
    sourceStamps.set(rel, statStamp(source) + '\0' + dependencyStamp)
    outputStamps.set(rel, outputStamp(dest))
  }
  // 只跳过**顶层**的 renderer/（见上）；深层同名目录不受影响，避免误伤页面里的 assets/renderer/
  const EXCLUDE_TOP_DIRS = new Set(['renderer'])
  // 需要跟随目录结构拷贝的资源扩展名（新增内部页资源类型时在此登记）
  const COPY_EXTS = new Set([
    '.js', '.cjs', '.mjs',
    '.html', '.css',
    '.json', '.webmanifest',
    '.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico',
    '.woff', '.woff2', '.ttf', '.otf'
  ])
  function walk(dir: string, rel: string): WalkedFile[] {
    if (!fs.existsSync(dir)) return []
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    const result: WalkedFile[] = []
    for (const e of entries) {
      if (!rel && e.isDirectory() && EXCLUDE_TOP_DIRS.has(e.name)) continue
      const full = resolve(dir, e.name)
      if (e.isDirectory()) {
        result.push(...walk(full, rel ? `${rel}/${e.name}` : e.name))
      } else {
        const ext = extname(e.name).toLowerCase()
        if (COPY_EXTS.has(ext)) result.push({ full, rel: rel ? `${rel}/${e.name}` : e.name })
      }
    }
    return result
  }
  return {
    name: 'copy-main-sources',
    async run() {
      const files = walk(root, '')
      const tsFiles = walkTs(root, '')
      for (const file of files) {
        if (!INJECTABLE_PAGE_HTML.test(file.rel)) continue
        const host = INJECTABLE_PAGE_HTML.exec(file.rel)?.[1]
        const entry = /<script\b[^>]*type=["']module["'][^>]*src=["']\.\/([^"']+)["']/i.exec(fs.readFileSync(file.full, 'utf8'))?.[1]
        if (host && entry) downstreamOutputs.add(`pages/${host}/${entry.replace(/\.ts$/i, '.js')}`)
      }
      let count = 0
      let tsCount = 0
      let reused = 0
      // 本轮的共享样式表（每次构建重新读，见 readSharedCss）
      const sharedCss = readSharedCss()
      // 左侧导航占位规则（每次构建重新读，见 loadShellRules）
      const shell = await loadShellRules()
      // HTML 的内联结果依赖共享 CSS、页面自己的所有 CSS 与 shell 占位规则。
      // 使用内容而非 mtime：同尺寸写回、格式化工具保留时间戳也不会漏更新。
      const sharedVersion = JSON.stringify([...sharedCss.entries()].sort(([a], [b]) => a.localeCompare(b))) + '\0' + JSON.stringify(shell)
      const pageCssVersion = files
        .filter((file) => /\.css$/i.test(file.rel))
        .map((file) => `${file.rel}:${statStamp(file.full)}`)
        .join('|')
      /** 页面里"引了共享层、但那一条没登记同步"的裸名（见 rewriteSharedSpecifiers） */
      const unregistered: string[] = []
      for (const f of files) {
        const dest = resolve(outRoot, f.rel)
        const dependencyStamp = INJECTABLE_PAGE_HTML.test(f.rel)
          ? sharedVersion + '\0' + pageCssVersion
          : ''
        if (canReuse(f.rel, f.full, dependencyStamp)) {
          reused++
          continue
        }
        fs.mkdirSync(resolve(dest, '..'), { recursive: true })
        // 内部页（pages/**）：共享层裸名要在**落盘那一刻**改写成 hira://shared/…
        // —— 见 rewriteSharedSpecifiers 顶部那段（这是全白屏的根因所在）。
        // 其余文件（main / preload）原样复制：它们跑在 Node 里，裸名本来就能解析。
        if (f.rel.startsWith('pages/') && /\.(js|mjs|cjs)$/i.test(f.rel)) {
          const { code, skipped } = rewriteSharedSpecifiers(fs.readFileSync(f.full, 'utf8'))
          fs.writeFileSync(dest, code)
          for (const rel of skipped) unregistered.push(`${f.rel} → ${rel}`)
        } else if (INJECTABLE_PAGE_HTML.test(f.rel)) {
          // 内部页 HTML 的**统一**改写（逐页手写必然漏，漏一个就是"那一页没图标 /
          // 首帧多等一次样式请求 / 切页抖一下"）：
          //   ① 左侧导航占位标记（markShellPlaceholder）；② favicon（injectPageIcon）；
          //   ③ 共享样式内联（inlineSharedCss）；④ 页面自己的样式内联（inlinePageCss）。
          const pageMatch = INJECTABLE_PAGE_HTML.exec(f.rel)
          if (!pageMatch) continue
          const host = pageMatch[1]
          const html = inlinePageCss(
            inlineSharedCss(
              injectPageIcon(
                markShellPlaceholder(fs.readFileSync(f.full, 'utf8'), host, shell),
                f.rel
              ),
              sharedCss
            ),
            resolve(root, f.rel.slice(0, f.rel.lastIndexOf('/')))
          )
          fs.writeFileSync(dest, html)
        } else if (/^main\/preload\/[^/]+\.js$/i.test(f.rel)) {
          // main 侧注册的 frame / session 级 preload（REGISTER_PRELOAD_SCRIPT 走的那几份）：
          // 每个 frame 都要**先解析完它、再跑页面脚本** —— 注释在这条链上是纯成本。
          // 与 out/preload/* 同口径：只去空白 / 折叠语法，**不重命名标识符**（栈帧可读）。
          // 压不动就原样落盘：宁可大一点，也不能因此丢功能。
          const code = fs.readFileSync(f.full, 'utf8')
          let out = code
          try {
            const min = transformSync(code, {
              loader: 'js',
              minifyWhitespace: true,
              minifySyntax: true,
              legalComments: 'none',
              target: 'node20',
              logLevel: 'silent'
            })
            if (min && min.code && min.code.length < code.length) out = min.code
          } catch (err) {
            console.warn(`[copy-main-sources] preload 压缩跳过 ${f.rel}:`, errorMessage(err))
          }
          fs.writeFileSync(dest, out)
          console.log(`[preload-minify] main/${f.rel} ${code.length} → ${out.length} bytes`)
        } else {
          fs.copyFileSync(f.full, dest)
        }
        rememberOutput(f.rel, f.full, dependencyStamp)
        count++
      }
      if (unregistered.length) {
        console.warn(
          '[copy-main-sources] 以下共享层模块被内部页引用，但**没有登记同步** ——\n' +
            '  页面是静态页，拿不到它，运行期会 404（表现为整页白屏）。\n' +
            '  请把路径登记进 electron.vite.config.js 的 SHARED_PAGES_MODULES / _DIRS / _ASSETS：'
        )
        for (const line of unregistered) console.warn('   · ' + line)
      }
      // TypeScript 源：转译成 .js 落盘（不保留 .ts，避免 Node 误 require 原始文件）。
      // 未变化文件直接跳过；变化批次交给 esbuild 并发服务，避免数百次同步往返。
      const dirtyTs = tsFiles.filter((f) => !canReuse(f.rel.replace(/\.ts$/i, '.js'), f.full))
      const transformOne = async (f: WalkedFile): Promise<void> => {
        const outRel = f.rel.replace(/\.ts$/i, '.js')
        const dest = resolve(outRoot, outRel)
        const source = fs.readFileSync(f.full, 'utf8')
        const transformed = await esbuildTransform(source, {
          loader: 'ts',
          // main / preload 走 Node CJS；pages 是浏览器静态模块，必须保留 ESM，
          // 否则 bundlePageEntries 会把协议 URL 外部化成浏览器不存在的 require()。
          format: outRel.startsWith('pages/') ? 'esm' : 'cjs',
          target: 'node20',
          sourcefile: f.rel,
          sourcemap: false
        })
        const code = outRel.startsWith('pages/')
          ? rewriteSharedSpecifiers(transformed.code).code
          : transformed.code
        fs.mkdirSync(resolve(dest, '..'), { recursive: true })
        fs.writeFileSync(dest, code)
        rememberOutput(outRel, f.full)
      }
      let nextTs = 0
      const workerCount = Math.min(8, Math.max(1, dirtyTs.length))
      await Promise.all(Array.from({ length: workerCount }, async () => {
        for (;;) {
          const index = nextTs++
          const file = dirtyTs[index]
          if (!file) return
          await transformOne(file)
          tsCount++
        }
      }))
      if (tsFiles.length > dirtyTs.length) {
        reused += tsFiles.length - dirtyTs.length
      }
      // ── 清除陈旧拷贝 ───────────────────────────────────────────────────
      // `main` / `preload` 的 `emptyOutDir` 必须为 false（里面混着 rollup 产物与拷贝
      // 源码，清空会连入口 bundle 一起删）。代价是：**源码里删掉一个文件，旧产物会
      // 永远留在 out/ 里**，而 electron-builder 打的正是 `out/**` —— 死文件会跟着
      // 进安装包，也让"grep 产物"这种排查被陈旧副本误导。
      // 因此这里按"本次真正拷贝/转译出来的清单"反向清理，只扫本插件负责的两棵子树，
      // 并跳过构建期生成物（rollup 入口 / chunks / 共享契约目录）。
      const expected = new Set(files.map((f) => f.rel))
      for (const f of tsFiles) expected.add(f.rel.replace(/\.ts$/i, '.js'))
      const expectedKey = [...expected].sort().join('\0')
      const structureChanged = expectedKey !== lastExpectedKey
      if (structureChanged) {
        const OUT_SKIP = new Set(['main/index.js'])
        for (const top of ['main', 'pages']) {
          const base = resolve(outRoot, top)
          if (!fs.existsSync(base)) continue
          for (const rel of walkOut(base, top)) {
            if (OUT_SKIP.has(rel)) continue
            if (rel.startsWith('main/chunks/') || rel.startsWith('pages/_shared/')) continue
            if (expected.has(rel)) continue
            fs.rmSync(resolve(outRoot, rel), { force: true })
            console.log(`[copy-main-sources] 清理陈旧产物 ${rel}`)
          }
        }
        lastExpectedKey = expectedKey
      }
      // 文件清掉了，空目录还留着 —— 改名 / 删子目录的页面会在 `out/pages/<host>/`
      // 下留一个空壳。功能上无害（协议只认含 index.html 的目录），但产物里出现
      // 来源不明的空目录，排查时会被误当成"还有一份实现"。
      if (count || tsCount || structureChanged) pruneEmptyDirs(resolve(outRoot, 'pages'))
      console.log(
        `[copy-main-sources] copied ${count} asset files + transpiled ${tsCount} .ts, reused ${reused} (preserving dir structure)`
      )
    }
  }
}

/** 自底向上删掉 `dir` 下的空目录（`dir` 本身保留）。 */
function pruneEmptyDirs(dir: string): void {
  if (!fs.existsSync(dir)) return
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue
    const full = resolve(dir, e.name)
    pruneEmptyDirs(full)
    if (fs.readdirSync(full).length === 0) fs.rmdirSync(full)
  }
}

/** 递归列出 out 下已存在的文件（返回相对 out/ 的 posix 路径），供陈旧产物清理用。 */
function walkOut(dir: string, rel: string): string[] {
  const result: string[] = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const next = `${rel}/${e.name}`
    if (e.isDirectory()) result.push(...walkOut(resolve(dir, e.name), next))
    else result.push(next)
  }
  return result
}

/** 递归收集 `*.ts`（`.d.ts` 除外）—— 与 walk 同构，仅扩展名不同。 */
function walkTs(dir: string, rel: string): WalkedFile[] {
  if (!fs.existsSync(dir)) return []
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  const result: WalkedFile[] = []
  for (const e of entries) {
    // 与 walk 同一口径：顶层 renderer/ 归 Vite 管，转译产物不得覆盖它的构建产物
    if (!rel && e.isDirectory() && e.name === 'renderer') continue
    const full = resolve(dir, e.name)
    if (e.isDirectory()) {
      result.push(...walkTs(full, rel ? `${rel}/${e.name}` : e.name))
    } else if (/\.ts$/i.test(e.name) && !/\.d\.ts$/i.test(e.name)) {
      result.push({ full, rel: rel ? `${rel}/${e.name}` : e.name })
    }
  }
  return result
}

/** 构建期增量签名：只读元数据，不读文件正文；ctime 兜住同尺寸写回。 */
function stampPath(file: string): string {
  try {
    const stat = fs.statSync(file)
    if (stat.isDirectory()) {
      const parts: string[] = []
      for (const entry of fs.readdirSync(file, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        parts.push(entry.name + ':' + stampPath(resolve(file, entry.name)))
      }
      return parts.join('|')
    }
    return `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`
  } catch {
    return 'missing'
  }
}

function stampPaths(paths: Iterable<string>): string {
  return [...paths].sort().map((file) => `${file}\0${stampPath(file)}`).join('\n')
}

function buildInputs(metafile: { inputs: Record<string, unknown> } | undefined): string[] {
  if (!metafile) return []
  return Object.keys(metafile.inputs)
    .filter((file) => !file.startsWith('<') && !file.includes('\0'))
    .map((file) => resolve(ROOT_DIR, file))
}

/**
 * 需要让 `hira://` 内部页**只读**引用的共享模块（canonical 真源都在
 * `packages/shared-types/dist/esm/`，由 TS 真源构建）。新增一份只需在此登记文件名。
 *
 * · ipc-channels.mjs    IPC 通道表（runtime.js 相对导入）
 * · permission-labels.mjs 权限类型 → 中文名（pages/permissions 走 hira://shared 别名导入）
 * · extension-labels.mjs  扩展运行时状态 → 中文名（pages/extensions 走 hira://shared 别名导入）
 * · format-size.mjs    体积文本（runtime.js 转发为 fmtSize；标签 hover 预览同源引用）
 * · favicon-src.mjs    站点图标来源解析（内部页 faviconBadge / 面板 createFaviconBadge 同源）
 * · file-icon.mjs      下载项文件图标（类型表 + 真实图标取数器；页面 / 面板 / 下载栏同源）
 * · theme-background.mjs 背景层渲染器（图片 / 渐变 / 视频）——
 *                        外壳（打包 ESM）与内部页（未打包静态页）**必须**跑同一份，
 *                        否则会出现"窗口上好好的、新标签页上不对"。
 * · form-fill.mjs      地址 / 支付卡的**字段表与掩码**（pages/formfill 走 hira://shared 别名导入）——
 *                      页面画表单、主进程做摘要，两边的字段键名必须逐字一致。
 * · font-stack.mjs     UI / 等宽字体栈的唯一真源（theme.mjs 相对导入它）——
 *                      必须跟着 theme.mjs 一起复制，少一份就是
 *                      `Could not resolve "./font-stack.mjs"` + `shared registered but not served`。
 */
const SHARED_PAGES_MODULES = [
  'ipc-channels.mjs',
  // preload 可见的通道子集（零依赖）：主表与它合并，preload 只内联这一小份。
  // 必须跟着 ipc-channels.mjs 一起复制 —— 主表 import 了它，少一份就解析不到。
  'ipc-channels-preload.mjs',
  'permission-labels.mjs',
  'extension-labels.mjs',
  'format-size.mjs',
  // 「算不算普通网页」的协议判据 + 站点键：favicon-src.mjs 与内部页都依赖它，
  // 必须跟着一起复制 —— 少一份就是 `Could not resolve "./url-protocols.mjs"`。
  'url-protocols.mjs',
  'favicon-src.mjs',
  'file-icon.mjs',
  // 下载可视量的唯一口径（快照 + 实时进度 → 单一口径）+ 状态词：
  // 下载面板 / 下载条 / 内部下载页必须同一份，否则同一条下载会出现两种状态说法。
  'download-view.mjs',
  'theme-background.mjs',
  // 主题键名（app.theme / 调度 / 私密主题 / 用户主题）真源：主进程 applier、
  // 内部页 runtime 的主题自愈与域层默认值必须同一份，否则"改了设置颜色不刷新"。
  // font-stack.mjs 是 theme.mjs 的相对依赖（字体栈真源），必须紧跟其后一起复制。
  'theme.mjs',
  'font-stack.mjs',
  'form-fill.mjs',
  // 自动化（D2 命令链 / D3 手势）：自动化页与主进程共用同一份命令目录与形状规则。
  'automation.mjs',
  // 工作区规则：规则形状 / URL 通配匹配在自动化页与主进程控制器之间共用。
  'workspace-rules.mjs',
  'download-rules.mjs',
  // 空间图标的 id 白名单 / 别名 / 默认分配：domain 写库校验、内部页选择器、
  // 渲染层绘制必须同一张表（否则「存得进去、画不出来」）。
  'space-icon.mjs',
  // 签名公钥的三级信任（official / community / local）与查找优先级：
  // 插件页的公钥区（导入级别下拉 / 徽标）与主进程信任目录必须同一份，
  // 否则「下拉里能选、主进程不认」。
  'plugin-trust.mjs',
  // 跨层共用的字形路径字面量（浏览器 UI / 内部页 / hira://page-icon 三方同一份）：
  // page-icon.mjs 与 _shared/icons.js 都 import 它，少一份就解析不到。
  'icon-paths.mjs',
  // 内部页字形表（host → 字形名 → 路径数据）：标签栏徽标（hira://page-icon）与
  // 内部页外壳导航（_shared/shell.js）必须画同一套字形。
  'page-icon.mjs',
  // 键盘快捷键目录 + 组合键归一：主进程 keybindings.js 与内部页 hira://shortcuts
  // 必须读同一份（分组 / 名称 / 默认键位 / 录制规则），否则页面显示的和实际能按的对不上。
  'keybindings.mjs',
  // 搜索模板 → URL 的唯一换算规则：新标签页搜索框与地址栏（打包侧）必须同一份，
  // 否则自定义引擎写 `{query}` 时会出现"地址栏对、首页错"。
  'search-url.mjs',
  // 内置搜索引擎表（id / 展示名 / 模板 / 缺省引擎）：域层、设置项默认值与
  // 新标签页搜索框的兜底模板必须读同一份，避免"下拉里有、首页搜错站"。
  'search-engines.mjs',
  // 布局真源（键名 / 预设 / 预设反推）：OOBE 的布局步骤直接读它落盘，
  // 不允许在页面里手抄一遍键名（抄错一个就是"选了没生效"）。
  'layout.mjs',
  // 设置大类词表（id / 中文标题 / 图标 / 导航顺序）：内部页外壳导航
  // （_shared/shell-registry.ts）与主进程设置分区共用，禁止任何一处再手抄组名。
  'settings-groups.mjs',
  // 内部页地址的唯一拼法（零依赖原语）：settings-groups / 分享 / 错误页都引它，
  // 少复制一份就是 `Could not resolve "./page-url.mjs"`。
  'page-url.mjs',
  // 内部页身份表（host / 中文名 / 字形 / 侧栏分组）+ 唯一地址拼法 pageUrl()：
  // 侧栏（shell-registry）、新标签页快捷入口、设置页「内部页面」清单都从它派生。
  'pages.mjs',
  // 分享链接的唯一拼法 / 解析：分享页（hira://shared/share.mjs）与渲染层共用同一份，
  // 否则「地址栏拼的」和「页面读的」会各有一套编码规则。
  'share.mjs',
  // 点击打开意图（Ctrl/Cmd/中键 → 后台新标签 …）：内部页统一出口 openLink 读它，
  // 与网页侧 Chromium 的 disposition 口径对齐，禁止各页面再手写一遍修饰键判断。
  'link-intent.mjs',
  // 地址栏命令表 + bangs：新标签页搜索框与内部页共用同一份命令 / 引擎清单。
  'commands.mjs',
  // 打印纸张 / 边距词表 + 缺省值：IPC 契约、主进程收口与打印预览页下拉必须同一份，
  // 否则「下拉里能选、主进程当非法值丢掉」。
  'print.mjs',
  // 中文星期名（长/短两表）：历史分组标题、新标签页日期/时间小组件共用，短表由长表派生。
  'weekday.mjs',
  // 启动 / 主页（键名 + 模式取值 + 默认值）：OOBE 启动步骤与收尾回顾直接读它，
  // 不允许页面手抄档位值（抄错就是"选了没生效"）。
  'startup.mjs',
  // PDF 阅读器（开关键名 / 缩放档位 / 默认值）：内置 PDF 页读默认缩放必须与设置页同源。
  'pdf.mjs',
  // 扩展系统设置键名（开发者模式开关）：扩展页与设置页 / 主进程必须读同一份。
  'extensions-settings.mjs',
  // 软件更新偏好（键名 / 通道词表 / 周期护栏）：关于页的更新面板与主进程更新服务同源。
  'update-settings.mjs',
  // 书签标签的唯一真源（系统标签映射 / 计数 / 树过滤）：domain 写路径、
  // 收藏面板与内部书签页必须同一份，否则「面板过滤得到、页面过滤不到」。
  'bookmark-tags.mjs',
  // 「设为默认浏览器」的展示契约（按钮文案 / 回读间隔 / 提示语）：设置页的
  // schema action 与 OOBE 阶段 4 共用同一份，两边不许各写一套文案。
  'associations.mjs'
]

/**
 * 需要整棵复制过去的共享**子目录**（产物来自 `packages/shared-types/dist/esm/`）。
 * 与 SHARED_PAGES_MODULES 是同一套机制，只差"一个文件"与"一棵树"：
 * 内部页用 `hira://shared/<dir>/<file>` 引用（目录别名见 hira-protocol.js#ASSET_ALIASES）。
 *
 * · news/ —— 新闻源清单 + 取数 / 缓存 / 降级（首页新闻卡、新闻页、侧栏 Live Folders 共用）。
 *   它是唯一一个**同时**被"打包的渲染层"与"不打包的静态内部页"引用的模块树，所以两边都得能解析：
 *     渲染层 → workspace 裸名 `@hira-ng/shared-types/src/news/index.mjs`（打包器认）；
 *     内部页 → `hira://shared/news/index.mjs`（浏览器只认 URL，**裸名解析不了**）。
 *   注意树内的相对导入（`./service.mjs`、`../http.mjs`）必须**原样保留结构**，
 *   所以这里整目录递归复制，不能摊平到一个目录里。
 *
 * ⚠ 内部页是**不打包**的静态页：它里面的任何裸模块说明符（`@hira-ng/...`）
 *   都会让整张模块图解析失败 → **整页白屏**（不是"少个组件"，是连页面外壳都没有）。
 *   前车之鉴见本文件顶部关于 renderer/ 的那段说明。新增跨层共享模块时，
 *   要么登记到上面两个清单里用 `hira://shared/` 引，要么就别在内部页里用裸名。
 */
const SHARED_PAGES_DIRS = ['news', 'themes']

/**
 * 同样要同步给内部页、但真源在别处的资产（目前只有层级 token 表）。
 *
 * 为什么需要：`pages/newtab` 的看板用 `var(--hira-z-*)` 表达层叠（本项目唯一的
 * z-index 口径，门禁见 scripts/check-z-index.cjs）。而那张表真源在
 * `packages/shared-ui-tokens/layers.css`，是给**打包的渲染层**用的 ——
 * 内部页是"原样拷贝、不打包"的静态页，拿不到它，于是那些 z-index 声明全都成了
 * 无效声明（表现：拖拽中的卡片会钻到后面的卡片下面）。
 * 把它按同一套机制复制过去，取值仍然是**一份真源**。
 */
const SHARED_PAGES_ASSETS = [
  { from: resolve(ROOT_DIR, 'packages/shared-ui-tokens/layers.css'), name: 'layers.css' },
  // 「从 Chrome / Edge 一键导入」卡片：OOBE 迁移步与导入数据页**共用同一份**组件与样式，
  // 两个页面都写 `<link rel="stylesheet" href="hira://shared/browser-import.css">`，
  // 构建期由 inlineSharedCss 内联（与 base.css 同一条路径）。
  {
    from: resolve(ROOT_DIR, 'apps/app-main/src/pages/_shared/browser-import.css'),
    name: 'browser-import.css'
  }
]

/** 共享层真源在**页面源码**里的裸名前缀（写在源码里最顺手，也最接近"真源在哪"）。 */
const SHARED_SRC_PREFIX = '@hira-ng/shared-types/src/'
/** 同一个模块在**内部页运行时**的可达写法（hira://shared/* → out/pages/_shared/*）。 */
const SHARED_URL_PREFIX = 'hira://shared/'

/**
 * 这个共享层相对路径（如 `news/index.mjs`）会被同步到 `out/pages/_shared/` 吗？
 * 上面三个清单只要有一个覆盖它就算。
 */
function isSharedPagesPath(rel: string): boolean {
  if (SHARED_PAGES_MODULES.includes(rel)) return true
  if (SHARED_PAGES_ASSETS.some((a) => a.name === rel)) return true
  return SHARED_PAGES_DIRS.some((dir) => rel === dir || rel.startsWith(dir + '/'))
}

/**
 * 把**内部页源码**里的共享层裸模块名改写成 `hira://shared/...`。
 *
 * ── 为什么必须有这一步（本项目踩过两次的坑）────────────────────────────────
 * 内部页是**不打包**的静态页（hira:// 协议直读磁盘，没有打包器：
 * `node_modules` / workspace 解析、import maps 一概不存在）。裸模块名进浏览器
 * 就是"解析失败"，而失败的是**入口模块** —— 于是整张模块图一个都不执行，
 * 页面外壳、选项卡、看板全是 JS 生成的 ⇒ **一整片白**。
 * 症状极具迷惑性：js 语法没错、css 没错、单看每个文件都对。
 *
 * 所以这里在**落盘那一刻**统一改写：源码里可以照写 `@hira-ng/shared-types/src/news/…`
 * （和打包侧同一个名字、同一条心智），复制到 out/ 时自动变成页面认得的 URL。
 * 两边一次都不用记得"这里要写另一种写法"。
 *
 * ⚠ 只改写**已登记**的路径（isSharedPagesPath）。没登记的**原样留着** ——
 *   那会变成一个 404 白屏，不如让它保持裸名，交给
 *   `scripts/check-page-modules.cjs` 明确报错："这个裸名没有登记、页面拿不到"。
 *   宁可在门禁上炸，也不要在运行期静默 404。
 *
 * 只动 import / export 子句（含 `import '…'` 副作用导入），不碰注释与普通字符串。
 * @param {string} code
 * @returns {{ code:string, skipped:string[] }} skipped = 未登记、因而没改写的路径
 */
function rewriteSharedSpecifiers(code: string): { code: string; skipped: string[] } {
  const skipped: string[] = []
  const esc = SHARED_SRC_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`(\\bfrom\\s*|\\bimport\\s*)(['"])${esc}([^'"]+)\\2`, 'g')
  const out = code.replace(re, (match: string, lead: string, quote: string, rel: string) => {
    if (!isSharedPagesPath(rel)) {
      skipped.push(rel)
      return match
    }
    return `${lead}${quote}${SHARED_URL_PREFIX}${rel}${quote}`
  })
  return { code: out, skipped }
}

/**
 * 递归复制一棵目录树，**保留相对结构**（子目录内的相对导入才解析得到）。
 * @param {string} from 源目录（绝对路径）
 * @param {string} to 目标目录（绝对路径）
 * @param {string} [prefix] 已复制项的相对路径前缀（仅用于日志）
 * @returns {string[]} 已复制的相对路径列表
 */
function copyDirTree(from: string, to: string, prefix = ''): string[] {
  const copied: string[] = []
  fs.mkdirSync(to, { recursive: true })
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = resolve(from, entry.name)
    const dest = resolve(to, entry.name)
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) copied.push(...copyDirTree(src, dest, rel))
    else {
      fs.copyFileSync(src, dest)
      copied.push(rel)
    }
  }
  return copied
}

/**
 * Vite 插件：把共享真源同步到内部页可见的位置。
 *
 * 为什么需要：`hira://` 内部页是没有打包器的静态页面，它只能 import 静态文件；
 * 而真源是 `packages/shared-types/src/*.ts`，构建产物在 `dist/esm/`。历史做法是在 `pages/_shared/` 里
 * **手抄一份**（`runtime.js` 手抄 IPC_ROUTES 子集、`permission-labels.js` 手抄中文名）
 * —— 两份必然漂移（新通道只登记在 canonical 表里、改了中文名只对一处生效）。
 *
 * 这里把 canonical 文件按原样复制到 `out/pages/_shared/`，再由内部页用
 * `hira://shared/<file>` 引用。于是「跨层共享的映射」只剩**一份真源**。
 *
 * 三类来源（都是"登记一次、双向同源"）：
 *   SHARED_PAGES_MODULES 单个文件 → `hira://shared/<file>`
 *   SHARED_PAGES_DIRS    整棵目录 → `hira://shared/<dir>/<file>`（保留结构）
 *   SHARED_PAGES_ASSETS  别处的资产 → `hira://shared/<name>`
 */
function syncSharedContractsPlugin() {
  const srcDir = resolve(ROOT_DIR, 'packages/shared-types/dist/esm')
  const destDir = resolve(ROOT_DIR, 'out/pages/_shared')
  let lastSignature = ''
  return {
    name: 'sync-shared-contracts',
    run() {
      fs.mkdirSync(destDir, { recursive: true })
      const sourcePaths = [
        ...SHARED_PAGES_MODULES.map((name) => resolve(srcDir, name)),
        ...SHARED_PAGES_DIRS.map((dir) => resolve(srcDir, dir)),
        ...SHARED_PAGES_ASSETS.map((asset) => asset.from)
      ]
      const signature = stampPaths(sourcePaths)
      const outputsPresent = [
        ...SHARED_PAGES_MODULES.map((name) => resolve(destDir, name)),
        ...SHARED_PAGES_DIRS.map((dir) => resolve(destDir, dir)),
        ...SHARED_PAGES_ASSETS.map((asset) => resolve(destDir, asset.name))
      ].every((file) => fs.existsSync(file))
      if (lastSignature === signature && outputsPresent) return
      const copied = []
      for (const name of SHARED_PAGES_MODULES) {
        const src = resolve(srcDir, name)
        if (!fs.existsSync(src)) {
          console.warn('[sync-shared-contracts] source not found:', src)
          continue
        }
        fs.copyFileSync(src, resolve(destDir, name))
        copied.push(name)
      }
      for (const dir of SHARED_PAGES_DIRS) {
        const src = resolve(srcDir, dir)
        if (!fs.existsSync(src)) {
          console.warn('[sync-shared-contracts] dir not found:', src)
          continue
        }
        copied.push(...copyDirTree(src, resolve(destDir, dir), dir))
      }
      for (const asset of SHARED_PAGES_ASSETS) {
        if (!fs.existsSync(asset.from)) {
          console.warn('[sync-shared-contracts] asset not found:', asset.from)
          continue
        }
        fs.copyFileSync(asset.from, resolve(destDir, asset.name))
        copied.push(asset.name)
      }
      lastSignature = signature
      console.log(`[sync-shared-contracts] ${copied.join(', ')} → out/pages/_shared/`)
    }
  }
}

/**
 * Vite 插件：把内部页共享运行时（`hira://shared/runtime.js`）打成**自包含单文件**。
 *
 * ── 为什么要打 ────────────────────────────────────────────────────────
 * `runtime.js` 静态依赖 6 个共享模块（ipc-channels / format-size / favicon-src /
 * file-icon / theme-background）再经 `shell.js` 拖出 shell-registry + icons ——
 * 一个内部页要拿 `initTheme` 就要付 **9 次协议请求 + 9 个模块实例**。
 * 页面是**不打包**的静态页（浏览器只认 URL），所以这件事只能在构建期做。
 *
 * 打包后：同一个入口 1 次请求、1 次解析；页面里 `./runtime.js` 与
 * `hira://shared/runtime.js` 两种写法都指向同一个自包含文件，模块实例仍然唯一。
 *
 * ── 为什么必须在 sync-shared-contracts **之后** ───────────────────────
 * `runtime.js` 里的 `./ipc-channels.mjs` 等是**构建期复制过来**的 canonical 文件，
 * 源目录里并不存在；先复制、后打包，否则 esbuild 解析不到（会直接构建失败或漏依赖）。
 *
 * ── 压缩口径：只去空白与注释 ─────────────────────────────────────────
 * 目标是"少请求 / 少解析"，不是压体积。`minifyWhitespace` 恰好只做这两件事
 * （**不重命名标识符**、不改写语法），于是 stack 里函数名照样可读，
 * 而 132KB → 57KB —— 每次打开内部页少解析一半。
 * 完整源码与注释始终在 `apps/app-main/src/pages/_shared/`，产物不必留文档。
 */
function bundleSharedRuntimePlugin() {
  const entry = resolve(ROOT_DIR, 'out/pages/_shared/runtime.js')
  const sharedDir = resolve(ROOT_DIR, 'out/pages/_shared')
  const sourceDir = resolve(ROOT_DIR, 'apps/app-main/src/pages/_shared')
  let lastSignature = ''
  return {
    name: 'bundle-shared-runtime',
    // 异步步骤：esbuild 的 onResolve 插件只支持异步 API（`buildSync` 明确禁止 plugins）。
    // 由 hiraBuildPipelinePlugin **串行 await**，所以下一步开始时产物一定已就位。
    async run() {
      if (!fs.existsSync(entry)) {
        // 极早期构建 / 只跑 preload 时 pages 还没落盘 —— 不是错误，跳过即可
        return
      }
      const signature = stampPaths([
        sourceDir,
        ...SHARED_PAGES_MODULES.map((name) => resolve(sharedDir, name)),
        ...SHARED_PAGES_DIRS.map((dir) => resolve(sharedDir, dir)),
        ...SHARED_PAGES_ASSETS.map((asset) => resolve(sharedDir, asset.name))
      ])
      if (lastSignature === signature) return
      const before = fs.statSync(entry).size
      try {
        await esbuildBuild({
          entryPoints: [entry],
          outfile: entry,
          bundle: true,
          format: 'esm',
          platform: 'browser',
          target: 'chrome128',
          allowOverwrite: true,
          // 只去空白/注释（不重命名标识符）：产物是给浏览器读的，不是给人读的；
          // 源码与文档始终在源码目录（见本函数上方"压缩口径"）。
          minifyWhitespace: true,
          legalComments: 'none',
          logLevel: 'silent',
          plugins: [
            {
              // 共享模块之间用**协议绝对路径**互相引用（如 icons.js → hira://shared/page-icon.mjs）。
              // 浏览器认这个 URL，esbuild 不认 —— 在构建期把它折回同目录下的文件。
              // 只有这样 `hira://shared/*` 才能既在运行期被页面直接 import，
              // 又在构建期被原地打进 runtime.js。
              name: 'hira-shared-scheme',
              setup(build) {
                build.onResolve({ filter: /^hira:\/\/shared\// }, (args) => ({
                  path: resolve(sharedDir, args.path.slice('hira://shared/'.length))
                }))
              }
            }
          ]
        })
      } catch (err) {
        console.warn('[bundle-shared-runtime] 打包失败，退回多文件版本（功能不受影响）:', errorMessage(err))
        return
      }
      const after = fs.statSync(entry).size
      lastSignature = signature
      console.log(`[bundle-shared-runtime] runtime.js 已自包含（${before} → ${after} bytes，9 请求 → 1）`)
    }
  }
}

/**
 * Vite 插件：把**页面自己的**模块图打成一个文件（构建期，就地覆盖入口）。
 *
 * ── 为什么需要 ────────────────────────────────────────────────────────
 * 内部页是"不打包的静态页"：一个页面有 N 个模块，浏览器就要按模块图的**深度**
 * 一层层发请求（`newtab.js` → `sections/*` → `widgets/*` → …）。这些请求虽同源、
 * 走的是进程内 LRU，但仍然是 4~5 个串行瀑布；新标签页每次打开都要付一遍。
 * 把整张图并成 1 个文件后：1 次请求、1 次解析、瀑布消失。
 *
 * ── 边界（很重要）─────────────────────────────────────────────────────
 * · **只合并页面自己的模块**：`hira://*` 协议 URL 一律 external（见 hira-protocol-external）。
 *   共享层有跨页面的"同一份实例"语义，把它们卷进来的代价是每页各存一份 130KB，
 *   解析与内存都会变差 —— 那不是优化。
 * · **只合并有真实图的页面**：先 `write: false` 跑一遍拿 metafile，输入 ≤ 1 的页面
 *   原地不动（26 个内部页里绝大多数是单模块，没必要为它们改产物）。
 * · **只去空白/注释，不重命名标识符**（与 bundleSharedRuntimePlugin 同口径）：
 *   目标是少请求 / 少解析，不是压体积；stack 里函数名仍然可读。
 * · 失败只 warn 并保留多文件（功能不受影响）—— 与 bundleSharedRuntimePlugin 同策略。
 *
 * ── 为什么必须在 sync-shared-contracts 之后 ────────────────────────────
 * 页面源码里的 `@hira-ng/shared-types/src/…` 已被 copyMainSourcesPlugin 改写成
 * `hira://shared/…`（见 rewriteSharedSpecifiers），而那份被引用的文件是
 * sync-shared-contracts 在**构建期**复制到 out/pages/_shared/ 的 —— 先复制再打包。
 */
function bundlePageEntriesPlugin() {
  const pagesDir = resolve(ROOT_DIR, 'out/pages')
  const srcPagesDir = resolve(ROOT_DIR, 'apps/app-main/src/pages')
  const cache = new Map<string, { inputs: string[]; signature: string }>()
  return {
    name: 'bundle-page-entries',
    async run() {
      if (!fs.existsSync(pagesDir)) return
      const dirs = fs
        .readdirSync(pagesDir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && e.name !== '_shared')
      for (const d of dirs) {
        const htmlPath = resolve(pagesDir, d.name, 'index.html')
        if (!fs.existsSync(htmlPath)) continue
        const m = /<script\b[^>]*type=["']module["'][^>]*src=["'](\.\/[^"']+)["']/i.exec(
          fs.readFileSync(htmlPath, 'utf8')
        )
        if (!m) continue
        const entry = resolve(pagesDir, d.name, m[1])
        const cacheKey = `${d.name}/${m[1]}`
        const cached = cache.get(cacheKey)
        if (cached && cached.signature === stampPaths(cached.inputs) && fs.existsSync(entry)) continue
        try {
          const result = await esbuildBuild({
            entryPoints: [entry],
            outfile: entry,
            bundle: true,
            format: 'esm',
            platform: 'browser',
            target: 'chrome128',
            write: false,
            allowOverwrite: true,
            minifyWhitespace: true,
            legalComments: 'none',
            logLevel: 'silent',
            metafile: true,
            plugins: [
              {
                // 协议 URL 一律 external：
                //  · `hira://shared/*` 是共享层（运行期那一个自包含文件，不复制进每一页）；
                //  · `hira://pdfjs/*` 这类是主进程另开的资源端点（pdf / print-preview 在用），
                //    本来就不是磁盘上的相对模块，esbuild 无从解析，也不该被打进来。
                name: 'hira-protocol-external',
                setup(build) {
                  build.onResolve({ filter: /^(?:[a-z][a-z0-9+.-]*:\/\/|\/\/)/i }, (args) => ({
                    path: args.path,
                    external: true
                  }))
                }
              }
            ]
          })
          const rawInputs = buildInputs(result.metafile)
          const mappedInputs: string[] = []
          let cacheable = true
          for (const input of rawInputs) {
            const pageRoot = resolve(pagesDir, d.name)
            if (input !== pageRoot && !input.startsWith(pageRoot + '\\') && !input.startsWith(pageRoot + '/')) {
              mappedInputs.push(input)
              continue
            }
            const relative = input.slice(pageRoot.length + 1)
            const base = resolve(srcPagesDir, d.name, relative.replace(/\.(?:mjs|cjs|js)$/i, ''))
            const candidates = [input, `${base}.ts`, `${base}.js`, `${base}.mjs`, `${base}.cjs`]
            const source = candidates.find((candidate) => fs.existsSync(candidate) && !(
              candidate === pagesDir || candidate.startsWith(pagesDir + '\\') || candidate.startsWith(pagesDir + '/')
            ))
            if (!source) {
              cacheable = false
              break
            }
            mappedInputs.push(source)
          }
          if (cacheable) {
            const signature = stampPaths(mappedInputs)
            cache.set(cacheKey, { inputs: mappedInputs, signature })
          }
          const inputs = rawInputs.length
          if (inputs <= 1) continue // 单模块页面：原地不动
          const out = result.outputFiles && result.outputFiles[0]
          if (!out) continue
          fs.writeFileSync(entry, out.text)
          if (cacheable) {
            const signature = stampPaths(mappedInputs)
            cache.set(cacheKey, { inputs: mappedInputs, signature })
          }
          console.log(
            `[bundle-page-entries] ${d.name}/${m[1].slice(2)} 已合并（${inputs} 模块 → 1，${out.text.length} bytes）`
          )
        } catch (err) {
          // 中文路径 / 未登记的裸名等：保留多文件版本即可，不影响功能
          console.warn(`[bundle-page-entries] ${d.name} 跳过:`, errorMessage(err))
        }
      }
    }
  }
}

/**
 * 需要**从源码**（而不是从 `out/` 的拷贝）打包的内部页。
 *
 * 只有一类页面会在这里：它要复用**打包侧**的实现（`plugins/**` 或 `renderer/shared/**`），
 * 而那些东西不在 `copyMainSourcesPlugin` 的拷贝树里 —— `out/pages/<host>/page.js` 里那条
 * 相对 import 在 `out/` 下根本不存在。
 *
 *   · AI 助手页：与侧栏面板 / 独立窗口装同一份 `panelDefinition`
 *     （`plugins/panel-ai.renderer.js`），绝不另写一套聊天 UI；
 *   · 设置页：复用渲染侧插槽宿主，挂载 `settings.custom-widget`。页面本身仍是
 *     `hira://settings` 静态内部页，只有入口模块从源码打包，不引入第二套 Vite 页面路由。
 */
const SOURCE_BUNDLED_PAGES = ['ai', 'settings']

/**
 * Vite 插件：把 `SOURCE_BUNDLED_PAGES` 里的页面从**源码**打成自包含单文件，覆盖 `out/` 产物。
 *
 * ── 为什么不能交给 `bundlePageEntriesPlugin` ──────────────────────────
 * 那个插件打的是 `out/pages/<host>/<entry>`（已经过 copy 落盘），而本页的依赖在
 * `apps/app-main/plugins/**` —— `out/` 下没有这棵树。于是必须在**源码**上跑 esbuild。
 *
 * ── 边界 ──────────────────────────────────────────────────────────────
 * · `hira://*` 协议 URL 一律 external（共享层运行期只有一份实例，不能每页各存一份）；
 * · `@hira-ng/shared-types/src/<已登记>` 也折成 `hira://shared/<rel>` external ——
 *   与 `rewriteSharedSpecifiers` 同一条判定（`isSharedPagesPath`），源码写法不变；
 * · 其余裸名（`@hira-ng/ui-common` 等）交给 esbuild 从 workspace 解析并**打进来**
 *   （内部页运行时没有打包器，裸名进浏览器就是白屏）。
 * · **失败即构建失败**（与 `bundlePageEntriesPlugin` 的"只 warn"不同）：本页若退回
 *   未打包的拷贝，浏览器会因解析不到 `plugins/**` 而整页白屏 —— 静默降级没有意义。
 *
 * 必须在 `copyMainSourcesPlugin` 之后（要读落盘的 index.html 定位入口）。
 */
function bundleSourcePagesPlugin() {
  const pagesDir = resolve(ROOT_DIR, 'out/pages')
  const srcPagesDir = resolve(ROOT_DIR, 'apps/app-main/src/pages')
  const cache = new Map<string, { inputs: string[]; signature: string }>()
  return {
    name: 'bundle-source-pages',
    async run() {
      for (const host of SOURCE_BUNDLED_PAGES) {
        const htmlPath = resolve(pagesDir, host, 'index.html')
        if (!fs.existsSync(htmlPath)) continue
        const m = /<script\b[^>]*type=["']module["'][^>]*src=["']\.\/([^"']+)["']/i.exec(
          fs.readFileSync(htmlPath, 'utf8')
        )
        if (!m) {
          throw new Error(`[bundle-source-pages] ${host}/index.html 里找不到 module 入口`)
        }
        const entry = resolve(srcPagesDir, host, m[1])
        const outfile = resolve(pagesDir, host, m[1])
        const cached = cache.get(host)
        if (cached && cached.signature === stampPaths(cached.inputs) && fs.existsSync(outfile)) continue
        let result
        try {
          result = await esbuildBuild({
            entryPoints: [entry],
            outfile,
            bundle: true,
            format: 'esm',
            platform: 'browser',
            target: 'chrome128',
            write: false,
            allowOverwrite: true,
            minifyWhitespace: true,
            legalComments: 'none',
            logLevel: 'silent',
            metafile: true,
            plugins: [
              {
                // 共享层：已登记的 canonical 文件走运行期 URL（与 rewriteSharedSpecifiers 同一判据），
                // 未登记的裸名照常解析（它们本来就会被拷进 out/pages/_shared/ 之外，只能打进来）。
                name: 'hira-shared-specifier',
                setup(build) {
                  build.onResolve({ filter: /^@hira-ng\/shared-types\/src\// }, (args) => {
                    const rel = args.path.slice('@hira-ng/shared-types/src/'.length)
                    if (!isSharedPagesPath(rel)) return undefined
                    return { path: SHARED_URL_PREFIX + rel, external: true }
                  })
                }
              },
              {
                // 协议 URL 一律 external（hira://shared/*、hira://page-icon 等）。
                name: 'hira-protocol-external',
                setup(build) {
                  build.onResolve({ filter: /^(?:[a-z][a-z0-9+.-]*:\/\/|\/\/)/i }, (args) => ({
                    path: args.path,
                    external: true
                  }))
                }
              }
            ]
          })
        } catch (err) {
          throw new Error(
            `[bundle-source-pages] ${host} 打包失败（本页依赖 plugins/**，不能退回未打包版本）：` +
              errorMessage(err)
          )
        }
        const out = result.outputFiles && result.outputFiles[0]
        if (!out) throw new Error(`[bundle-source-pages] ${host} 没有产物`)
        const inputs = buildInputs(result.metafile)
        cache.set(host, { inputs, signature: stampPaths(inputs) })
        fs.writeFileSync(outfile, out.text)
        const modules = inputs.length
        console.log(`[bundle-source-pages] ${host}/${m[1]} 已从源码打包（${modules} 模块 → 1，${out.text.length} bytes）`)
      }
    }
  }
}

/**
 * Vite 插件：把 `main` 侧五条**有先后依赖**的产物步骤串成一条**串行流水线**。
 *
 * ── 为什么必须串（不是洁癖，是构建正确性）──────────────────────────────
 * Vite 的 `closeBundle` 钩子是**并行**调用的 —— 实测日志里 copy 的中段日志
 * （preload-minify）会插到 sync 的汇总行之前。而下面几步是**硬依赖**：
 *
 *   copy（页面源码落盘、共享裸名改写成 hira://shared/…）
 *     → sync（把共享契约复制到 out/pages/_shared/）
 *     → bundleSharedRuntime（要读 sync 复制来的 ipc-channels.mjs 等）
 *     → bundleSourcePages（复用 plugins/** 的页面：要 copy 落盘的 index.html 定位入口）
 *     → bundlePageEntries（要读 copy 落盘的页面入口 + sync 的 themes/、news/）
 *
 * 各自挂 `closeBundle` 时，后一步可能在前一步还没写完时就开跑：
 * esbuild 解析不到模块 → 那一页随机「跳过」合并，或读到写到一半的入口文件。
 * 症状是**每次构建结果不一样**（页面少文件 / 白屏 / 产物里多一份未合并的入口），
 * 而且日志看起来"没有报错"。串行之后顺序确定，构建可复现。
 *
 * @param {ReadonlyArray<{ name: string, run: () => unknown }>} steps 顺序即依赖顺序
 */
function hiraBuildPipelinePlugin(steps: ReadonlyArray<{ name: string; run: () => unknown }>): Plugin {
  return {
    name: 'hira-build-pipeline',
    async closeBundle() {
      for (const step of steps) await step.run()
    }
  }
}

/**
 * 把标签页的非首屏能力编译成两个可在 sandbox preload 内按需求值的函数体。
 *
 * 不能把它们做成普通 ESM 依赖：Electron 的 sandbox 只允许单个自包含 preload，
 * 而静态 import 会在 document-start 一次性编译所有功能。虚拟模块把 esbuild 产物
 * 作为字符串注入核心 preload，真正求值时机由 tab-preload 的空闲/意图闸门控制。
 * 产物仍是 CJS 形状，执行器只注入受限的 `require('electron')`，安全边界不扩张。
 */
function lazyTabFeatureBundlesPlugin(): Plugin {
  const VIRTUAL_PREFIX = '\0hira-tab-features:'
  const ENTRIES = new Map<string, string>([
    ['interactive', resolve(ROOT_DIR, 'infra/infra-window/preload/tab-features-interactive.ts')],
    ['deferred', resolve(ROOT_DIR, 'infra/infra-window/preload/tab-features-deferred.ts')]
  ])

  return {
    name: 'hira-lazy-tab-features',
    enforce: 'pre',
    resolveId(source) {
      if (!source.startsWith('virtual:tab-features-')) return null
      return VIRTUAL_PREFIX + source.slice('virtual:tab-features-'.length)
    },
    async load(id) {
      if (!id.startsWith(VIRTUAL_PREFIX)) return null
      const name = id.slice(VIRTUAL_PREFIX.length)
      const entry = ENTRIES.get(name)
      if (!entry) this.error(`[lazy-tab-features] 未知能力组：${name}`)
      const result = await esbuildBuild({
        entryPoints: [entry],
        bundle: true,
        write: false,
        format: 'cjs',
        platform: 'browser',
        target: 'chrome128',
        external: ['electron'],
        minifyWhitespace: true,
        minifySyntax: true,
        legalComments: 'none',
        logLevel: 'silent'
      })
      const code = result.outputFiles?.[0]?.text || ''
      if (!code) this.error(`[lazy-tab-features] ${name} 产物为空`)
      // sourceURL 让 DevTools / CPU Profiler 能把延迟包与页面站点脚本区分开，
      // 也不影响求值时机与沙箱边界。
      return `export default ${JSON.stringify(`${code}\n//# sourceURL=hira-tab-features-${name}.js`)}`
    }
  }
}

/**
 * Vite/rollup 插件：让每个 preload 入口**各自内联**自己的本地模块，杜绝共享 chunk。
 *
 * ── 为什么必须这样 ─────────────────────────────────────────────────────
 * 所有 chrome 视图（外壳 / 面板 / 标签页 / 浮层）的 webPreferences 都是 `sandbox: true`
 * （见 infra/infra-window/src/webPreferences.js）。Electron 的 sandboxed preload 只有一个
 * 受限的 `require`：只认 `electron` 与少数内置模块，**相对路径一律拒绝** ——
 * 即便文件真实存在，报错也是具有迷惑性的 `module not found: ./chunks/xxx.js`。
 *
 * 而 rollup 对**多个入口共享的模块**默认会抽成 `chunks/*.js`，产物就变成
 * `shell.js → require("./chunks/xxx.js")`，于是外壳 / 面板 / 所有浮层的 preload
 * 全部在启动时静默失效（bridge 没挂上，页面表现像"脚本没跑"）。
 *
 * ── 做法 ─────────────────────────────────────────────────────────────
 * 给「入口 → 其本地依赖」这条边的模块 id 加一个按入口命名的查询串，并让这棵子树继续
 * 传递同一个标记。rollup 于是认为"每个入口都有自己的副本"，自然不产生共享 chunk。
 * 代价是同一份小模块在 N 个 preload 里各存一份 —— 这正是 sandbox 要求单文件所隐含的代价，
 * 且总量只有几 KB。
 *
 * `generateBundle` 里还留了一道门禁：若仍出现入口依赖其它 chunk，直接构建失败，
 * 避免以后再以"运行期静默失效"的形式回归。
 */
function preloadSelfContainedPlugin(): Plugin {
  const TAG = '?hira-preload-copy='
  const SHARED_TYPES_PREFIX = '@hira-ng/shared-types/src/'
  /** @type {Map<string, string>} 入口绝对路径 → 入口名 */
  const entryNames = new Map<string, string>()
  let outDir = ''

  function resolveSharedTypesSource(source: string): string | null {
    if (!source.startsWith(SHARED_TYPES_PREFIX)) return null
    const rel = source.slice(SHARED_TYPES_PREFIX.length).replace(/\.(?:mjs|js)$/, '')
    const base = resolve(ROOT_DIR, 'packages/shared-types/src', rel)
    for (const candidate of [`${base}.ts`, resolve(base, 'index.ts'), `${base}.mts`, `${base}.cts`]) {
      if (fs.existsSync(candidate)) return candidate
    }
    return null
  }

  return {
    name: 'hira-preload-self-contained',
    enforce: 'pre',
    configResolved(config) {
      outDir = config.build.outDir
      const input = config.build.rollupOptions.input
      if (!input || typeof input !== 'object') return
      for (const [name, file] of Object.entries(input)) {
        if (typeof file === 'string') entryNames.set(resolve(file), name)
      }
    },
    async resolveId(source, importer) {
      if (!importer) return null
      // preload 是 sandbox，裸包名会被 externalize 成运行期 require 并失败。
      // 所有 preload 共享层都按入口内联，和本地相对依赖走同一套标记。
      const sharedTypesSource = resolveSharedTypesSource(source)
      if (sharedTypesSource) {
        const tagAt = importer.indexOf(TAG)
        const importerFile = tagAt < 0 ? importer : importer.slice(0, tagAt)
        const tag = tagAt < 0 ? entryNames.get(resolve(importerFile)) : importer.slice(tagAt + TAG.length)
        if (!tag) return null
        return sharedTypesSource + TAG + tag
      }
      // 只处理本地相对/绝对导入：裸模块（electron 等）保持 external，不进包。
      if (!source.startsWith('.') && !isAbsolute(source)) return null
      const tagAt = importer.indexOf(TAG)
      const importerFile = tagAt < 0 ? importer : importer.slice(0, tagAt)
      // 标记来源：入口自己的直接依赖 → 用入口名；已在副本子树里 → 继承同一个标记。
      const tag = tagAt < 0 ? entryNames.get(resolve(importerFile)) : importer.slice(tagAt + TAG.length)
      if (!tag) return null
      const resolved = await this.resolve(source, importerFile, { skipSelf: true })
      if (!resolved || resolved.external) return null
      return resolved.id + TAG + tag
    },
    load(id) {
      const at = id.indexOf(TAG)
      if (at < 0) return null
      return fs.readFileSync(id.slice(0, at), 'utf8')
    },
    generateBundle(_options, bundle) {
      for (const [file, out] of Object.entries(bundle)) {
        if (out.type !== 'chunk' || !out.isEntry) continue
        // `imports` 里同时含外部模块（electron 等）—— 只有相对路径才意味着 chunk 拆分。
        const localImports = out.imports.filter((dep) => dep.startsWith('.'))
        if (localImports.length) {
          this.error(
            `[hira-preload-self-contained] ${file} 仍依赖其它 chunk：${localImports.join(', ')}\n` +
              '  sandbox preload 不能 require 本地文件，这会在运行期静默丢 bridge。'
          )
        }
        // 每个顶层文档都要**先解析这段 preload，再跑页面脚本** —— 体积直接趴在首屏关键
        // 路径上。只做「去空白注释 + 语法级折叠」（`minifyWhitespace`/`minifySyntax`），
        // **不重命名标识符**：栈帧与源码里的函数名逐字可读，排查线上问题不用对照构建产物。
        const before = out.code.length
        try {
          const min = transformSync(out.code, {
            loader: 'js',
            minifyWhitespace: true,
            minifySyntax: true,
            legalComments: 'none',
            target: 'chrome128',
            logLevel: 'silent'
          })
          if (min && min.code && min.code.length < before) out.code = min.code
        } catch (err) {
          // 压不动就保留原样：宁可大一点，也不能因为压缩失败丢 bridge。
          console.warn(`[preload-minify] ${file} 跳过:`, errorMessage(err))
        }
        console.log(`[preload-minify] ${file} ${before} → ${out.code.length} bytes`)
      }
      // 门禁通过 = 产物里不可能再有被引用的 chunk；清掉历史残留，避免误导排查。
      if (outDir) {
        fs.rmSync(resolve(outDir, 'chunks'), { recursive: true, force: true })
        // 同一类问题：删掉一个入口后旧产物会一直躺在 out/preload（emptyOutDir 为 false），
        // 而 electron-builder 打的是 out/**。这里只留本次构建真正产出的入口文件。
        const produced = new Set(
          Object.values(bundle)
            .filter((o) => o.type === 'chunk' && o.isEntry)
            .map((o) => o.fileName)
        )
        for (const name of fs.readdirSync(outDir)) {
          if (produced.has(name)) continue
          fs.rmSync(resolve(outDir, name), { recursive: true, force: true })
          console.log(`[preload] 清理陈旧产物 ${name}`)
        }
      }
    }
  }
}

/**
 * Development-only resolver for the canonical shared TypeScript sources.
 *
 * Renderer code imports shared contracts with the runtime suffix
 * (`@hira-ng/shared-types/src/foo.mjs`). In production those specifiers resolve
 * to the prebuilt dist files. In dev that makes Vite watch a directory that the
 * workspace build clears and rewrites file-by-file, producing reload storms and
 * transient "file does not exist" blank pages. Resolve the same specifier to its
 * `.ts` source in dev so Vite watches the editable file and HMRs atomically.
 */
function sharedTypesSourcePlugin(): Plugin {
  const sourceRoot = resolve(ROOT_DIR, 'packages/shared-types/src')
  const packagePrefix = '@hira-ng/shared-types/src/'
  const candidates = (base: string): string[] => {
    const stripped = base.replace(/\.(?:mjs|js|mts|cts)$/i, '')
    return [
      `${stripped}.ts`,
      resolve(stripped, 'index.ts'),
      `${base}.ts`,
      resolve(base, 'index.ts'),
      `${stripped}.tsx`,
      `${stripped}.mts`,
      `${stripped}.cts`
    ]
  }
  const resolveSource = (source: string, importer?: string): string | null => {
    const cleanSource = source.split(/[?#]/, 1)[0]
    let base = ''
    if (cleanSource.startsWith(packagePrefix)) {
      base = resolve(sourceRoot, cleanSource.slice(packagePrefix.length))
    } else if (importer && cleanSource.startsWith('.')) {
      const cleanImporter = importer.split(/[?#]/, 1)[0]
      if (cleanImporter !== sourceRoot && !cleanImporter.startsWith(sourceRoot + '\\') && !cleanImporter.startsWith(sourceRoot + '/')) return null
      base = resolve(resolve(cleanImporter, '..'), cleanSource)
    } else {
      return null
    }
    return candidates(base).find((candidate) => fs.existsSync(candidate)) || null
  }
  return {
    name: 'hira-shared-types-source',
    apply: 'serve',
    enforce: 'pre',
    resolveId(source, importer) {
      return resolveSource(source, importer)
    }
  }
}

export default defineConfig({
  main: {
    plugins: [
      externalizeDepsPlugin(),
      // 五条产物步骤**串行**（顺序即依赖顺序，原因见 hiraBuildPipelinePlugin）
      hiraBuildPipelinePlugin([
        copyMainSourcesPlugin(),
        syncSharedContractsPlugin(),
        // 要打的 ./ipc-channels.mjs 等是 sync 复制过来的
        bundleSharedRuntimePlugin(),
        // 复用 plugins/** 的页面（AI 助手）从源码打包：要 sync 之后的 hira://shared/* 判定
        bundleSourcePagesPlugin(),
        // 要读 copy 落盘的页面入口 + sync 的共享层
        bundlePageEntriesPlugin()
      ])
    ],
    build: {
      emptyOutDir: false,
      rollupOptions: {
        input: {
          index: resolve(ROOT_DIR, 'apps/app-main/src/main/main.ts')
        }
      }
    }
  },
  preload: {
    resolve: {
      alias: {
        '@hira-ng/shared-types/src/ipc-channels-preload': resolve(ROOT_DIR, 'packages/shared-types/src/ipc-channels-preload.ts')
      }
    },
    plugins: [lazyTabFeatureBundlesPlugin(), preloadSelfContainedPlugin()],
    build: {
      emptyOutDir: false,
      externalizeDeps: { exclude: ['@hira-ng/shared-types'] },
      rollupOptions: {
        input: {
          shell: resolve(ROOT_DIR, 'infra/infra-window/preload/shell-preload.ts'),
          panel: resolve(ROOT_DIR, 'infra/infra-window/preload/panel-preload.ts'),
          tab: resolve(ROOT_DIR, 'infra/infra-window/preload/tab-preload.ts'),
          'dialog-renderer': resolve(ROOT_DIR, 'infra/infra-window/preload/dialog-renderer.ts')
        }
      }
    }
  },
  renderer: {
    root: resolve(ROOT_DIR, 'apps/app-main/src/renderer'),
    optimizeDeps: {
      // Dev resolves shared contracts to source `.ts`; avoid prebundling dist.
      exclude: ['@hira-ng/shared-types']
    },
    server: {
      // Never silently move to another port: a stale dev server must fail visibly
      // instead of leaving Electron connected to a different HMR websocket.
      host: '127.0.0.1',
      port: 5173,
      strictPort: true
    },
    build: {
      /**
       * **必须 true**：`out/renderer` 由 Vite **独占**，每次构建都应清空。
       *
       * 为什么可以清空（已核对，不是猜）：
       *   · `copyMainSourcesPlugin` 的 `EXCLUDE_TOP_DIRS` 显式跳过**顶层 renderer/**
       *     （见本文件上方那段"顶层 renderer/ 归 Vite 管"的注释，`walkTs` 同样跳过）；
       *   · `syncSharedContractsPlugin` 只写 `out/pages/_shared`；
       *   即除 Vite 外没有任何一方往这个目录写东西。
       *
       * 为什么原来是 false 反而有害：产物是**带 hash 的 chunk 名**，旧文件永不覆盖、
       * 只增不减 —— 实测累积到 **1812 个文件 / 68.28MB**，同一份 `bridge-*.js` 存了
       * **15 份**（`menu-client` 14 份、`ipc-channels` 8 份）。它不影响运行
       * （入口 HTML 只引一份），但会**成倍撑大安装包**，也让"产物里 grep 某段代码"
       * 这种排查被陈旧副本干扰。
       * ⚠ 与 `main` / `preload` 的 `emptyOutDir: false` 是两回事：那两个目录里
       * 混着拷贝/转译出来的源码（`out/main/**`、`out/preload/*`），清空会删掉它们 ——
       * 那两处**必须保持 false**。
       */
      emptyOutDir: true,
      commonjsOptions: {
        // 让 rollup 处理项目内 CJS 模块（ui/infra/packages/apps/shared）及 node_modules
        include: [/node_modules[\\/]/, /[\\/](ui|infra|packages|apps|shared)[\\/]/]
      },
      rollupOptions: {
        input: {
          index: resolve(ROOT_DIR, 'apps/app-main/src/renderer/app-shell/index.html'),
          panels: resolve(ROOT_DIR, 'apps/app-main/src/renderer/panels/index.html'),
          rail: resolve(ROOT_DIR, 'apps/app-main/src/renderer/rail/index.html'),
          subwindow: resolve(ROOT_DIR, 'apps/app-main/src/renderer/subwindow/index.html'),
          'searchbar-overlay': resolve(ROOT_DIR, 'apps/app-main/src/renderer/searchbar-overlay/index.html'),
          'tabpreview-overlay': resolve(ROOT_DIR, 'apps/app-main/src/renderer/tabpreview-overlay/index.html'),
          'overview-overlay': resolve(ROOT_DIR, 'apps/app-main/src/renderer/overview-overlay/index.html'),
          'buttons-edit-overlay': resolve(ROOT_DIR, 'apps/app-main/src/renderer/buttons-edit-overlay/index.html'),
          'password-overlay': resolve(ROOT_DIR, 'apps/app-main/src/renderer/password-overlay/index.html'),
          // ── chrome 级瞬态浮层：查找栏 / 悬停 URL / 缩放条 / 拖动落点预览 ──
          // 前三者贴在**网页矩形**内部（见 LayoutCoordinator#anchorFloatInContent），
          // 落点预览直接**就是**预览块矩形（见 shared-types#dropZonePaneRect）；
          // 四者都必须是独立原生视图 —— 网页是 WebContentsView，天然盖住 chrome DOM。
          // 名字两处必须逐字一致：这里、FLOAT_NAMES（ipc/layout.js）。
          'findbar-overlay': resolve(ROOT_DIR, 'apps/app-main/src/renderer/findbar-overlay/index.html'),
          'hoverurl-overlay': resolve(ROOT_DIR, 'apps/app-main/src/renderer/hoverurl-overlay/index.html'),
          'zoom-overlay': resolve(ROOT_DIR, 'apps/app-main/src/renderer/zoom-overlay/index.html'),
          // 拖动落点预览（拖标签到网页区域时"这一格会落在哪"）。名字必须与
          // ipc/layout.js#FLOAT_NAMES 逐字一致，否则视图建得起来、内容加载不到。
          'dropzone-overlay': resolve(ROOT_DIR, 'apps/app-main/src/renderer/dropzone-overlay/index.html'),
          // 框选截图（J7 收口）的框选层：与 dropzone 同族（主进程驱动、独立原生视图），
          // 盖在被截的那一页上。名字三处逐字一致：这里、capture-region 的 NAME、
          // renderer/capture-overlay/。
          'capture-overlay': resolve(ROOT_DIR, 'apps/app-main/src/renderer/capture-overlay/index.html'),
          // 截图标注浮层（截完就地显示图片 + 工具栏，QQ 截图那套观感）。
          // **不是独立窗口**：它是盖在被截那一页上的浏览器窗口内浮层视图。
          // 名字三处逐字一致：这里、main/capture-editor-overlay.js#NAME、renderer/capture-editor/。
          'capture-editor': resolve(ROOT_DIR, 'apps/app-main/src/renderer/capture-editor/index.html'),
          // 分屏工具条（hover 在分屏上浮出的那排小按钮：拖拽重排 / 切方向 / 反转格序 / 收拢 / 解散）。
          // 与 dropzone 同族：主进程驱动（hover 判定要读原生视图的格矩形）。名字三处逐字一致：
          // 这里、ipc/layout.js#FLOAT_NAMES、renderer/split-toolbar/。
          'split-toolbar': resolve(ROOT_DIR, 'apps/app-main/src/renderer/split-toolbar/index.html'),
          // 通用「选择目标」浮层（书签文件夹下拉 / 收进集锦…共用一份实现）。
          // 名字三处逐字一致：这里、ipc/layout.js#FLOAT_NAMES、renderer/target-picker-overlay/。
          'target-picker-overlay': resolve(ROOT_DIR, 'apps/app-main/src/renderer/target-picker-overlay/index.html'),
          // 地址栏「站点信息」聚合浮层（权限 / 证书 / Cookie / 内容拦截）。
          // 贴在地址栏按钮下方（position:'anchor-below'）。名字三处逐字一致：
          // 这里、ipc/layout.js#FLOAT_NAMES、renderer/siteinfo-overlay/。
          'siteinfo-overlay': resolve(ROOT_DIR, 'apps/app-main/src/renderer/siteinfo-overlay/index.html'),
          // 权限申请浮层（独立视图）：网页请求权限时弹在内容区左上角。
          // 名字三处逐字一致：这里、ipc/layout.js#FLOAT_NAMES、renderer/permission-overlay/。
          'permission-overlay': resolve(ROOT_DIR, 'apps/app-main/src/renderer/permission-overlay/index.html'),
          // 独立侧栏（Web Sidebar）的**顶条**（侧栏槽内的 chrome 条：后退 / 前进 / 刷新 /
          // 标题 / 在标签页打开 / 关闭 + 宽度把手）。它不是浮层：视图由布局层摆在
          // 侧栏区域顶部（`LayoutCoordinator#_placeWebSidebar` 按端口给的 headerHeight 让位）。
          // 名字三处一致：这里、infra-window/WebContentsManager.js（WEB_SIDEBAR_HEADER_PAGE）、
          // renderer/web-sidebar-header/。
          'web-sidebar-header': resolve(ROOT_DIR, 'apps/app-main/src/renderer/web-sidebar-header/index.html'),
          // 扫码取景框（「扫码器」插件的可拖动浮框）：**透明置顶窗口**，
          // 不是浮层视图 —— 它要能拖到屏幕任何地方（含别的应用之上），
          // 而浮层视图被困在浏览器窗口里。窗口类型见 main/window-config.js。
          'qr-scan-frame': resolve(ROOT_DIR, 'apps/app-main/src/renderer/qr-scan-frame/index.html'),
          // 侧栏浮出层（Edge 型自动隐藏的悬停展开）：静止是 chrome 里那条 56px 图标 rail，
          // 指针贴边时主进程把这条独立视图铺开盖在网页上（网页不缩进、不重排）。
          // 名字三处逐字一致：这里、ipc/layout.js#FLOAT_NAMES、renderer/sidebar-float/。
          'sidebar-float': resolve(ROOT_DIR, 'apps/app-main/src/renderer/sidebar-float/index.html'),
          // 插件浮层宿主（PART18 开放世界）：插件声明的 overlay / 命令式浮层都画在这里。
          // 名字三处逐字一致：这里、ipc/layout.js#FLOAT_NAMES、renderer/plugin-overlay/。
          'plugin-overlay': resolve(ROOT_DIR, 'apps/app-main/src/renderer/plugin-overlay/index.html'),
          // 专注模式（D5）的**整窗**浮层：盖住导航栏 / 侧栏 / 网页全部区域。
          // 与其它浮层不同，它的显隐由番茄钟状态机驱动（不在 ipc/layout.js#FLOAT_NAMES 里），
          // 名字两处逐字一致：这里、main/break-overlay.js#NAME、renderer/break-overlay/。
          'break-overlay': resolve(ROOT_DIR, 'apps/app-main/src/renderer/break-overlay/index.html')
          // 设置页**不在这里** —— 它是 pages/settings/ 下的静态内部页（<script type="module">，
          // 无打包器），与 history / bookmarks 同构，由 hira://settings 直接提供给协议层。
        }
      }
    },
    plugins: [sharedTypesSourcePlugin()]
  }
})

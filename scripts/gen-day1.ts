import * as fs from 'node:fs'
import * as path from 'node:path'

interface WorkspacePackage {
  name: string
  version: string
  private: boolean
  main: string
}

interface AppPackage extends Record<string, unknown> {
  dependencies?: Record<string, string>
  main?: string
}

const root = path.resolve(__dirname, '..')

const layers = {
  infra: [
    'infra-db',
    'infra-ipc',
    'infra-window',
    'infra-plugin',
    'infra-storage',
    'infra-logger',
    'infra-error',
    'infra-fs',
    'infra-platform',
    'infra-theme',
    'infra-l10n'
  ],
  domain: [
    'domain-settings',
    'domain-tabs',
    'domain-profile',
    'domain-bookmark',
    'domain-history',
    'domain-download',
    'domain-password',
    'domain-extension',
    'domain-permission',
    'domain-search',
    'domain-session'
  ],
  ui: [
    'ui-common',
    'ui-tabbar',
    'ui-navbar',
    'ui-searchbar',
    'ui-webviews',
    'ui-taskoverlay',
    'ui-panel-favorites',
    'ui-panel-history',
    'ui-panel-downloads',
    'ui-panel-extensions',
    'ui-panel-profiles',
    'ui-panel-notes',
    'ui-panel-opentabs',
    'ui-panel-tabpreview',
    'ui-password-manager'
  ],
  apps: ['app-main', 'app-subwindows', 'app-settings', 'app-manager'],
  packages: ['shared-types', 'shared-utils', 'shared-ui-tokens']
}

function ensureDir(p: string): void {
  fs.mkdirSync(p, { recursive: true })
}

function writeFile(p: string, content: string): void {
  ensureDir(path.dirname(p))
  fs.writeFileSync(p, content, 'utf8')
}

function writeJson(p: string, obj: unknown): void {
  writeFile(p, JSON.stringify(obj, null, 2) + '\n')
}

function createWorkspacePackage(groupDir: string, pkgName: string): void {
  const dir = path.join(root, groupDir, pkgName)
  ensureDir(dir)
  ensureDir(path.join(dir, 'src'))

  const pkgJson: WorkspacePackage = {
    name: `@hira-ng/${pkgName}`,
    version: '0.0.1',
    private: true,
    main: 'src/index.ts'
  }

  writeJson(path.join(dir, 'package.json'), pkgJson)
  writeFile(path.join(dir, 'src', 'index.ts'), "export {}\n")
}

function createAllPackages(): void {
  for (const name of layers.infra) createWorkspacePackage('infra', name)
  for (const name of layers.domain) createWorkspacePackage('domain', name)
  for (const name of layers.ui) createWorkspacePackage('ui', name)
  for (const name of layers.apps) createWorkspacePackage('apps', name)
  for (const name of layers.packages) createWorkspacePackage('packages', name)

  const appMainPkgPath = path.join(root, 'apps', 'app-main', 'package.json')
  const appMainPkg = JSON.parse(fs.readFileSync(appMainPkgPath, 'utf8')) as AppPackage
  appMainPkg.main = 'src/main/main.ts'
  appMainPkg.dependencies = {
    '@hira-ng/infra-window': 'workspace:*'
  }
  writeJson(appMainPkgPath, appMainPkg)

  ensureDir(path.join(root, 'apps', 'app-main', 'src', 'main'))
  ensureDir(path.join(root, 'apps', 'app-main', 'src', 'preload'))
  ensureDir(path.join(root, 'apps', 'app-main', 'src', 'renderer'))

  writeFile(
    path.join(root, 'apps', 'app-main', 'src', 'renderer', 'index.html'),
    [
      '<!doctype html>',
      '<html>',
      '  <head>',
      '    <meta charset="UTF-8" />',
      '    <meta name="viewport" content="width=device-width, initial-scale=1.0" />',
      '    <title>STAR Hira NitroGen</title>',
      '  </head>',
      '  <body>',
      '    <div id="root"></div>',
      '    <script type="module" src="/main.js"></script>',
      '  </body>',
      '</html>',
      ''
    ].join('\n')
  )

  writeFile(
    path.join(root, 'apps', 'app-main', 'src', 'renderer', 'main.ts'),
    "const root = document.getElementById('root')\nif (root) root.textContent = 'STAR Hira NitroGen'\n"
  )

  writeFile(path.join(root, 'apps', 'app-main', 'src', 'preload', 'preload.ts'), "export {}\n")
}

function createSharedUiTokensShell(): void {
  const dir = path.join(root, 'packages', 'shared-ui-tokens')
  writeFile(path.join(dir, 'tokens-light.css'), '')
  writeFile(path.join(dir, 'tokens-dark.css'), '')
  writeFile(path.join(dir, 'components.css'), '')
  writeFile(path.join(dir, 'README.md'), '# shared-ui-tokens\n')
}

function createMemoryFiles(): void {
  const hiraAiDir = path.join(root, '.hira-ai')
  ensureDir(hiraAiDir)

  const constitution = [
    '[CONTRACT-01] 「不耦合不依赖原本」仅指不依赖旧系统 v7.5.0 自写代码/构建脚本/全局函数/自写 IPC。A 档 npm 库（PART9 §9.0 A 档）锁同版本不重写。',
    '[CONTRACT-02] UI 像素一致性优先级高于架构优化。任何写代码导致 UI 快照 <95% 匹配 → 先回滚代码修快照，架构再优雅也让路。',
    '[CONTRACT-03] 保真 5 级锁的 L1：写任何 Provider/业务代码前，必须先列出 本次功能映射的 L1 功能点 ID（F-XXXX 或 C-XXX），并说明覆盖对应断言。',
    '[CONTRACT-04] 所有 IPC 消息和 Provider 返回值必须有 Zod Schema。无 Zod 契约 = 代码不合格，不通过。',
    '[CONTRACT-05] 0 个业务全局变量。任何 window.xxx = 业务对象 / global.xxx = 业务对象 → 代码不合格。',
    '[CONTRACT-06] 窗口创建必须走 infra-window/WindowFactory 唯一入口。任何直接 new BrowserWindow() → 不合格。',
    '[CONTRACT-07] 8 个 side-panel 插件必须声明 dependsOn side-panel-skeleton。不装骨架就装面板 → 启动期必须报错。',
    '[CONTRACT-08] Ctrl+W 关闭最后 1 个标签时 = 关标签并加载 about:blank，**不能关闭窗口**。pinned 标签 Ctrl+W 不关闭。',
    '[CONTRACT-09] 标签 hover 出缩略预览 = 精确 700ms；Zen rail hover 展开 = 精确 1000ms；side rail 判定区 = 外扩 16px。',
    '[CONTRACT-10] Chrome 扩展兼容 = §9.0 A 档 electron-chrome-extensions@4.9.4 原库；拦截 = @ghostery/adblocker-electron 原库。任何提议重写这两个 = 违反 CONTRACT-01 + 10。',
    '[CONTRACT-11] 4 层依赖方向：APPS → UI COMPONENTS → DOMAIN → INFRASTRUCTURE。任何反向依赖（domain import ui 组件等）= 代码不合格。',
    '[CONTRACT-12] Provider-Service 洋葱模型 4 Hook 顺序 = before → validate → around → after。任何改顺序 = 不合格。',
    '[CONTRACT-13] 存储必须走 infra-db SQLite + Drizzle 事务。任何直接写 IndexedDB / Dexie = 不合格。',
    '[CONTRACT-14] npm 依赖迁移严格按 PART9 §9.0 A/B/C 三档。A 档列表外的任何库 → 必须单独写 RFC 评审。',
    '[CONTRACT-15] 1,234 功能点映射覆盖率必须 100%（`pnpm fn:coverage`）。任何缺失 = 发布闸门不过。',
    '[CONTRACT-16] Ctrl+Shift+T 恢复标签 = 到**原来的位置**，不是追加到末尾。',
    '[CONTRACT-17] 地址栏选中文字后 Ctrl+Enter = 自动包装为 `www.{文字}.com`。',
    '[CONTRACT-18] 关闭窗口红按钮 = 关闭即退出进程（托盘方案已废弃，tray-manager.js 已删除）。',
    '[CONTRACT-19] 存储迁移适配器 8 个：4 种数据集 (empty/2k bookmark/100k history/regression) 必须 100% 通过。',
    '[CONTRACT-20] 任何代码提交前必须：①跑 pnpm fn:coverage 100% + ②pnpm plugin:coverage 100% + ③pnpm test:ui-snapshot ≥95%。任一不通过 = 不允许提交。',
    '',
    '## STAR Hira NitroGen · 宪法 12 条（每轮重新确认，忘记任一条 = 输出不合格）',
    'C01 不碰旧系统自写代码，A 档 npm 库锁版本不重写 | C02 UI 像素快照 ≥95% 一票否决架构',
    'C03 写功能前列 L1 F-XXXX/C-XXX 映射 ID       | C04 IPC/Provider 强制 Zod',
    'C05 0 业务全局 window.xxx                    | C06 WindowFactory 唯一入口',
    'C07 面板 dependsOn side-panel-skeleton       | C08 Ctrl+W 最后标签→about:blank 不关窗',
    'C09 三个阈值: 预览700ms / Zen展开1000ms / rail判定16px  | C10 electron-chrome-extensions@4.9.4 + adblocker-electron 原库',
    'C11 4 层单向依赖 APPS→UI→DOMAIN→INFRA         | C12 Provider 4 Hook = before→validate→around→after',
    ''
  ].join('\n')

  writeFile(path.join(hiraAiDir, 'constitution.md'), constitution)

  const index: Record<string, string> = {}
  for (let i = 1; i <= 20; i++) {
    const id = `CONTRACT-${String(i).padStart(2, '0')}`
    index[id] = 'PART10 §10.1.1'
  }
  writeJson(path.join(hiraAiDir, 'contract-index.json'), index)

  writeFile(path.join(hiraAiDir, 'current-milestone.md'), 'M0 W2 空壳版 0%\n')

  const tracker: Record<string, Record<string, never>> = {}
  for (let i = 1; i <= 1234; i++) {
    const id = `F-${String(i).padStart(4, '0')}`
    tracker[id] = {}
  }
  writeFile(path.join(hiraAiDir, 'l1-coverage-tracker.json'), JSON.stringify(tracker) + '\n')
}

createAllPackages()
createSharedUiTokensShell()
createMemoryFiles()

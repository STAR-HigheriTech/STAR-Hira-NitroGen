/**
 * 本地工作区：用户显式授权给 Agent 的目录。
 *
 * 这里只负责“选目录、登记、绑定会话、解析安全路径”。文件读写与命令执行工具
 * 各自消费同一个 workspace root，避免每个工具自行判断 ../ 与符号链接。
 */

const fs = require('fs/promises')
const fsSync = require('fs')
const path = require('path')
const { dialog } = require('electron')

interface WorkspaceRecord {
  id: string
  name: string
  rootPath: string
  createdAt: number
  lastUsedAt: number
}

interface WorkspaceStore {
  getSession(id: string): { id: string; workspaceId?: string | null } | null
  listWorkspaces(opts?: { limit?: number }): WorkspaceRecord[]
  getWorkspace(id: string): WorkspaceRecord | null
  upsertWorkspace(input: { rootPath: string; name?: string }): WorkspaceRecord
  bindSessionWorkspace(sessionId: string, workspaceId: string | null): unknown
}

function inside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

function workspaceError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code })
}

function createWorkspaceService({ store, logger = console }: {
  store: WorkspaceStore
  logger?: { warn?(...args: unknown[]): void; info?(...args: unknown[]): void }
}) {
  const instructionCache = new Map<string, { signature: string; text: string }>()
  async function normalizeRoot(raw: unknown): Promise<string> {
    const input = String(raw || '').trim()
    if (!input) throw workspaceError('AI_WORKSPACE_EMPTY', '没有选择工作区目录')
    const resolved = await fs.realpath(path.resolve(input))
    const stat = await fs.stat(resolved)
    if (!stat.isDirectory()) throw workspaceError('AI_WORKSPACE_NOT_DIR', '工作区必须是文件夹')
    return resolved
  }

  function current(sessionId: string): WorkspaceRecord | null {
    const session = store.getSession(String(sessionId || ''))
    if (!session || !session.workspaceId) return null
    return store.getWorkspace(String(session.workspaceId))
  }

  function list() {
    return store.listWorkspaces({ limit: 30 })
  }

  function bind(sessionId: string, workspaceId: string) {
    const workspace = store.getWorkspace(String(workspaceId || ''))
    if (!workspace) throw workspaceError('AI_WORKSPACE_NOT_FOUND', '工作区不存在')
    store.upsertWorkspace({ rootPath: workspace.rootPath, name: workspace.name })
    store.bindSessionWorkspace(String(sessionId), workspace.id)
    return workspace
  }

  async function open({ sessionId = '', title = '选择 AI 工作区' }: { sessionId?: string; title?: string } = {}) {
    const picked = await dialog.showOpenDialog({
      title: String(title || '选择 AI 工作区'),
      buttonLabel: '允许访问',
      properties: ['openDirectory', 'createDirectory']
    })
    if (picked.canceled || !picked.filePaths || !picked.filePaths[0]) {
      return { ok: false, canceled: true, code: 'AI_WORKSPACE_CANCELED' }
    }
    try {
      const rootPath = await normalizeRoot(picked.filePaths[0])
      const workspace = store.upsertWorkspace({
        rootPath,
        name: path.basename(rootPath) || rootPath
      })
      if (sessionId && sessionId !== 'draft' && store.getSession(sessionId)) {
        store.bindSessionWorkspace(sessionId, workspace.id)
      }
      try { logger.info?.('[ai] 工作区已选择：', rootPath) } catch (_) {}
      return { ok: true, workspace, ...(sessionId ? { sessionId } : {}) }
    } catch (e) {
      try { logger.warn?.('[ai] 工作区选择失败：', e) } catch (_) {}
      return {
        ok: false,
        code: 'AI_WORKSPACE_INVALID',
        message: '该目录不可用或没有访问权限'
      }
    }
  }

  /**
   * 把模型给的相对路径解析到工作区内；已存在的目标还要通过 realpath 复查，
   * 防止目录中的符号链接把真实读写位置带到工作区外。
   */
  async function resolve(sessionId: string, target: unknown = '.', opts: { allowRoot?: boolean } = {}) {
    const workspace = current(sessionId)
    if (!workspace) throw workspaceError('AI_NO_WORKSPACE', '当前会话没有绑定本地工作区；先调用 workspace_open')
    const root = await fs.realpath(workspace.rootPath)
    const abs = path.resolve(root, String(target || '.'))
    if (!inside(root, abs) || (!opts.allowRoot && abs === root)) {
      throw workspaceError('AI_PATH_OUTSIDE_WORKSPACE', '路径超出当前工作区')
    }

    if (abs === root) return { workspace: { ...workspace, rootPath: root }, abs, root }
    try {
      const real = await fs.realpath(abs)
      if (!inside(root, real)) throw workspaceError('AI_PATH_OUTSIDE_WORKSPACE', '符号链接指向工作区外')
      return { workspace: { ...workspace, rootPath: root }, abs: real, root }
    } catch (e) {
      if (e && typeof e === 'object' && 'code' in e && e.code === 'ENOENT') {
        // 新路径：从最近一个已存在祖先开始 realpath 复查。只检查 dirname 仍然会漏掉
        // “父目录不存在 + 更上层是外指符号链接”的情况。
        let ancestor = path.dirname(abs)
        let realAncestor = ''
        while (inside(root, ancestor)) {
          try {
            realAncestor = await fs.realpath(ancestor)
            break
          } catch (inner) {
            if (!inner || typeof inner !== 'object' || !('code' in inner) || inner.code !== 'ENOENT') throw inner
            if (ancestor === root) break
            ancestor = path.dirname(ancestor)
          }
        }
        if (!realAncestor || !inside(root, realAncestor)) {
          throw workspaceError('AI_PATH_OUTSIDE_WORKSPACE', '路径的祖先目录超出当前工作区')
        }
        return { workspace: { ...workspace, rootPath: root }, abs, root }
      }
      throw e
    }
  }

  /**
   * 项目指令（Codex AGENTS.md / Claude CLAUDE.md 的同类机制）。
   * 只读工作区根目录，合并为运行时上下文；文件变化会自动刷新，不写死到系统提示。
   */
  function instructions(sessionId: string): string {
    const workspace = current(sessionId)
    if (!workspace) return ''
    const candidates = ['AGENTS.md', 'HIRA.md', '.hira/AGENTS.md']
    const found: Array<{ name: string; path: string; mtime: number }> = []
    for (const name of candidates) {
      const abs = path.join(workspace.rootPath, ...name.split('/'))
      try {
        const real = fsSync.realpathSync(abs)
        if (!inside(workspace.rootPath, real)) continue
        const stat = fsSync.statSync(real)
        if (stat.isFile() && stat.size <= 256 * 1024) found.push({ name, path: real, mtime: stat.mtimeMs })
      } catch (_) {}
    }
    if (!found.length) return ''
    const signature = found.map((item) => `${item.name}:${item.mtime}`).join('|')
    const cached = instructionCache.get(workspace.id)
    if (cached && cached.signature === signature) return cached.text
    const parts: string[] = []
    let used = 0
    for (const item of found) {
      try {
        const raw = fsSync.readFileSync(item.path, 'utf8')
        const remain = Math.max(0, 12_000 - used)
        if (!remain) break
        const body = raw.length > remain ? `${raw.slice(0, remain)}\n…（项目指令过长，已截断）` : raw
        parts.push(`### ${item.name}\n${body}`)
        used += body.length
      } catch (_) {}
    }
    const text = parts.join('\n\n')
    instructionCache.set(workspace.id, { signature, text })
    return text
  }

  return { open, current, list, bind, resolve, normalizeRoot, instructions }
}

module.exports = { createWorkspaceService }

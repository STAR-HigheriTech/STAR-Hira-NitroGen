/**
 * 本地 Agent 工具：工作区、文件、命令。
 *
 * 所有路径都走 `workspaces.resolve()` 的 realpath 守卫；模型永远拿不到一个
 * “任意绝对路径”入口。文件写入使用临时文件替换，搜索不跟随符号链接。
 */

const fs = require('fs/promises')
const path = require('path')
const crypto = require('crypto')
const { readOffice, docxFromMarkdown, xlsxFromSheets, pptxFromSlides } = require('./office.cjs')

import type { AiToolContext, AiToolDefinition, AiToolHost, JsonSchema, ToolArgs } from '../types'

const MAX_READ_BYTES = 2 * 1024 * 1024
const MAX_WRITE_BYTES = 4 * 1024 * 1024
const MAX_OFFICE_BYTES = 32 * 1024 * 1024
const MAX_SEARCH_FILES = 4000
const MAX_SEARCH_RESULTS = 100
const MAX_LIST_ENTRIES = 500
const MAX_SHELL_OUTPUT = 32_000
const IGNORED_DIRS = new Set(['.git', 'node_modules', '.pnpm-store', '.cache', 'out', 'build', 'dist', '.tmp', '__pycache__', '.venv', 'venv'])
const SENSITIVE_FILE = /(?:^|\/)(?:\.env(?:\..+)?|\.npmrc|\.pypirc|\.git-credentials|credentials(?:\..+)?|secrets(?:\..+)?|id_(?:rsa|ed25519)|[^/]+\.(?:pem|key|p12|pfx))$/i

function fail(message: string, code = 'AI_LOCAL_ERROR'): Error & { code: string } {
  return Object.assign(new Error(message), { code })
}

function obj(properties: JsonSchema['properties'] = {}, required: string[] = []): JsonSchema {
  return { type: 'object', properties: properties || {}, required, additionalProperties: false }
}

function text(value: unknown, max = 1000): string {
  return String(value == null ? '' : value).slice(0, max)
}

function slash(value: string): string {
  return value.split(path.sep).join('/')
}

function clip(textValue: string, max = MAX_SHELL_OUTPUT): { text: string; truncated: boolean } {
  if (textValue.length <= max) return { text: textValue, truncated: false }
  const tail = Math.floor(max * 0.25)
  return {
    text: `${textValue.slice(0, max - tail)}\n…（中间输出已裁减）…\n${textValue.slice(-tail)}`,
    truncated: true
  }
}

function sensitive(relative: string): boolean {
  const normalized = slash(relative).replace(/^\/+/, '')
  if (/\.env\.example$/i.test(normalized)) return false
  return SENSITIVE_FILE.test(normalized)
}

function relativePath(root: string, abs: string): string {
  const rel = path.relative(root, abs)
  return slash(rel || '.')
}

function isProbablyText(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192))
  for (let i = 0; i < sample.length; i += 1) if (sample[i] === 0) return false
  return true
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal && signal.aborted) throw fail('操作已取消', 'AI_ABORTED')
}

function createLocalTools(host: AiToolHost): AiToolDefinition[] {
  const workspaces = host.workspaces
  const processRunner = host.processRunner

  function workspacePort() {
    if (!workspaces) throw fail('本地工作区服务不可用', 'AI_WORKSPACE_UNAVAILABLE')
    return workspaces
  }

  async function resolveFile(ctx: AiToolContext, target: unknown) {
    return workspacePort().resolve(ctx.sessionId, String(target || ''))
  }

  async function readBuffer(abs: string): Promise<Buffer> {
    const stat = await fs.stat(abs)
    if (!stat.isFile()) throw fail('目标不是文件', 'AI_NOT_FILE')
    if (stat.size > MAX_READ_BYTES) throw fail(`文件超过 ${Math.round(MAX_READ_BYTES / 1024 / 1024)}MB 读取上限`, 'AI_FILE_TOO_LARGE')
    return fs.readFile(abs)
  }

  async function readOfficeBuffer(abs: string): Promise<Buffer> {
    const stat = await fs.stat(abs)
    if (!stat.isFile()) throw fail('目标不是文件', 'AI_NOT_FILE')
    if (stat.size > MAX_OFFICE_BYTES) throw fail('Office 文件超过 32MB 读取上限', 'AI_FILE_TOO_LARGE')
    return fs.readFile(abs)
  }

  async function atomicWrite(abs: string, content: string | Buffer, overwrite: boolean): Promise<void> {
    const dir = path.dirname(abs)
    await fs.mkdir(dir, { recursive: true })
    if (!overwrite) {
      try {
        await fs.access(abs)
        throw fail('文件已存在；覆盖需显式 overwrite=true', 'AI_FILE_EXISTS')
      } catch (e) {
        if (e && typeof e === 'object' && 'code' in e && e.code !== 'ENOENT') throw e
      }
    }
    // `wx` 独占创建 + 不可预测名称：即使工作区内容不可信，也不能预先放一个同名
    // 符号链接把写入重定向到工作区外。
    const temp = path.join(dir, `.${path.basename(abs)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`)
    let handle: Awaited<ReturnType<typeof fs.open>> | null = null
    try {
      handle = await fs.open(temp, 'wx', 0o600)
      await handle.writeFile(content)
      await handle.close()
      handle = null
      if (overwrite) {
        try { await fs.rename(temp, abs) } catch (_) {
          await fs.rm(abs, { force: true })
          await fs.rename(temp, abs)
        }
      } else {
        await fs.rename(temp, abs)
      }
    } finally {
      try { await handle?.close() } catch (_) {}
      await fs.rm(temp, { force: true }).catch(() => {})
    }
  }

  const tools: AiToolDefinition[] = [
    {
      name: 'workspace_open',
      description: '让用户选择一个本地文件夹，登记为工作区并绑定当前会话。之后文件与命令工具只能在该目录内工作。',
      parameters: obj({}),
      risk: 'read',
      approval: 'never',
      async execute(_args: ToolArgs, ctx: AiToolContext) {
        return workspacePort().open({ sessionId: ctx.sessionId, title: '选择允许 AI 访问的本地工作区' })
      }
    },
    {
      name: 'workspace_list',
      description: '列出用户之前授权过的本地工作区。',
      parameters: obj({}),
      risk: 'read',
      approval: 'never',
      async execute() {
        return { workspaces: workspacePort().list() }
      }
    },
    {
      name: 'workspace_use',
      description: '把之前授权过的工作区绑定到当前会话。',
      parameters: obj({ workspaceId: { type: 'string', description: 'workspace_list 返回的 id' } }, ['workspaceId']),
      risk: 'read',
      approval: 'never',
      async execute(args: ToolArgs, ctx: AiToolContext) {
        return { workspace: workspacePort().bind(ctx.sessionId, String(args.workspaceId || '')) }
      }
    },
    {
      name: 'workspace_current',
      description: '读取当前会话绑定的本地工作区。',
      parameters: obj({}),
      risk: 'read',
      approval: 'never',
      async execute(_args: ToolArgs, ctx: AiToolContext) {
        return { workspace: workspacePort().current(ctx.sessionId) }
      }
    },
    {
      name: 'file_list',
      description: '列出工作区目录。返回相对路径、类型和大小；自动跳过依赖、缓存与 .git 内部目录。',
      parameters: obj({
        path: { type: 'string', description: '相对工作区的目录，默认根目录' },
        depth: { type: 'number', description: '递归深度 1-4，默认 1' },
        limit: { type: 'number', description: '最多条目，默认 200' }
      }),
      risk: 'read',
      approval: 'never',
      async execute(args: ToolArgs, ctx: AiToolContext) {
        throwIfAborted(ctx.signal)
        const target = String(args.path || '.')
        const { abs, root } = await workspacePort().resolve(ctx.sessionId, target, { allowRoot: true })
        const depth = Math.max(1, Math.min(Math.round(Number(args.depth) || 1), 4))
        const limit = Math.max(1, Math.min(Math.round(Number(args.limit) || 200), MAX_LIST_ENTRIES))
        const entries: Array<{ path: string; type: 'file' | 'dir'; size: number }> = []
        async function walk(dir: string, level: number) {
          throwIfAborted(ctx.signal)
          if (entries.length >= limit || level > depth) return
          const list = await fs.readdir(dir, { withFileTypes: true })
          list.sort((a: { isDirectory(): boolean; name: string }, b: { isDirectory(): boolean; name: string }) =>
            Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name)
          )
          for (const entry of list) {
            if (entries.length >= limit) return
            if (entry.isSymbolicLink()) continue
            const full = path.join(dir, entry.name)
            const rel = relativePath(root, full)
            if (entry.isDirectory()) {
              entries.push({ path: rel, type: 'dir', size: 0 })
              if (!IGNORED_DIRS.has(entry.name)) await walk(full, level + 1)
            } else if (entry.isFile()) {
              const stat = await fs.stat(full).catch(() => null)
              entries.push({ path: rel, type: 'file', size: stat?.size || 0 })
            }
          }
        }
        await walk(abs, 1)
        return { path: relativePath(root, abs), entries, truncated: entries.length >= limit }
      }
    },
    {
      name: 'file_search',
      description: '在工作区按文件名和文本内容搜索，返回相对路径与命中片段。适合先定位代码、配置或文档再读取。',
      parameters: obj({
        query: { type: 'string', description: '关键词或片段' },
        path: { type: 'string', description: '相对工作区的起点目录，默认根目录' },
        limit: { type: 'number', description: '最多结果，默认 40' }
      }, ['query']),
      risk: 'read',
      approval: 'never',
      async execute(args: ToolArgs, ctx: AiToolContext) {
        throwIfAborted(ctx.signal)
        const query = String(args.query || '').trim()
        if (!query) throw fail('query 不能为空', 'AI_BAD_ARGS')
        const needle = query.toLowerCase()
        const { abs, root } = await workspacePort().resolve(ctx.sessionId, String(args.path || '.'), { allowRoot: true })
        const limit = Math.max(1, Math.min(Math.round(Number(args.limit) || 40), MAX_SEARCH_RESULTS))
        const results: Array<{ path: string; kind: 'path' | 'content'; snippet: string }> = []
        let visited = 0
        const deadline = Date.now() + 10_000
        async function walk(dir: string) {
          throwIfAborted(ctx.signal)
          if (results.length >= limit || visited >= MAX_SEARCH_FILES || Date.now() >= deadline) return
          const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
          for (const entry of entries) {
            throwIfAborted(ctx.signal)
            if (results.length >= limit || visited >= MAX_SEARCH_FILES || Date.now() >= deadline) return
            if (entry.isSymbolicLink()) continue
            const full = path.join(dir, entry.name)
            const rel = relativePath(root, full)
            if (entry.isDirectory()) {
              if (!IGNORED_DIRS.has(entry.name)) await walk(full)
              continue
            }
            if (!entry.isFile() || sensitive(rel)) continue
            visited += 1
            if (rel.toLowerCase().includes(needle)) {
              results.push({ path: rel, kind: 'path', snippet: rel })
              continue
            }
            const stat = await fs.stat(full).catch(() => null)
            if (!stat || stat.size > 512 * 1024) continue
            const buffer = await fs.readFile(full).catch(() => null)
            if (!buffer || !isProbablyText(buffer)) continue
            const content = buffer.toString('utf8')
            const at = content.toLowerCase().indexOf(needle)
            if (at < 0) continue
            const start = Math.max(0, at - 100)
            const end = Math.min(content.length, at + query.length + 180)
            results.push({
              path: rel,
              kind: 'content',
              snippet: content.slice(start, end).replace(/\s+/g, ' ').trim()
            })
          }
        }
        await walk(abs)
        return {
          query,
          results,
          truncated: results.length >= limit || visited >= MAX_SEARCH_FILES || Date.now() >= deadline,
          timedOut: Date.now() >= deadline
        }
      }
    },
    {
      name: 'file_read',
      description: '读取工作区内的 UTF-8 文本文件，返回带行号内容。可使用 offset / limit 分页读取。',
      parameters: obj({
        path: { type: 'string', description: '相对工作区路径' },
        offset: { type: 'number', description: '起始行，1-based，默认 1' },
        limit: { type: 'number', description: '最多行数，默认 400，最大 2000' }
      }, ['path']),
      risk: 'read',
      approval: 'never',
      async execute(args: ToolArgs, ctx: AiToolContext) {
        const target = String(args.path || '')
        const { abs, root } = await resolveFile(ctx, target)
        const rel = relativePath(root, abs)
        if (sensitive(rel)) throw fail('该文件可能包含密钥或凭据，已拒绝读取', 'AI_SENSITIVE_FILE')
        const buffer = await readBuffer(abs)
        if (!isProbablyText(buffer)) throw fail('二进制文件不能按文本读取', 'AI_BINARY_FILE')
        const offset = Math.max(1, Math.round(Number(args.offset) || 1))
        const limit = Math.max(1, Math.min(Math.round(Number(args.limit) || 400), 2000))
        const lines = buffer.toString('utf8').split(/\r?\n/)
        const picked = lines.slice(offset - 1, offset - 1 + limit)
        return {
          path: rel,
          offset,
          lineCount: lines.length,
          content: picked.map((line, i) => `${String(offset + i).padStart(5, ' ')} | ${line}`).join('\n'),
          truncated: offset - 1 + picked.length < lines.length
        }
      }
    },
    {
      name: 'file_write',
      description: '在工作区内创建或完整覆盖文本文件。默认拒绝覆盖已有文件；父目录会自动创建。',
      parameters: obj({
        path: { type: 'string' },
        content: { type: 'string' },
        overwrite: { type: 'boolean', description: '是否允许覆盖已有文件，默认否' }
      }, ['path', 'content']),
      risk: 'write',
      approval: 'always',
      async execute(args: ToolArgs, ctx: AiToolContext) {
        const target = String(args.path || '')
        const content = String(args.content == null ? '' : args.content)
        if (Buffer.byteLength(content, 'utf8') > MAX_WRITE_BYTES) throw fail('文件超过写入上限', 'AI_FILE_TOO_LARGE')
        const { abs, root } = await resolveFile(ctx, target)
        const rel = relativePath(root, abs)
        if (sensitive(rel)) throw fail('该文件可能包含密钥或凭据，已拒绝写入', 'AI_SENSITIVE_FILE')
        await atomicWrite(abs, content, args.overwrite === true)
        return { ok: true, path: rel, bytes: Buffer.byteLength(content, 'utf8') }
      }
    },
    {
      name: 'file_edit',
      description: '对工作区文本文件做精确字符串替换。可传多组 edits 一次提交；每组默认要求 oldText 唯一。',
      parameters: obj({
        path: { type: 'string' },
        oldText: { type: 'string' },
        newText: { type: 'string' },
        replaceAll: { type: 'boolean', description: '替换所有出现，默认否' },
        edits: {
          type: 'array',
          description: '一次做多处替换：[{oldText,newText,replaceAll?}]',
          items: {
            type: 'object',
            properties: {
              oldText: { type: 'string' },
              newText: { type: 'string' },
              replaceAll: { type: 'boolean' }
            },
            required: ['oldText', 'newText']
          }
        }
      }, ['path']),
      risk: 'write',
      approval: 'always',
      async execute(args: ToolArgs, ctx: AiToolContext) {
        const target = String(args.path || '')
        const { abs, root } = await resolveFile(ctx, target)
        const rel = relativePath(root, abs)
        if (sensitive(rel)) throw fail('该文件可能包含密钥或凭据，已拒绝编辑', 'AI_SENSITIVE_FILE')
        const buffer = await readBuffer(abs)
        if (!isProbablyText(buffer)) throw fail('二进制文件不能按文本编辑', 'AI_BINARY_FILE')
        let content = buffer.toString('utf8')
        const edits = Array.isArray(args.edits)
          ? args.edits
          : [{ oldText: args.oldText, newText: args.newText, replaceAll: args.replaceAll }]
        if (!edits.length) throw fail('没有提供编辑内容', 'AI_BAD_ARGS')
        let replacements = 0
        for (const raw of edits) {
          const edit = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
          const oldText = String(edit.oldText == null ? '' : edit.oldText)
          const newText = String(edit.newText == null ? '' : edit.newText)
          if (!oldText) throw fail('oldText 不能为空', 'AI_BAD_ARGS')
          const first = content.indexOf(oldText)
          if (first < 0) throw fail('没有找到 oldText', 'AI_EDIT_NOT_FOUND')
          const second = content.indexOf(oldText, first + oldText.length)
          if (edit.replaceAll !== true && second >= 0) throw fail('oldText 出现多次；请提供更长上下文或设置 replaceAll=true', 'AI_EDIT_AMBIGUOUS')
          const count = edit.replaceAll === true ? content.split(oldText).length - 1 : 1
          content = edit.replaceAll === true
            ? content.split(oldText).join(newText)
            : `${content.slice(0, first)}${newText}${content.slice(first + oldText.length)}`
          replacements += count
        }
        const next = content
        if (Buffer.byteLength(next, 'utf8') > MAX_WRITE_BYTES) throw fail('编辑后文件超过写入上限', 'AI_FILE_TOO_LARGE')
        await atomicWrite(abs, next, true)
        return {
          ok: true,
          path: rel,
          replacements,
          beforeBytes: buffer.length,
          afterBytes: Buffer.byteLength(next, 'utf8')
        }
      }
    },
    {
      name: 'file_mkdir',
      description: '在工作区内创建目录。',
      parameters: obj({ path: { type: 'string' } }, ['path']),
      risk: 'write',
      approval: 'always',
      async execute(args: ToolArgs, ctx: AiToolContext) {
        const { abs, root } = await resolveFile(ctx, String(args.path || ''))
        await fs.mkdir(abs, { recursive: true })
        return { ok: true, path: relativePath(root, abs) }
      }
    },
    {
      name: 'file_move',
      description: '在工作区内移动或重命名文件/目录；默认不覆盖目标。',
      parameters: obj({
        from: { type: 'string' },
        to: { type: 'string' },
        overwrite: { type: 'boolean' }
      }, ['from', 'to']),
      risk: 'write',
      approval: 'always',
      async execute(args: ToolArgs, ctx: AiToolContext) {
        const source = await resolveFile(ctx, String(args.from || ''))
        const target = await resolveFile(ctx, String(args.to || ''))
        if (sensitive(relativePath(source.root, source.abs)) || sensitive(relativePath(target.root, target.abs))) {
          throw fail('该路径可能包含密钥或凭据，已拒绝移动', 'AI_SENSITIVE_FILE')
        }
        if (args.overwrite !== true) {
          try { await fs.access(target.abs); throw fail('目标已存在', 'AI_FILE_EXISTS') } catch (e) {
            if (e && typeof e === 'object' && 'code' in e && e.code !== 'ENOENT') throw e
          }
        }
        await fs.mkdir(path.dirname(target.abs), { recursive: true })
        await fs.rename(source.abs, target.abs)
        return { ok: true, from: relativePath(source.root, source.abs), to: relativePath(target.root, target.abs) }
      }
    },
    {
      name: 'file_delete',
      description: '删除工作区内文件；目录必须显式 recursive=true。该操作不可撤销。',
      parameters: obj({
        path: { type: 'string' },
        recursive: { type: 'boolean' }
      }, ['path']),
      risk: 'destructive',
      approval: 'always',
      async execute(args: ToolArgs, ctx: AiToolContext) {
        const { abs, root } = await resolveFile(ctx, String(args.path || ''))
        const rel = relativePath(root, abs)
        if (sensitive(rel)) throw fail('该路径可能包含密钥或凭据，已拒绝删除', 'AI_SENSITIVE_FILE')
        const stat = await fs.stat(abs)
        if (stat.isDirectory() && args.recursive !== true) throw fail('目录删除需要 recursive=true', 'AI_DIRECTORY_RECURSIVE_REQUIRED')
        await fs.rm(abs, { recursive: args.recursive === true, force: false })
        return { ok: true, path: rel }
      }
    },
    {
      name: 'office_read',
      description: '读取工作区内的 DOCX / XLSX / PPTX / PDF，提取正文、表格或幻灯片文本。复杂格式的视觉排版仍需用文档工具预览。',
      parameters: obj({
        path: { type: 'string' },
        maxChars: { type: 'number', description: '返回文本上限，默认 40000，最大 100000' },
        maxPages: { type: 'number', description: 'PDF 最多读取页数，默认 40' }
      }, ['path']),
      risk: 'read',
      approval: 'never',
      async execute(args: ToolArgs, ctx: AiToolContext) {
        const { abs, root } = await resolveFile(ctx, String(args.path || ''))
        const rel = relativePath(root, abs)
        if (sensitive(rel)) throw fail('该文件可能包含密钥或凭据，已拒绝读取', 'AI_SENSITIVE_FILE')
        const buffer = await readOfficeBuffer(abs)
        const result = await readOffice(abs, buffer, { maxPages: Number(args.maxPages) || 40 })
        const maxChars = Math.max(1000, Math.min(Math.round(Number(args.maxChars) || 40_000), 100_000))
        const content = clip(String(result.text || ''), maxChars)
        return {
          path: rel,
          format: result.format,
          text: content.text,
          truncated: content.truncated,
          ...(Array.isArray(result.sheets)
            ? { sheets: result.sheets.map((sheet: { name: string; rows: unknown[][] }) => ({ name: sheet.name, rows: sheet.rows.length })) }
            : {})
        }
      }
    },
    {
      name: 'office_create_document',
      description: '在工作区创建 DOCX 文档。markdown 中的标题、列表和正文会转换为 Word 段落。',
      parameters: obj({
        path: { type: 'string' },
        title: { type: 'string' },
        markdown: { type: 'string' },
        overwrite: { type: 'boolean' }
      }, ['path', 'markdown']),
      risk: 'write',
      approval: 'always',
      async execute(args: ToolArgs, ctx: AiToolContext) {
        const target = String(args.path || '')
        if (path.extname(target).toLowerCase() !== '.docx') throw fail('文件扩展名必须是 .docx', 'AI_BAD_ARGS')
        const { abs, root } = await resolveFile(ctx, target)
        if (sensitive(relativePath(root, abs))) throw fail('该路径可能包含密钥或凭据，已拒绝写入', 'AI_SENSITIVE_FILE')
        const data = docxFromMarkdown(String(args.title || ''), String(args.markdown || ''))
        if (data.length > MAX_OFFICE_BYTES) throw fail('生成的文档超过 32MB', 'AI_FILE_TOO_LARGE')
        await atomicWrite(abs, data, args.overwrite === true)
        return { ok: true, path: relativePath(root, abs), bytes: data.length }
      }
    },
    {
      name: 'office_create_workbook',
      description: '在工作区创建 XLSX 工作簿。sheets=[{name,rows:[[值...],...]}]；字符串、数字、布尔值会保留类型。',
      parameters: obj({
        path: { type: 'string' },
        sheets: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              rows: { type: 'array', items: { type: 'array', items: {} } }
            }
          }
        },
        overwrite: { type: 'boolean' }
      }, ['path', 'sheets']),
      risk: 'write',
      approval: 'always',
      async execute(args: ToolArgs, ctx: AiToolContext) {
        const target = String(args.path || '')
        if (path.extname(target).toLowerCase() !== '.xlsx') throw fail('文件扩展名必须是 .xlsx', 'AI_BAD_ARGS')
        const { abs, root } = await resolveFile(ctx, target)
        if (sensitive(relativePath(root, abs))) throw fail('该路径可能包含密钥或凭据，已拒绝写入', 'AI_SENSITIVE_FILE')
        const data = xlsxFromSheets(Array.isArray(args.sheets) ? args.sheets : [])
        if (data.length > MAX_OFFICE_BYTES) throw fail('生成的工作簿超过 32MB', 'AI_FILE_TOO_LARGE')
        await atomicWrite(abs, data, args.overwrite === true)
        return { ok: true, path: relativePath(root, abs), bytes: data.length }
      }
    },
    {
      name: 'office_create_presentation',
      description: '在工作区创建基础 PPTX 演示文稿。slides=[{title,bullets:[...]}]，最多 100 页。',
      parameters: obj({
        path: { type: 'string' },
        title: { type: 'string' },
        slides: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              bullets: { type: 'array', items: { type: 'string' } }
            }
          }
        },
        overwrite: { type: 'boolean' }
      }, ['path', 'slides']),
      risk: 'write',
      approval: 'always',
      async execute(args: ToolArgs, ctx: AiToolContext) {
        const target = String(args.path || '')
        if (path.extname(target).toLowerCase() !== '.pptx') throw fail('文件扩展名必须是 .pptx', 'AI_BAD_ARGS')
        const { abs, root } = await resolveFile(ctx, target)
        if (sensitive(relativePath(root, abs))) throw fail('该路径可能包含密钥或凭据，已拒绝写入', 'AI_SENSITIVE_FILE')
        const data = pptxFromSlides(String(args.title || ''), Array.isArray(args.slides) ? args.slides : [])
        if (data.length > MAX_OFFICE_BYTES) throw fail('生成的演示文稿超过 32MB', 'AI_FILE_TOO_LARGE')
        await atomicWrite(abs, data, args.overwrite === true)
        return { ok: true, path: relativePath(root, abs), bytes: data.length }
      }
    },
    {
      name: 'shell_run',
      description: '在工作区执行一个非交互命令（command + args 数组），用于构建、测试、Git、格式化。命令拥有当前用户权限，执行前必须经过审批。',
      parameters: obj({
        command: { type: 'string', description: '可执行文件，如 node / git / pnpm' },
        args: { type: 'array', items: { type: 'string' }, description: '参数数组，不写 shell 引号' },
        cwd: { type: 'string', description: '相对工作区目录，默认根目录' },
        timeoutMs: { type: 'number', description: '超时 1-600 秒，默认 120 秒' }
      }, ['command']),
      risk: 'destructive',
      approval: 'always',
      async execute(args: ToolArgs, ctx: AiToolContext) {
        if (!processRunner) throw fail('命令执行端口不可用', 'AI_PROCESS_UNAVAILABLE')
        const command = String(args.command || '').trim()
        if (!command) throw fail('command 不能为空', 'AI_BAD_ARGS')
        const argv = Array.isArray(args.args) ? args.args.map((item) => String(item)) : []
        if (argv.length > 200) throw fail('参数过多', 'AI_BAD_ARGS')
        const cwdTarget = String(args.cwd || '.')
        const { abs, root } = await workspacePort().resolve(ctx.sessionId, cwdTarget, { allowRoot: true })
        const stat = await fs.stat(abs)
        if (!stat.isDirectory()) throw fail('cwd 不是目录', 'AI_NOT_DIRECTORY')
        const timeoutMs = Math.max(1000, Math.min(Math.round(Number(args.timeoutMs) || 120_000), 600_000))
        const relativeCwd = relativePath(root, abs)
        try {
          const result = await processRunner.run(command, argv, {
            cwd: abs,
            timeoutMs,
            signal: ctx.signal
          })
          const stdout = clip(String(result.stdout || ''))
          const stderr = clip(String(result.stderr || ''))
          return {
            ok: true,
            command,
            args: argv,
            cwd: relativeCwd,
            stdout: stdout.text,
            stderr: stderr.text,
            truncated: stdout.truncated || stderr.truncated
          }
        } catch (e) {
          const record = e && typeof e === 'object' ? e as Record<string, unknown> : {}
          const stdout = clip(String(record.stdout || ''))
          const stderr = clip(String(record.stderr || record.message || e || ''))
          return {
            ok: false,
            command,
            args: argv,
            cwd: relativeCwd,
            exitCode: typeof record.code === 'number' ? record.code : null,
            timedOut: record.timedOut === true,
            stdout: stdout.text,
            stderr: stderr.text,
            truncated: stdout.truncated || stderr.truncated
          }
        }
      }
    }
  ]

  return tools
}

module.exports = { createLocalTools }

import { IPC_ROUTES, rpc } from './runtime.js'
import {
  WORKSPACE_RULE_SETTING_KEYS,
  parseWorkspaceTasks,
  serializeWorkspaceTasks,
  type WorkspaceTask
} from '@hira-ng/shared-types/src/workspace-rules.mjs'

export interface WorkspaceTaskCaptureResult {
  ok: boolean
  tasks: WorkspaceTask[]
  task?: WorkspaceTask
  error?: string
}

export async function loadWorkspaceTasks(): Promise<WorkspaceTask[]> {
  try {
    const result = await rpc<{ value?: unknown }>(IPC_ROUTES.settingsGet, {
      key: WORKSPACE_RULE_SETTING_KEYS.tasks
    })
    return parseWorkspaceTasks(result?.value)
  } catch {
    return []
  }
}

export async function persistWorkspaceTasks(tasks: WorkspaceTask[]): Promise<WorkspaceTask[]> {
  const normalized = parseWorkspaceTasks(tasks)
  await rpc(IPC_ROUTES.settingsSet, {
    key: WORKSPACE_RULE_SETTING_KEYS.tasks,
    value: serializeWorkspaceTasks(normalized)
  })
  return normalized
}

export async function captureWorkspaceTask(name: string): Promise<WorkspaceTaskCaptureResult> {
  const cleanName = String(name || '').trim().slice(0, 80)
  if (!cleanName) return { ok: false, tasks: [], error: '请输入任务工作区名称' }

  const [current, tabs] = await Promise.all([
    loadWorkspaceTasks(),
    rpc<Array<{ url?: string; title?: string; pinned?: boolean }>>(IPC_ROUTES.tabList, {})
  ])
  const task: WorkspaceTask = {
    id: `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    name: cleanName,
    createdAt: Date.now(),
    tabs: (Array.isArray(tabs) ? tabs : [])
      .filter((tab) => /^https?:\/\//i.test(String(tab.url || '')))
      .map((tab) => ({
        url: String(tab.url || ''),
        title: String(tab.title || tab.url || ''),
        pinned: tab.pinned === true
      }))
  }
  if (!task.tabs.length) return { ok: false, tasks: current, error: '当前没有可保存的网页标签' }

  const tasks = await persistWorkspaceTasks([task, ...current].slice(0, 50))
  return { ok: true, tasks, task }
}

export async function restoreWorkspaceTask(task: WorkspaceTask): Promise<number> {
  let restored = 0
  for (const tab of task.tabs) {
    await rpc(IPC_ROUTES.tabNew, {
      url: tab.url,
      openInBackground: true,
      pinned: tab.pinned
    })
    restored += 1
  }
  return restored
}

export async function removeWorkspaceTask(id: string): Promise<WorkspaceTask[]> {
  const tasks = await loadWorkspaceTasks()
  return persistWorkspaceTasks(tasks.filter((task) => task.id !== id))
}

import type { PanelInstance, PanelMountResult } from './panel-definition.js'

/** 把面板定义允许的三种挂载结果收口成宿主使用的统一实例。 */
export function normalizePanelInstance(result: PanelMountResult): PanelInstance | null {
  if (!result) return null
  if (result instanceof HTMLElement) return { element: result }
  return result
}

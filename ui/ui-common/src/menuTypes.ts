/**
 * 菜单宿主与纯菜单模板之间的最小契约。
 *
 * ui-common 只描述菜单长什么样；原生菜单由宿主注入，插件插槽也不会泄漏到 UI 模块。
 * `action` 是渲染层自洽的字符串，具体调用哪个服务由编排层决定。
 */

export interface MenuItem {
  type?: 'normal' | 'separator' | 'checkbox' | 'radio' | 'submenu' | string
  label?: string
  action?: string | null
  enabled?: boolean
  visible?: boolean
  checked?: boolean
  accelerator?: string
  submenu?: readonly MenuItem[]
  [key: string]: unknown
}

export interface MenuPopPayload<Context = unknown> {
  x: number
  y: number
  items: MenuItem[]
  context?: Context
  [key: string]: unknown
}

export type PopMenu<Context = unknown> = (
  payload: MenuPopPayload<Context>
) => Promise<string | null>

interface TabbarCaseDefinition {
  id?: string
  name?: string
  theme: 'light' | 'dark'
  width: number
  height: number
  decorations?: boolean
  tabs: TabbarProjection[]
}

interface TabbarProjection {
  type?: 'stack'
  tabId?: string
  stackId?: string
  active?: boolean
  [key: string]: unknown
}

interface TabbarMetrics {
  tabCount: number
  stackCount: number
  decorationCount: number
  tabsWidth: number
  tabsHeight: number
  dom: string
}

interface Window {
  __CASE?: TabbarCaseDefinition
  __metrics?: TabbarMetrics
  __ready?: boolean
}

declare module '*tabbar.mjs' {
  interface TabbarInstance {
    element: HTMLElement
    renderTabs(tabs: TabbarProjection[]): void
  }

  interface TabbarOptions {
    slots?: {
      itemDecorator?: (payload: { tabId?: string }) => HTMLElement
      stackDecorator?: (payload: { stackId?: string }) => HTMLElement
    }
  }

  export function injectTabbarStyles(document: Document): void
  export function createTabbar(document: Document, options?: TabbarOptions): TabbarInstance
}

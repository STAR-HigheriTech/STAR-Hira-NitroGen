/** 标签容器图层：把焦点与可见性代理到当前可见标签视图。 */
import { Layer } from './LayerManager'

interface TabContents {
  isDestroyed?(): boolean
  isFocused(): boolean
  focus(): void
}

interface VisibleTabView { webContents?: TabContents | null }

const { zIndexFor, focusPriorityFor, createModalTo } = require('./LayerStack')

export class TabHostLayer extends Layer {
  private readonly _getVisibleTabView: (() => VisibleTabView | null | undefined) | null

  constructor(
    manager: ConstructorParameters<typeof Layer>[0],
    view: unknown,
    getVisibleTabView?: (() => VisibleTabView | null | undefined) | null
  ) {
    super(manager, view, {
      name: 'tab-layer',
      zIndex: zIndexFor('tab-layer'),
      focusPriority: focusPriorityFor('tab-layer'),
      modalTo: createModalTo('tab-layer')
    })
    this._getVisibleTabView = getVisibleTabView || null
  }

  _visibleWebContents(): TabContents | null {
    const view = this._getVisibleTabView ? this._getVisibleTabView() : null
    return view && view.webContents ? view.webContents : null
  }

  isFocused(): boolean {
    const webContents = this._visibleWebContents()
    if (!webContents || typeof webContents.isDestroyed !== 'function' || webContents.isDestroyed()) {
      return false
    }
    return webContents.isFocused()
  }

  focus(): boolean {
    if (this.manager.getModalLayersFor(this).length > 0) return false
    const webContents = this._visibleWebContents()
    if (
      !webContents ||
      (typeof webContents.isDestroyed === 'function' && webContents.isDestroyed())
    ) {
      return false
    }
    try {
      webContents.focus()
      return true
    } catch (_) {
      return false
    }
  }

  isVisible(): boolean {
    return !!(this._getVisibleTabView && this._getVisibleTabView())
  }
}

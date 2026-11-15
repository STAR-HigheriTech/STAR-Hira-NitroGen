import type { WebContents } from 'electron'

export interface WebNavigationState {
  canGoBack: boolean
  canGoForward: boolean
  loading: boolean
}

type NavigationDirection = 'back' | 'forward'

interface NavigationHistoryLike {
  canGoBack?: () => boolean
  canGoForward?: () => boolean
  goBack?: () => void
  goForward?: () => void
}

function live(webContents: WebContents | null | undefined): webContents is WebContents {
  if (!webContents) return false
  try {
    return !webContents.isDestroyed()
  } catch (_) {
    return false
  }
}

function readBoolean(read: (() => boolean) | undefined, receiver: unknown): boolean {
  if (typeof read !== 'function') return false
  try {
    return !!read.call(receiver)
  } catch (_) {
    return false
  }
}

function call(operation: (() => void) | undefined, receiver: unknown): boolean {
  if (typeof operation !== 'function') return false
  try {
    operation.call(receiver)
    return true
  } catch (_) {
    return false
  }
}

/**
 * Chromium navigation state has one authoritative implementation for every
 * browser surface: tabs, page menus, web sidebar and PWA windows.
 */
export function readWebNavigationState(webContents: WebContents | null | undefined): WebNavigationState {
  if (!live(webContents)) {
    return { canGoBack: false, canGoForward: false, loading: false }
  }

  let history: NavigationHistoryLike | null = null
  try {
    history = webContents.navigationHistory || null
  } catch (_) {}

  return {
    canGoBack: readBoolean(history?.canGoBack, history),
    canGoForward: readBoolean(history?.canGoForward, history),
    loading: readBoolean(webContents.isLoading, webContents)
  }
}

/**
 * Moves one history step and reports whether Chromium accepted the action.
 * It intentionally never throws so every caller can keep the UI responsive.
 */
export function navigateWebHistory(
  webContents: WebContents | null | undefined,
  direction: NavigationDirection
): boolean {
  if (!live(webContents)) return false

  let history: NavigationHistoryLike | null = null
  try {
    history = webContents.navigationHistory || null
  } catch (_) {}

  const canMethod = direction === 'back' ? 'canGoBack' : 'canGoForward'
  const goMethod = direction === 'back' ? 'goBack' : 'goForward'
  if (readBoolean(history?.[canMethod], history) && call(history?.[goMethod], history)) return true

  return false
}

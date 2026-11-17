interface DestroyableContents {
  isDestroyed?(): boolean
  once?(event: 'destroyed', listener: () => void): unknown
  removeListener?(event: 'destroyed', listener: () => void): unknown
}

interface DestroyRecord {
  cleanups: Set<() => void>
  listener: () => void
}

const records = new WeakMap<object, DestroyRecord>()

export function onWebContentsDestroyed(
  webContents: DestroyableContents | null | undefined,
  cleanup: () => void
): () => void {
  if (!webContents || typeof cleanup !== 'function') return () => {}
  try {
    if (typeof webContents.isDestroyed === 'function' && webContents.isDestroyed()) {
      try { cleanup() } catch {}
      return () => {}
    }
  } catch {}
  if (typeof webContents.once !== 'function') return () => {}
  let record = records.get(webContents)
  if (!record) {
    const cleanups = new Set<() => void>()
    const listener = (): void => {
      const current = records.get(webContents)
      records.delete(webContents)
      if (!current) return
      for (const run of current.cleanups) {
        try { run() } catch {}
      }
      current.cleanups.clear()
    }
    record = { cleanups, listener }
    records.set(webContents, record)
    try { webContents.once('destroyed', listener) } catch {
      records.delete(webContents)
      return () => {}
    }
  }

  const current = record
  current.cleanups.add(cleanup)
  let active = true
  return () => {
    if (!active) return
    active = false
    current.cleanups.delete(cleanup)
    if (current.cleanups.size > 0 || records.get(webContents) !== current) return
    records.delete(webContents)
    try { webContents.removeListener?.('destroyed', current.listener) } catch {}
  }
}

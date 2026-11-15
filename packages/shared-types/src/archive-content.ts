export const ARCHIVE_CONTENT_HOST = 'archive-content'

export function archiveContentUrl(noteId: unknown): string {
  const id = String(noteId || '').trim()
  return id ? `hira://${ARCHIVE_CONTENT_HOST}/${encodeURIComponent(id)}/` : ''
}

export function archiveContentId(pathname: unknown): string {
  const first = String(pathname || '')
    .split('/')
    .filter(Boolean)[0]
  if (!first) return ''
  try {
    return decodeURIComponent(first)
  } catch {
    return ''
  }
}

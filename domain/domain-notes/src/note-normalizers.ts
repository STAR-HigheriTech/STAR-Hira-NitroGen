import {
  type NoteKind,
  type NoteRefMode,
  type NoteRow
} from './types'
import type { Note } from './types'
import { NOTE_KINDS, REF_MODES } from '@hira-ng/shared-types/src/notes.mjs'

const noteKinds = NOTE_KINDS as readonly NoteKind[]
const refModes = REF_MODES as readonly NoteRefMode[]

export function serializeTags(tags: readonly string[] | null | undefined): string | null {
  if (!Array.isArray(tags) || tags.length === 0) return null
  const normalized = tags.map((tag) => String(tag).trim()).filter(Boolean)
  return normalized.length ? JSON.stringify(normalized) : null
}

export function parseTags(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const value: unknown = JSON.parse(raw)
    return Array.isArray(value) ? value.map(String) : []
  } catch {
    return []
  }
}

export function normalizeNote(row: NoteRow | null | undefined): Note | null {
  if (!row) return null
  return { ...row, tags: parseTags(row.tags), pinned: Boolean(row.pinned) }
}

export function normalizeKind(value: unknown, fallback: NoteKind = 'note'): NoteKind {
  return noteKinds.includes(value as NoteKind) ? (value as NoteKind) : fallback
}

export function toDimension(value: unknown): number {
  const valueAsNumber = Number(value)
  return Number.isFinite(valueAsNumber) && valueAsNumber > 0 ? Math.round(valueAsNumber) : 0
}

export function normalizeRefMode(value: unknown): NoteRefMode {
  return refModes.includes(value as NoteRefMode) ? (value as NoteRefMode) : 'chip'
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

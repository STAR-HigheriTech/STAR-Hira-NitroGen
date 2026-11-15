export { createNoteService } from './note-service'
export {
  normalizeKind,
  normalizeNote,
  normalizeRefMode,
  parseTags,
  serializeTags,
  toDimension
} from './note-normalizers'
export { NOTE_KINDS } from '@hira-ng/shared-types/src/notes.mjs'
export type {
  AddFolderInput,
  AddNoteInput,
  BacklinkNote,
  CaptureNoteInput,
  ListNotesOptions,
  Note,
  NoteChange,
  NoteChangeListener,
  NoteChangeReason,
  NoteFolder,
  NoteKind,
  NoteRefMode,
  NoteService,
  NoteServiceOptions,
  UpdateNoteInput
} from './types'

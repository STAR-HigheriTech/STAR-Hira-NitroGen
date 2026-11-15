import type { IpcRoutes, IpcSchemas, IpcTypedMain } from './types'
import { archiveContentUrl } from '@hira-ng/shared-types/src/archive-content.mjs'

interface PageLibraryPort {
  listArchives(query?: string): unknown[]
  archiveActive(): Promise<unknown>
}

interface NotesPort {
  get(id: string): Record<string, unknown> | null
}

export function registerPageLibraryIpc(
  typedMain: IpcTypedMain,
  options: {
    routes: IpcRoutes
    schemas: IpcSchemas['pageLibrary']
    pageLibrary?: PageLibraryPort | null
    notesService?: NotesPort | null
  }
): void {
  const { routes, schemas, pageLibrary, notesService } = options
  if (!pageLibrary) return

  typedMain.handle(routes.pageArchiveList, {
    requestSchema: schemas.archiveList.request,
    responseSchema: schemas.archiveList.response,
    handler: async (_e, req) => pageLibrary.listArchives(req?.query || '')
  })
  typedMain.handle(routes.pageArchiveSaveActive, {
    requestSchema: schemas.archiveSaveActive.request,
    responseSchema: schemas.archiveSaveActive.response,
    handler: async () => pageLibrary.archiveActive()
  })
  typedMain.handle(routes.pageArchiveGet, {
    requestSchema: schemas.archiveGet.request,
    responseSchema: schemas.archiveGet.response,
    handler: async (_e, req) => {
      const note = notesService?.get(req.id) || null
      if (!note) return null
      return {
        ...note,
        archiveUrl: note.assetPath ? archiveContentUrl(note.id) : ''
      }
    }
  })
}

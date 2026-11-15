import type { IpcMain } from 'electron'
import type { TypedIpcMain } from '@hira-ng/infra-ipc'

export type IpcRoutes = typeof import('@hira-ng/shared-types/src/ipc-channels.mjs').IPC_ROUTES
export type IpcSchemas = typeof import('@hira-ng/infra-ipc').ipcSchemas
export type IpcTypedMain = TypedIpcMain
export type IpcRawMain = IpcMain

export interface IpcEventPort {
  (route: string, payload: unknown, options?: { skipWebContentsId?: number; windowId?: number | null }): number
}

export interface IpcRegistrationBase {
  routes: IpcRoutes
  schemas: IpcSchemas
  emit: IpcEventPort
  emitToWindow(windowId: number, route: string, payload: unknown): unknown
}

export interface EventRelay {
  start(): void
  stop(): void
}

export interface BroadcasterPort {
  send(route: string, payload: unknown, options?: Record<string, unknown>): number
}

export interface SubscriptionService<Change> {
  subscribe(listener: (change: Change) => void): () => void
}

export interface NumericRecord {
  [key: string]: unknown
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

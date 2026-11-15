import type {
  AiActionResponse,
  aiClient
} from 'hira://shared/ai-client.js'

export type AiSettingsClient = Pick<typeof aiClient, 'providers' | 'usage' | 'auditExport' | 'purge'>

export interface AiSettingsSectionPort {
  client: AiSettingsClient
  request<T extends AiActionResponse>(fn: () => Promise<T>, okText?: string): Promise<T | null>
  notify(text: string, ok?: boolean): void
  setCount(count: number): void
}

export interface AiSettingsSection {
  element: HTMLElement
  activate(): void
  refresh(): Promise<void>
  onStateChanged(reason?: string): void
}

export type AiSettingsSectionFactory = (port: AiSettingsSectionPort) => AiSettingsSection

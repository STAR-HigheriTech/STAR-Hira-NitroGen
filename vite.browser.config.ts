import { resolve } from 'node:path'
import { defineConfig, type UserConfig } from 'vite'
import electronConfig from './electron.vite.config'

const config = electronConfig as unknown as { renderer?: UserConfig }
const renderer = config.renderer || {}
const port = Number(process.env.HIRA_PREVIEW_PORT) || 4173

export default defineConfig({
  ...renderer,
  root: resolve(import.meta.dirname, 'apps/app-main/src/renderer'),
  server: {
    ...renderer.server,
    host: '127.0.0.1',
    port,
    strictPort: false
  }
})

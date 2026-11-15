import { historySchemas } from './history'
import { searchSchemas } from './search'
import { keybindingsSchemas } from './keybindings'
import { profileSchemas } from './profile'
import { permissionsSchemas } from './permissions'
import { downloadsSchemas } from './downloads'
import { bookmarksSchemas } from './bookmarks'
import { notesSchemas } from './notes'
import { totpSchemas } from './totp'
import { pwaSchemas } from './pwa'
import { tabsSchemas } from './tabs'
import { layoutSchemas } from './layout'
import { extensionsSchemas } from './extensions'
import { passwordsSchemas } from './passwords'
import { windowSchemas } from './window'
import { settingsSchemas } from './settings'
import { externalGamesSchemas } from './external-games'
import { bookmarkBackupSchemas } from './bookmark-backup'
import { sessionSchemas } from './session'
import { ntpSchemas } from './ntp'
import { spaceSchemas } from './space'
import { snapshotSchemas } from './snapshot'
import { tabMemorySchemas } from './tab-memory'
import { screenSchemas } from './screen'
import { buttonsEditSchemas } from './buttons-edit'
import { layoutDocumentSchemas } from './layout-document'
import { cookiesSchemas } from './cookies'
import { browsingDataSchemas } from './browsing-data'
import { appSchemas, pageSchemas } from './app-metrics'
import { crashSchemas, certificateSchemas } from './security'
import { homeSchemas } from './home'
import { listenersSchemas } from './listeners'
import { httpAuthSchemas } from './http-auth'
import { openExternalSchemas } from './open-external'
import { pluginsSchemas } from './plugins'
import { passkeySchemas } from './passkey'
import { captureHubSchemas } from './capture-hub'
import { pageLibrarySchemas } from './page-library'
import { slotsSchemas } from './slots'
import { automationSchemas } from './automation'
import { translateSchemas } from './translate'
import { breakSchemas } from './break-mode'
import { printSchemas } from './print'
import { captureEditorSchemas } from './capture'
import { filesSchemas } from './files'
import { updateSchemas } from './update'
import { onboardingSchemas } from './onboarding'
import { browserImportSchemas } from './browser-import'
import { aiSchemas } from './ai'

const ipcSchemas = Object.freeze({
  history: historySchemas,
  search: searchSchemas,
  keybindings: keybindingsSchemas,
  profile: profileSchemas,
  permissions: permissionsSchemas,
  downloads: downloadsSchemas,
  bookmarks: bookmarksSchemas,
  notes: notesSchemas,
  totp: totpSchemas,
  pwa: pwaSchemas,
  tabs: tabsSchemas,
  layout: layoutSchemas,
  extensions: extensionsSchemas,
  passwords: passwordsSchemas,
  window: windowSchemas,
  settings: settingsSchemas,
  externalGames: externalGamesSchemas,
  bookmarkBackup: bookmarkBackupSchemas,
  session: sessionSchemas,
  ntp: ntpSchemas,
  space: spaceSchemas,
  snapshot: snapshotSchemas,
  tabMemory: tabMemorySchemas,
  screen: screenSchemas,
  buttonsEdit: buttonsEditSchemas,
  layoutDocument: layoutDocumentSchemas,
  cookies: cookiesSchemas,
  browsingData: browsingDataSchemas,
  app: appSchemas,
  page: pageSchemas,
  crash: crashSchemas,
  certificate: certificateSchemas,
  home: homeSchemas,
  listeners: listenersSchemas,
  httpAuth: httpAuthSchemas,
  openExternal: openExternalSchemas,
  plugins: pluginsSchemas,
  passkey: passkeySchemas,
  captureHub: captureHubSchemas,
  pageLibrary: pageLibrarySchemas,
  slots: slotsSchemas,
  automation: automationSchemas,
  translate: translateSchemas,
  break: breakSchemas,
  print: printSchemas,
  captureEditor: captureEditorSchemas,
  files: filesSchemas,
  update: updateSchemas,
  onboarding: onboardingSchemas,
  browserImport: browserImportSchemas,
  ai: aiSchemas
})

export { ipcSchemas }


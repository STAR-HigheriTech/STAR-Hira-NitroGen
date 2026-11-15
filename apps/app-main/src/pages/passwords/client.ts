import { IPC_ROUTES, rpc } from 'hira://shared/runtime.js'
import { errorMessage, isRecord } from 'hira://shared/page-kit.js'
import type {
  BackendActionName,
  BackendActionResult,
  CredentialEditorInput,
  CredentialSecret,
  PasswordAuditKind,
  PasswordAuditResult,
  PasswordBackend,
  PasswordBackendStatus,
  PasswordExportResult,
  PasswordMutationResult,
  SavedCredential,
  SignInField
} from './types.js'

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function toSignInField(value: unknown): SignInField | null {
  if (!isRecord(value)) return null
  const key = stringValue(value.key).trim()
  if (!key) return null
  const type = value.type === 'password' || value.type === 'email' ? value.type : 'text'
  return {
    key,
    label: stringValue(value.label) || key,
    type,
    placeholder: stringValue(value.placeholder) || undefined
  }
}

function toStatus(value: unknown): PasswordBackendStatus | undefined {
  if (!isRecord(value)) return undefined
  const fields = Array.isArray(value.signInFields)
    ? value.signInFields.map(toSignInField).filter((field): field is SignInField => field !== null)
    : []
  return {
    configured: value.configured === true,
    toolFound: value.toolFound === true,
    displayName: stringValue(value.displayName) || undefined,
    unlocked: value.unlocked === true,
    signInRequired: value.signInRequired === true,
    installMode: stringValue(value.installMode) || undefined,
    downloadLink: stringValue(value.downloadLink) || undefined,
    toolFileName: stringValue(value.toolFileName) || undefined,
    localToolPath: stringValue(value.localToolPath) || undefined,
    version: stringValue(value.version) || undefined,
    versionOk: value.versionOk === true,
    minVersion: stringValue(value.minVersion) || undefined,
    readOnly: value.readOnly === true,
    account: stringValue(value.account) || undefined,
    signInLabel: stringValue(value.signInLabel) || undefined,
    signInHint: stringValue(value.signInHint) || undefined,
    signInFields: fields,
    unlockHint: stringValue(value.unlockHint) || undefined,
    unlockedHint: stringValue(value.unlockedHint) || undefined,
    actions: isRecord(value.actions) ? { sync: value.actions.sync === true } : undefined
  }
}

function toBackend(value: unknown): PasswordBackend | null {
  if (!isRecord(value)) return null
  const name = stringValue(value.name).trim()
  if (!name) return null
  return {
    name,
    available: value.available !== false,
    active: value.active === true,
    writable: value.writable !== false,
    status: toStatus(value.status)
  }
}

function toCredential(value: unknown): SavedCredential | null {
  if (!isRecord(value)) return null
  const id = stringValue(value.id).trim()
  const domain = stringValue(value.domain) || stringValue(value.hostname)
  if (!id || !domain) return null
  return {
    id,
    domain,
    username: stringValue(value.username),
    lastUsedAt: typeof value.lastUsedAt === 'number' ? value.lastUsedAt : null,
    createdAt: typeof value.createdAt === 'number' ? value.createdAt : 0,
    manager: stringValue(value.manager)
  }
}

function toAuditResult(value: unknown): PasswordAuditResult {
  if (!isRecord(value)) return { checked: 0, issues: [] }
  const issues = Array.isArray(value.issues)
    ? value.issues.flatMap((issue) => {
        if (!isRecord(issue)) return []
        const id = stringValue(issue.id)
        if (!id) return []
        const kinds = Array.isArray(issue.kinds)
          ? issue.kinds.filter((kind): kind is PasswordAuditKind => typeof kind === 'string' && kind.length > 0)
          : []
        return [{
          id,
          domain: stringValue(issue.domain),
          username: stringValue(issue.username),
          kinds
        }]
      })
    : []
  return {
    checked: typeof value.checked === 'number' ? value.checked : 0,
    issues,
    unsupported: value.unsupported === true
  }
}

function toCredentialSecret(value: unknown): CredentialSecret | null {
  const credential = toCredential(value)
  if (!credential || !isRecord(value)) return null
  const strength = isRecord(value.strength)
    ? {
        score: typeof value.strength.score === 'number' ? value.strength.score : 0,
        label: stringValue(value.strength.label) || '极弱'
      }
    : { score: 0, label: '极弱' }
  return { ...credential, password: stringValue(value.password), strength }
}

async function actionCall(work: () => Promise<unknown>): Promise<BackendActionResult> {
  try {
    const result = await work()
    if (!isRecord(result)) return { ok: false, reason: 'invalid-response' }
    return {
      ok: result.ok === true,
      reason: stringValue(result.reason) || undefined,
      message: stringValue(result.message) || undefined,
      path: stringValue(result.path) || undefined
    }
  } catch (error) {
    return { ok: false, message: errorMessage(error) }
  }
}

export const passwordsClient = {
  async listBackends(): Promise<PasswordBackend[]> {
    const rows = await rpc<unknown>(IPC_ROUTES.passwordBackends, {})
    return (Array.isArray(rows) ? rows : [])
      .map(toBackend)
      .filter((backend): backend is PasswordBackend => backend !== null)
  },

  async listCredentials(): Promise<SavedCredential[]> {
    const rows = await rpc<unknown>(IPC_ROUTES.passwordList, {})
    return (Array.isArray(rows) ? rows : [])
      .map(toCredential)
      .filter((credential): credential is SavedCredential => credential !== null)
  },

  async listNeverSave(): Promise<string[]> {
    const rows = await rpc<unknown>(IPC_ROUTES.passwordNeverSaveList, {})
    return Array.isArray(rows) ? rows.filter((row): row is string => typeof row === 'string' && row.length > 0) : []
  },

  setActive(name: string): Promise<PasswordMutationResult> {
    return rpc<PasswordMutationResult>(IPC_ROUTES.passwordSetActive, { name })
  },

  deleteCredential(id: string): Promise<PasswordMutationResult> {
    return rpc<PasswordMutationResult>(IPC_ROUTES.passwordDelete, { id })
  },

  saveCredential(input: { hostname: string; username: string; password: string }): Promise<PasswordMutationResult> {
    return rpc<PasswordMutationResult>(IPC_ROUTES.passwordSave, input)
  },

  updateCredential(input: CredentialEditorInput & { id: string }): Promise<PasswordMutationResult> {
    return rpc<PasswordMutationResult>(IPC_ROUTES.passwordUpdate, input)
  },

  async revealCredential(id: string): Promise<CredentialSecret | null> {
    const result = await rpc<unknown>(IPC_ROUTES.passwordReveal, { id })
    return isRecord(result) && result.ok === true ? toCredentialSecret(result.credential) : null
  },

  importCsv(content: string): Promise<unknown> {
    return rpc(IPC_ROUTES.passwordImportCsv, { content })
  },

  exportCsv(): Promise<PasswordExportResult> {
    return rpc<PasswordExportResult>(IPC_ROUTES.passwordExport, {})
  },

  addNeverSave(hostname: string): Promise<PasswordMutationResult> {
    return rpc<PasswordMutationResult>(IPC_ROUTES.passwordNeverSaveAdd, { hostname })
  },

  removeNeverSave(hostname: string): Promise<PasswordMutationResult> {
    return rpc<PasswordMutationResult>(IPC_ROUTES.passwordNeverSaveRemove, { hostname })
  },

  async audit(): Promise<PasswordAuditResult> {
    const result = await rpc<unknown>(IPC_ROUTES.passwordAudit, {})
    return toAuditResult(result)
  },

  backendAction(
    backend: PasswordBackend,
    action: BackendActionName,
    payload: Record<string, string> = {}
  ): Promise<BackendActionResult> {
    return actionCall(() => rpc(IPC_ROUTES.passwordBackendAction, {
      name: backend.name,
      action,
      ...payload
    }))
  },

  installTool(name: string): Promise<BackendActionResult> {
    return actionCall(() => rpc(IPC_ROUTES.passwordInstallTool, { name }))
  }
}

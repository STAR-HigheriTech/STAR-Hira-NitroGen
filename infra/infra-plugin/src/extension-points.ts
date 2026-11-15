import type { UnknownRecord } from './types'
import {
  EXTENSION_POINT_MODES,
  type ExtensionPointMode
} from '@hira-ng/shared-types/src/plugin-core'

export const EP_MODES = EXTENSION_POINT_MODES

export type ExtensionMode = ExtensionPointMode
export type ExtensionImplementation = (...args: never[]) => unknown
export type ExtensionContext = UnknownRecord
export interface ExtensionImplementationMeta { pluginId?: string; key?: string; order?: number }
export interface ExtensionPointInput {
  id: string
  mode: string
  description?: string
  owner?: string
  paramsSchema?: unknown
  resultSchema?: unknown
  initialValue?: unknown
}
export interface ExtensionPointSpec {
  id: string
  mode: ExtensionMode
  description: string
  owner: string
  paramsSchema: unknown
  resultSchema: unknown
  initialValue: unknown
  hasInitialValue: boolean
}
export interface ExtensionPointSummary {
  id: string
  mode: ExtensionMode
  description: string
  owner: string
  implCount: number
  hasParamsSchema: boolean
  hasResultSchema: boolean
}
export interface ExtensionPointEntry {
  key: string
  pluginId: string | null
  order: number
  value: unknown
}
export interface ExtensionPointRegistryOptions {
  onError?: (extensionPointId: string, error: unknown, implementation?: unknown) => void
  logger?: { warn?: (...args: unknown[]) => void; error?: (...args: unknown[]) => void }
}
export interface ExtensionPointRegistry {
  readonly MODES: typeof EP_MODES
  define(spec: ExtensionPointInput, meta?: { pluginId?: string }): ExtensionPointSpec
  isDefined(extensionPointId: string): boolean
  getSpec(extensionPointId: string): ExtensionPointSpec | null
  listSpecs(): ExtensionPointSummary[]
  implement(extensionPointId: string, implementation: ExtensionImplementation, meta?: ExtensionImplementationMeta): string
  implementAll(entries: Array<{ to: string; impl: ExtensionImplementation; key?: string; order?: number }>, meta?: Omit<ExtensionImplementationMeta, 'key' | 'order'>): number
  removeImplementations(pluginId: string): number
  countImplementations(extensionPointId: string): number
  callSync<TResult = unknown>(extensionPointId: string, payload: unknown, context?: ExtensionContext): TResult
  call<TResult = unknown>(extensionPointId: string, payload: unknown, context?: ExtensionContext): Promise<TResult>
  callWithKeysSync<TResult = unknown>(extensionPointId: string, payload: unknown, context?: ExtensionContext): Array<ExtensionPointEntry & { value: TResult }>
  reset(): void
  readonly size: number
}

interface ImplementationEntry {
  impl: ExtensionImplementation
  pluginId: string | null
  order: number
  seq: number
  key: string
}

const VALID_MODES = new Set<ExtensionMode>(Object.values(EP_MODES))
const SYNC_VIOLATION = 'EP_SYNC_VIOLATION'

const isRecord = (value: unknown): value is UnknownRecord => !!value && typeof value === 'object'

export function formatIssues(error: unknown): string {
  try {
    if (isRecord(error) && Array.isArray(error.issues)) {
      return error.issues.map((issue) => {
        if (!isRecord(issue)) return String(issue)
        const path = Array.isArray(issue.path) ? issue.path.join('.') : '(root)'
        return `${path}: ${String(issue.message ?? 'invalid value')}`
      }).join('; ')
    }
    return String(isRecord(error) ? error.message ?? error : error)
  } catch {
    return '未知校验错误'
  }
}

export function validateWith(schema: unknown, value: unknown, label: string): unknown {
  if (!isRecord(schema) || typeof schema.safeParse !== 'function') return value
  const result = (schema.safeParse as (input: unknown) => unknown)(value)
  if (isRecord(result) && result.success === true) return result.data
  throw new Error(`${label} 契约校验失败：${formatIssues(isRecord(result) ? result.error : undefined)}`)
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (typeof value === 'object' || typeof value === 'function') && value !== null && typeof (value as { then?: unknown }).then === 'function'
}

function asInvokable(implementation: ExtensionImplementation): (...args: unknown[]) => unknown {
  return implementation as unknown as (...args: unknown[]) => unknown
}

/** Creates the four-mode extension-point scheduler. */
export function createExtensionPointRegistry(options: ExtensionPointRegistryOptions = {}): ExtensionPointRegistry {
  const logger = options.logger ?? console
  const onError = typeof options.onError === 'function'
    ? options.onError
    : (extensionPointId: string, error: unknown) => logger.warn?.(`[ep] ${extensionPointId} 的实现抛错（已跳过）：`, isRecord(error) ? error.message : error)
  const specs = new Map<string, ExtensionPointSpec>()
  const implementations = new Map<string, Map<string, ImplementationEntry>>()
  let sequence = 0

  const requireSpec = (extensionPointId: string): ExtensionPointSpec => {
    const id = String(extensionPointId || '').trim()
    const spec = specs.get(id)
    if (spec) return spec
    const known = Array.from(specs.keys())
    const hint = known.length
      ? `已声明的插槽：${known.slice(0, 8).join(', ')}${known.length > 8 ? ` …（共 ${known.length} 个）` : ''}`
      : '当前没有任何已声明的插槽'
    throw new Error(`扩展点未定义：${id || '(空)'}。${hint}`)
  }

  const define = (spec: ExtensionPointInput, meta: { pluginId?: string } = {}): ExtensionPointSpec => {
    const id = String(spec?.id || '').trim()
    if (!id) throw new Error('扩展点必须声明 id')
    const mode = String(spec?.mode || '').toUpperCase() as ExtensionMode
    if (!VALID_MODES.has(mode)) throw new Error(`扩展点 ${id} 的执行模式非法：${spec?.mode}（只能是 ${Array.from(VALID_MODES).join(' / ')}）`)
    const existing = specs.get(id)
    if (existing) {
      if (existing.mode !== mode) throw new Error(`扩展点 ${id} 重复声明且模式冲突：${existing.mode} / ${mode}`)
      return existing
    }
    const normalized: ExtensionPointSpec = {
      id,
      mode,
      description: spec.description ? String(spec.description) : '',
      owner: spec.owner ? String(spec.owner) : meta.pluginId ? String(meta.pluginId) : '',
      paramsSchema: spec.paramsSchema ?? null,
      resultSchema: spec.resultSchema ?? null,
      initialValue: spec.initialValue,
      hasInitialValue: Object.prototype.hasOwnProperty.call(spec, 'initialValue')
    }
    specs.set(id, normalized)
    implementations.set(id, new Map())
    return normalized
  }

  const isDefined = (extensionPointId: string): boolean => specs.has(String(extensionPointId || '').trim())
  const getSpec = (extensionPointId: string): ExtensionPointSpec | null => specs.get(String(extensionPointId || '').trim()) ?? null
  const listSpecs = (): ExtensionPointSummary[] => Array.from(specs.values()).map((spec) => ({
    id: spec.id,
    mode: spec.mode,
    description: spec.description,
    owner: spec.owner,
    implCount: implementations.get(spec.id)?.size ?? 0,
    hasParamsSchema: !!spec.paramsSchema,
    hasResultSchema: !!spec.resultSchema
  }))

  const implement = (extensionPointId: string, implementation: ExtensionImplementation, meta: ExtensionImplementationMeta = {}): string => {
    const spec = requireSpec(extensionPointId)
    if (typeof implementation !== 'function') throw new Error(`扩展点 ${spec.id} 的实现必须是函数`)
    const bucket = implementations.get(spec.id)
    if (!bucket) throw new Error(`扩展点 ${spec.id} 的实现桶不存在`)
    const key = String(meta.key || meta.pluginId || `anonymous#${++sequence}`)
    bucket.set(key, {
      impl: implementation,
      pluginId: meta.pluginId ? String(meta.pluginId) : null,
      order: Number.isFinite(meta.order) ? Number(meta.order) : 0,
      seq: ++sequence,
      key
    })
    return key
  }

  const implementAll = (entries: Array<{ to: string; impl: ExtensionImplementation; key?: string; order?: number }>, meta: Omit<ExtensionImplementationMeta, 'key' | 'order'> = {}): number => {
    let count = 0
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (!entry?.to || typeof entry.impl !== 'function') continue
      implement(entry.to, entry.impl, { ...meta, key: entry.key, order: entry.order })
      count += 1
    }
    return count
  }

  const removeImplementations = (pluginId: string): number => {
    const id = String(pluginId || '')
    if (!id) return 0
    let removed = 0
    for (const bucket of implementations.values()) {
      for (const [key, entry] of Array.from(bucket.entries())) {
        if (entry.pluginId === id) {
          bucket.delete(key)
          removed += 1
        }
      }
    }
    return removed
  }

  const countImplementations = (extensionPointId: string): number => implementations.get(String(extensionPointId || '').trim())?.size ?? 0
  const ordered = (extensionPointId: string): ImplementationEntry[] => {
    const bucket = implementations.get(extensionPointId)
    if (!bucket?.size) return []
    return Array.from(bucket.values()).sort((left, right) => (left.order - right.order) || (left.seq - right.seq))
  }
  const emptyResult = (spec: ExtensionPointSpec, payload: unknown): unknown => {
    if (spec.mode === EP_MODES.REDUCE) return spec.hasInitialValue ? spec.initialValue : payload
    if (spec.mode === EP_MODES.MULTI) return []
    return undefined
  }

  const run = (spec: ExtensionPointSpec, payload: unknown, context: ExtensionContext, allowAsync: boolean): unknown => {
    const validated = validateWith(spec.paramsSchema, payload, `扩展点 ${spec.id} 的入参`)
    const list = ordered(spec.id)
    if (!list.length) return emptyResult(spec, payload)

    const guard = (value: unknown, label: string): unknown => {
      if (!allowAsync && isThenable(value)) {
        const error = Object.assign(new Error(`扩展点 ${spec.id} 的${label}返回了 Promise，但当前调用是同步的（callSync）`), { code: SYNC_VIOLATION })
        throw error
      }
      return value
    }
    const reportError = (error: unknown, entry: ImplementationEntry): void => {
      if (isRecord(error) && error.code === SYNC_VIOLATION) throw error
      onError(spec.id, error, entry)
    }

    if (spec.mode === EP_MODES.EVENT) {
      for (const entry of list) {
        try { guard(asInvokable(entry.impl)(validated, context), '实现') } catch (error) { reportError(error, entry) }
      }
      return undefined
    }
    if (spec.mode === EP_MODES.SINGLE) {
      const entry = list[list.length - 1]
      return validateWith(spec.resultSchema, guard(asInvokable(entry.impl)(validated, context), '实现'), `扩展点 ${spec.id} 的返回`)
    }
    if (spec.mode === EP_MODES.MULTI) {
      const results: unknown[] = []
      for (const entry of list) {
        try { results.push(guard(asInvokable(entry.impl)(validated, context), '实现')) } catch (error) { reportError(error, entry) }
      }
      return spec.resultSchema ? results.map((result) => validateWith(spec.resultSchema, result, `扩展点 ${spec.id} 的返回`)) : results
    }

    let accumulator = spec.hasInitialValue ? spec.initialValue : validated
    for (const entry of list) {
      try {
        const next = guard(asInvokable(entry.impl)(accumulator, validated, context), '实现')
        if (next === undefined) {
          reportError(new Error('实现返回了 undefined，已保留上一步的值（REDUCE 的实现必须 return 下一个 acc）'), entry)
          continue
        }
        accumulator = next
      } catch (error) { reportError(error, entry) }
    }
    return validateWith(spec.resultSchema, accumulator, `扩展点 ${spec.id} 的返回`)
  }

  const callSync = <TResult = unknown>(extensionPointId: string, payload: unknown, context: ExtensionContext = {}): TResult =>
    run(requireSpec(extensionPointId), payload, context, false) as TResult

  const call = async <TResult = unknown>(extensionPointId: string, payload: unknown, context: ExtensionContext = {}): Promise<TResult> => {
    const spec = requireSpec(extensionPointId)
    const validated = validateWith(spec.paramsSchema, payload, `扩展点 ${spec.id} 的入参`)
    const list = ordered(spec.id)
    if (!list.length) return emptyResult(spec, payload) as TResult
    const reportError = (error: unknown, entry: ImplementationEntry): void => onError(spec.id, error, entry)

    if (spec.mode === EP_MODES.EVENT) {
      for (const entry of list) {
        try { await asInvokable(entry.impl)(validated, context) } catch (error) { reportError(error, entry) }
      }
      return undefined as TResult
    }
    if (spec.mode === EP_MODES.SINGLE) {
      const entry = list[list.length - 1]
      return validateWith(spec.resultSchema, await asInvokable(entry.impl)(validated, context), `扩展点 ${spec.id} 的返回`) as TResult
    }
    if (spec.mode === EP_MODES.MULTI) {
      const results: unknown[] = []
      for (const entry of list) {
        try { results.push(await asInvokable(entry.impl)(validated, context)) } catch (error) { reportError(error, entry) }
      }
      return (spec.resultSchema ? results.map((result) => validateWith(spec.resultSchema, result, `扩展点 ${spec.id} 的返回`)) : results) as TResult
    }

    let accumulator = spec.hasInitialValue ? spec.initialValue : validated
    for (const entry of list) {
      try {
        const next = await asInvokable(entry.impl)(accumulator, validated, context)
        if (next === undefined) {
          reportError(new Error('实现返回了 undefined，已保留上一步的值（REDUCE 的实现必须 return 下一个 acc）'), entry)
          continue
        }
        accumulator = next
      } catch (error) { reportError(error, entry) }
    }
    return validateWith(spec.resultSchema, accumulator, `扩展点 ${spec.id} 的返回`) as TResult
  }

  const callWithKeysSync = <TResult = unknown>(extensionPointId: string, payload: unknown, context: ExtensionContext = {}): Array<ExtensionPointEntry & { value: TResult }> => {
    const spec = requireSpec(extensionPointId)
    if (spec.mode !== EP_MODES.MULTI && spec.mode !== EP_MODES.SINGLE) {
      throw new Error(`扩展点 ${spec.id} 的模式是 ${spec.mode}，不支持按实现取值（只有 MULTI / SINGLE 的产物可寻址）`)
    }
    const validated = validateWith(spec.paramsSchema, payload, `扩展点 ${spec.id} 的入参`)
    const list = ordered(spec.id)
    const picked = spec.mode === EP_MODES.SINGLE ? list.slice(-1) : list
    const output: Array<ExtensionPointEntry & { value: TResult }> = []
    for (const entry of picked) {
      try {
        const value = asInvokable(entry.impl)(validated, context)
        if (isThenable(value)) {
          throw Object.assign(new Error(`扩展点 ${spec.id} 的实现返回了 Promise，但跨进程取值是同步的`), { code: SYNC_VIOLATION })
        }
        output.push({ key: entry.key, pluginId: entry.pluginId, order: entry.order, value: value as TResult })
      } catch (error) {
        if (isRecord(error) && error.code === SYNC_VIOLATION) throw error
        onError(spec.id, error, entry)
      }
    }
    return output
  }

  return {
    MODES: EP_MODES,
    define,
    isDefined,
    getSpec,
    listSpecs,
    implement,
    implementAll,
    removeImplementations,
    countImplementations,
    callSync,
    call,
    callWithKeysSync,
    reset: () => {
      specs.clear()
      implementations.clear()
      sequence = 0
    },
    get size() { return specs.size }
  }
}

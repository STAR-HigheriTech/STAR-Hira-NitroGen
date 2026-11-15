import { generateId } from '@hira-ng/shared-utils'
import { createClockStore } from './clock-store'
import { createTotpRepository } from './drizzle-totp-repository'
import { createOtpEngine } from './otp-engine'
import {
  EMPTY_CLOCK,
  errorMessage,
  normalizeClock,
  normalizeMetadata,
  normalizeSecret
} from './totp-normalizers'
import type {
  ClockCalibration,
  OtpEngine,
  TotpAddInput,
  TotpAddResult,
  TotpCalibrationResult,
  TotpChangeListener,
  TotpChangeReason,
  TotpCode,
  TotpCodeInput,
  TotpCodeSnapshot,
  TotpEntry,
  TotpExportResult,
  TotpImportInput,
  TotpImportResult,
  TotpMetadata,
  TotpRemoveResult,
  TotpRepository,
  TotpRow,
  TotpService,
  TotpServiceOptions,
  TotpUpdateInput,
  TotpUpdateResult
} from './types'

function toPublic(row: TotpRow | null | undefined): TotpEntry | null {
  if (!row) return null
  return {
    id: row.id,
    issuer: row.issuer,
    account: row.account,
    algorithm: row.algorithm,
    digits: row.digits,
    period: row.period,
    type: row.type,
    counter: row.counter,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  }
}

function dedupeKey(metadata: TotpMetadata): string {
  return [
    metadata.issuer,
    metadata.account,
    metadata.algorithm,
    metadata.digits,
    metadata.period,
    metadata.type
  ].join('\u0001')
}

export function createTotpService(
  db: unknown,
  options: TotpServiceOptions = {}
): TotpService {
  const now = () => Date.now()
  const engine: OtpEngine = createOtpEngine(options.crypto)
  const repository: TotpRepository = createTotpRepository(db as Parameters<typeof createTotpRepository>[0])
  const clockStore = createClockStore(options.kvDb)
  const profileIdPort = typeof options.getProfileId === 'function' ? options.getProfileId : null
  const measureTime = typeof options.measureTime === 'function' ? options.measureTime : null

  function currentProfile(): string {
    if (!profileIdPort) return 'default'
    try {
      const value = profileIdPort()
      return value ? String(value) : 'default'
    } catch {
      return 'default'
    }
  }

  const listeners = new Set<TotpChangeListener>()
  function emitChange(reason: TotpChangeReason, id: string | null = null): void {
    for (const listener of listeners) {
      try {
        listener({ reason, id })
      } catch (error) {
        console.error('[totp-service] change listener error:', errorMessage(error))
      }
    }
  }

  function subscribe(listener: TotpChangeListener): () => void {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }

  function listRows(): TotpRow[] {
    return repository.list(currentProfile())
  }

  function findRow(id: string): TotpRow | null {
    const key = String(id ?? '')
    return key ? repository.find(currentProfile(), key) : null
  }

  function insertEntry(metadata: TotpMetadata, rawSecret: unknown): TotpAddResult {
    if (!engine.isEncryptionAvailable()) {
      return { ok: false, reason: engine.encryptionFailureReason() }
    }
    const secret = normalizeSecret(rawSecret)
    if (!secret) return { ok: false, reason: '缺少密钥' }
    if (!engine.validate(metadata, secret)) {
      return { ok: false, reason: '密钥不是合法的 Base32（请检查是否复制完整）' }
    }
    const secretCipher = engine.encrypt(secret)
    if (!secretCipher) return { ok: false, reason: engine.encryptionFailureReason() }

    const timestamp = now()
    const row: TotpRow = {
      id: generateId(),
      profileId: currentProfile(),
      issuer: metadata.issuer,
      account: metadata.account,
      secretCipher,
      algorithm: metadata.algorithm,
      digits: metadata.digits,
      period: metadata.period,
      type: metadata.type,
      counter: metadata.counter,
      createdAt: timestamp,
      updatedAt: timestamp
    }
    repository.insert(row)
    return { ok: true, entry: toPublic(row) as TotpEntry }
  }

  function list(): TotpEntry[] {
    return listRows().map(toPublic).filter((entry): entry is TotpEntry => entry !== null)
  }

  function code(input: TotpCodeInput = {}): TotpCodeSnapshot {
    const onlyId = input.id ? String(input.id) : null
    const rows = onlyId ? [findRow(onlyId)].filter((row): row is TotpRow => row !== null) : listRows()
    const clock = clockStore.snapshot()
    const timestamp = now() + clock.offsetMs
    const codes: TotpCode[] = []
    const unavailable: string[] = []

    for (const row of rows) {
      const secret = engine.decrypt(row.secretCipher)
      if (!secret) {
        unavailable.push(row.id)
        continue
      }
      try {
        codes.push({ id: row.id, ...engine.generate(row, secret, timestamp) })
      } catch (error) {
        console.error(`[totp-service] 计算 ${row.id} 的验证码失败：`, errorMessage(error))
        unavailable.push(row.id)
      }
    }

    return { codes, now: timestamp, unavailable, clock }
  }

  async function calibrate(input: { reset?: boolean } = {}): Promise<TotpCalibrationResult> {
    if (input.reset) {
      clockStore.save({ ...EMPTY_CLOCK })
      emitChange('clock')
      return {
        ok: true,
        reset: true,
        offsetMs: 0,
        measuredAt: 0,
        source: null,
        rttMs: null
      }
    }
    if (!measureTime) return { ok: false, reason: '当前宿主未提供联网校时能力' }

    let measured: Awaited<ReturnType<NonNullable<typeof measureTime>>>
    try {
      measured = await measureTime()
    } catch (error) {
      return { ok: false, reason: errorMessage(error) || '联网校时失败' }
    }

    const normalized = normalizeClock(measured)
    if (!normalized) {
      return { ok: false, reason: '校时结果无效（时间源给出的偏移超出合理范围）' }
    }

    const saved = clockStore.save({
      ...normalized,
      measuredAt: normalized.measuredAt || now()
    })
    const rttMs = Number(measured?.rttMs)
    emitChange('clock')
    return {
      ok: true,
      offsetMs: saved.offsetMs,
      measuredAt: saved.measuredAt,
      source: saved.source,
      rttMs: Number.isFinite(rttMs) && rttMs >= 0 ? Math.round(rttMs) : null
    }
  }

  function add(input: TotpAddInput): TotpAddResult {
    const source = input && typeof input === 'object' ? input : {}
    return insertEntry(normalizeMetadata(source), source.secret)
  }

  function importUris(input: TotpImportInput = {}): TotpImportResult {
    const uris = Array.isArray(input.uris) ? input.uris : []
    const seen = new Set(listRows().map((row) => dedupeKey(normalizeMetadata(row))))
    const added: TotpEntry[] = []
    const skipped: TotpImportResult['skipped'] = []

    for (let index = 0; index < uris.length; index++) {
      const uri = String(uris[index] ?? '').trim()
      if (!uri) {
        skipped.push({ index, reason: '空条目' })
        continue
      }

      let parsed: ReturnType<OtpEngine['parseUri']>
      try {
        parsed = engine.parseUri(uri)
      } catch (error) {
        skipped.push({ index, reason: '不是有效的 otpauth 链接（' + errorMessage(error) + '）' })
        continue
      }

      const key = dedupeKey(parsed.metadata)
      if (seen.has(key)) {
        skipped.push({
          index,
          reason: '已存在同名条目（' + (parsed.metadata.issuer || '未命名') + '）'
        })
        continue
      }

      const result = insertEntry(parsed.metadata, parsed.secret)
      if (!result.ok) {
        skipped.push({ index, reason: result.reason })
        continue
      }
      seen.add(key)
      added.push(result.entry)
    }

    if (added.length) emitChange('import')
    return { ok: true, added, skipped }
  }

  function update(id: string, patch: TotpUpdateInput = {}): TotpUpdateResult {
    const row = findRow(id)
    if (!row) return { ok: false, reason: '条目不存在' }
    const source = patch && typeof patch === 'object' ? patch : {}
    const metadata = normalizeMetadata({
      issuer: 'issuer' in source ? source.issuer : row.issuer,
      account: 'account' in source ? source.account : row.account,
      algorithm: source.algorithm || row.algorithm,
      digits: source.digits == null ? row.digits : source.digits,
      period: source.period == null ? row.period : source.period,
      type: source.type || row.type,
      counter: source.counter == null ? row.counter : source.counter
    })

    let secretCipher = row.secretCipher
    if (source.secret != null && String(source.secret) !== '') {
      if (!engine.isEncryptionAvailable()) {
        return { ok: false, reason: engine.encryptionFailureReason() }
      }
      const secret = normalizeSecret(source.secret)
      if (!engine.validate(metadata, secret)) {
        return { ok: false, reason: '密钥不是合法的 Base32（请检查是否复制完整）' }
      }
      const encrypted = engine.encrypt(secret)
      if (!encrypted) return { ok: false, reason: engine.encryptionFailureReason() }
      secretCipher = encrypted
    }

    const updatedAt = now()
    repository.update(currentProfile(), row.id, {
      issuer: metadata.issuer,
      account: metadata.account,
      secretCipher,
      algorithm: metadata.algorithm,
      digits: metadata.digits,
      period: metadata.period,
      type: metadata.type,
      counter: metadata.counter,
      updatedAt
    })
    emitChange('update', row.id)
    return {
      ok: true,
      entry: toPublic({ ...row, ...metadata, secretCipher, updatedAt }) as TotpEntry
    }
  }

  function remove(id: string): TotpRemoveResult {
    const row = findRow(id)
    if (!row) return { ok: false, reason: '条目不存在' }
    repository.remove(currentProfile(), row.id)
    emitChange('remove', row.id)
    return { ok: true }
  }

  function exportUri(id: string): TotpExportResult {
    const row = findRow(id)
    if (!row) return { ok: false, reason: '条目不存在' }
    const secret = engine.decrypt(row.secretCipher)
    if (!secret) {
      return { ok: false, reason: '本机无法解出这条的密钥（可能来自另一台机器或数据损坏）' }
    }
    try {
      return { ok: true, uri: engine.exportUri(row, secret) }
    } catch {
      return { ok: false, reason: '无法生成导出链接（密钥格式不合法）' }
    }
  }

  return {
    list,
    code,
    calibrate,
    add,
    importUris,
    update,
    remove,
    exportUri,
    subscribe,
    isEncryptionAvailable: () => engine.isEncryptionAvailable()
  }
}

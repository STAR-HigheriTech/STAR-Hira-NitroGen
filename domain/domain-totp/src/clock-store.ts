import { kv } from '@hira-ng/infra-db/schema'
import { eq as drizzleEq } from 'drizzle-orm'
import { EMPTY_CLOCK, errorMessage, normalizeClock } from './totp-normalizers'
import type { ClockCalibration, ClockStore } from './types'

const CLOCK_KEY = 'totp.clock'
const eq = drizzleEq as unknown as (column: unknown, value: unknown) => unknown

type ReadQuery = {
  where(condition: unknown): ReadQuery
  get(): Record<string, unknown> | undefined
}

interface ClockDatabase {
  select(): { from(table: unknown): ReadQuery }
  insert(table: unknown): {
    values(value: Record<string, unknown>): {
      onConflictDoUpdate(config: {
        target: unknown
        set: Record<string, unknown>
      }): { run(): unknown }
    }
  }
}

function isClockDatabase(value: unknown): value is ClockDatabase {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<ClockDatabase>
  return typeof candidate.select === 'function' && typeof candidate.insert === 'function'
}

export function createClockStore(database: unknown): ClockStore {
  const db = isClockDatabase(database) ? database : null
  let clock: ClockCalibration = { ...EMPTY_CLOCK }
  let loaded = false

  function load(): ClockCalibration {
    if (loaded) return clock
    loaded = true
    if (!db) return clock
    try {
      const row = db.select().from(kv).where(eq(kv.key, CLOCK_KEY)).get()
      if (row?.value) {
        const parsed = normalizeClock(JSON.parse(String(row.value)))
        if (parsed) clock = parsed
      }
    } catch (error) {
      console.warn('[totp-service] 读取时钟校准失败（按未校准处理）：', errorMessage(error))
    }
    return clock
  }

  function save(value: unknown): ClockCalibration {
    clock = normalizeClock(value) || { ...EMPTY_CLOCK }
    loaded = true
    if (!db) return { ...clock }
    try {
      const serialized = JSON.stringify(clock)
      db.insert(kv).values({ key: CLOCK_KEY, value: serialized })
        .onConflictDoUpdate({ target: kv.key, set: { value: serialized } })
        .run()
    } catch (error) {
      console.error('[totp-service] 保存时钟校准失败（本次会话仍生效）：', errorMessage(error))
    }
    return { ...clock }
  }

  return {
    snapshot() {
      return { ...load() }
    },
    save
  }
}

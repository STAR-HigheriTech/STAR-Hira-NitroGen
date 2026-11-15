/**
 * settings/record-generators.ts —— 「record 型设置」的随机生成器注册表
 *
 * 设置页是纯 schema 渲染器：`type:'record'` 的字段只声明
 * `record.generate = '<生成器 id>'`，点「随机生成」时走通用 IPC
 * `settings:record-generate`。**生成逻辑住在主进程**，页面既不知道
 * 指纹长什么样，也不需要为第二种 record 设置改一行代码。
 *
 * 新增一种可随机生成的 record = 功能模块自己
 * `registerRecordGenerator(id, fn)`，设置 schema 里写同一个 id。
 */

const generators = new Map<string, () => unknown>()

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 登记一个生成器（同 id 后登记者生效：模块热替换时不必先注销）。
 * @param {string} id
 * @param {() => any} fn 返回可 JSON 序列化的值
 */
export function registerRecordGenerator(id: unknown, fn: unknown): void {
  const key = String(id || '').trim()
  if (!key || typeof fn !== 'function') return
  generators.set(key, fn as () => unknown)
}

/**
 * 注销（模块卸载 / 测试用）。
 * @param {string} id
 */
export function unregisterRecordGenerator(id: unknown): void {
  generators.delete(String(id || '').trim())
}

/**
 * 调用生成器。
 * @param {string} id
 * @returns {any} 未知生成器 → null（页面据此提示失败，而不是拿到半成品）
 */
export function generateRecord(id: unknown): unknown {
  const fn = generators.get(String(id || '').trim())
  if (!fn) return null
  try {
    return fn()
  } catch (e) {
    console.error(`[settings] record generator "${id}" failed:`, errorMessage(e))
    return null
  }
}

/** 已登记的生成器 id 清单（诊断用）。 */
export function listRecordGenerators(): string[] {
  return Array.from(generators.keys())
}


import { shouldSkipText } from '@hira-ng/shared-types/src/translate'
import type {
  TranslateAttributeName,
  TranslateDomPolicy
} from '@hira-ng/shared-types/src/translate-plugin'

const MAX_TARGETS = 5000
const MAX_BATCH_TEXTS = 96
const MAX_BATCH_CHARS = 3000
const MAIN_THREAD_SLICE_MS = 4
const MAX_AUTOMATIC_RETRIES = 5
const BATCH_CONCURRENCY = 2
const DEFAULT_SKIP_SELECTOR = [
  'script', 'style', 'noscript', 'textarea', 'input', 'select', 'option',
  'code', 'pre', 'kbd', 'samp', 'svg', 'canvas', 'iframe', 'video', 'audio', 'math',
  '[data-hira-ui="translate"]', '[aria-hidden="true"]', '[contenteditable="true"]', '[contenteditable=""]'
].join(',')
const DEFAULT_TRANSLATABLE_ATTRIBUTES = ['title', 'placeholder', 'aria-label', 'alt'] as const
const INLINE_CONTAINERS = new Set([
  'A', 'ABBR', 'B', 'BDI', 'BDO', 'CITE', 'DATA', 'DFN', 'EM', 'I', 'LABEL',
  'MARK', 'Q', 'S', 'SAMP', 'SMALL', 'SPAN', 'STRONG', 'SUB', 'SUP', 'TIME', 'U', 'VAR'
])
const VIEW_ROOT_TAGS = new Set([
  'ADDRESS', 'BLOCKQUOTE', 'BUTTON', 'DD', 'DETAILS', 'DIALOG',
  'DT', 'FIGCAPTION', 'FIGURE',
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LABEL', 'LI',
  'MENU', 'NAV', 'OL', 'P', 'SUMMARY', 'TD', 'TH', 'UL'
])
const VIEW_ROOT_SELECTOR = [...VIEW_ROOT_TAGS].map((tag) => tag.toLowerCase()).join(',')

interface Candidate {
  element: Element
  observerElement: Element
  kind: 'text' | 'attribute'
  node?: Text
  attribute?: TranslateAttributeName
  priority?: boolean
}

export interface DomTranslationProgress {
  translatedCount: number
  pendingCount: number
  targetCount: number
  scanning: boolean
  providerLabel: string
}

export interface DomTranslationSessionOptions {
  from: string
  to: string
  policy?: TranslateDomPolicy
  translateBatch: (texts: string[]) => Promise<{ texts: string[]; providerLabel?: string }>
  onProgress?: (progress: DomTranslationProgress) => void
  onError?: (error: Error) => void
}

export interface DomTranslationSession {
  start(): void
  pause(): void
  resume(): void
  restore(): void
  translatedCount(): number
}

function yieldToRender(): Promise<void> {
  return new Promise((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const finish = (): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve()
    }
    requestAnimationFrame(finish)
    timer = setTimeout(finish, 40)
  })
}

function yieldToIdle(): Promise<void> {
  return new Promise((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const finish = (): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve()
    }
    if ('requestIdleCallback' in window) {
      ;(window as Window & { requestIdleCallback(callback: () => void, options?: { timeout: number }): number })
        .requestIdleCallback(finish, { timeout: 240 })
    }
    timer = setTimeout(finish, 48)
  })
}

/**
 * 页面 DOM 翻译会话。
 *
 * 扫描、可见性观察、动态 DOM 跟踪和翻译队列都在这里闭环；宿主只提供翻译函数和状态回调。
 * 可见内容由 IntersectionObserver 优先入队，其余内容留在页面内等待进入预加载带。
 */
export function createDomTranslationSession(
  options: DomTranslationSessionOptions
): DomTranslationSession {
  const validExtraSelector = (selector: string): boolean => {
    try {
      document.createDocumentFragment().querySelector(selector)
      return true
    } catch (_) {
      return false
    }
  }
  const includeSelector = (options.policy?.includeSelectors || [])
    .filter((selector) => validExtraSelector(selector))
    .join(',')
  const skipSelector = [
    DEFAULT_SKIP_SELECTOR,
    ...(options.policy?.excludeSelectors || []).filter((selector) => validExtraSelector(selector))
  ].join(',')
  const allowedAttributes = new Set<TranslateAttributeName>(
    options.policy?.attributes?.length
      ? options.policy.attributes
      : DEFAULT_TRANSLATABLE_ATTRIBUTES
  )
  const translatableAttributes = [...allowedAttributes]
  let active = true
  let scanning = 0
  let targetCount = 0
  let providerLabel = ''
  let failureCount = 0
  let pumpRunning = false
  let pumpScheduled = false
  let scanScheduled = false
  let viewportScanTimer: ReturnType<typeof setTimeout> | null = null
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  const pending: Candidate[] = []
  const pendingSet = new Set<Candidate>()
  const resolved = new Set<Candidate>()
  const originals = new Map<Candidate, string>()
  const visibleElements = new Set<Element>()
  const observedElements = new Set<Element>()
  const mutationRoots = new Set<Node>()
  const scannedRoots = new WeakSet<Node>()
  const scanningRoots = new WeakSet<Node>()
  const incompleteRoots = new Set<Node>()
  const textCandidates = new WeakMap<Text, Candidate>()
  const attributeCandidates = new WeakMap<Element, Map<string, Candidate>>()
  const elementCandidates = new WeakMap<Element, Candidate[]>()
  const expectedText = new WeakMap<Text, string>()
  const expectedAttributes = new WeakMap<Element, Map<string, string>>()
  const scanQueue: Node[] = []
  const queuedScans = new Set<Node>()
  const priorityScans = new Set<Node>()
  const visibilityQueue: Candidate[] = []
  const visibilitySet = new Set<Candidate>()
  let visibilityPumpRunning = false

  const intersection = new IntersectionObserver((entries) => {
    if (!active) return
    for (const entry of entries) {
      const element = entry.target
      if (!entry.isIntersecting) {
        visibleElements.delete(element)
        continue
      }
      visibleElements.add(element)
      const rect = entry.boundingClientRect
      const onScreen = rect.bottom > 0 && rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth
      for (const candidate of elementCandidates.get(element) || []) {
        if (!visibilitySet.has(candidate)) {
          visibilitySet.add(candidate)
          visibilityQueue.push(candidate)
          candidate.priority = onScreen
        }
      }
    }
    void pumpVisibility()
  }, { rootMargin: '600px 0px 900px 0px', threshold: 0 })

  const mutations = new MutationObserver((records) => {
    if (!active) return
    for (const record of records) {
      if (record.type === 'childList') {
        for (const node of record.addedNodes) {
          if (node.isConnected) scheduleScan(node)
        }
        continue
      }
      if (record.type === 'characterData' && record.target.nodeType === Node.TEXT_NODE) {
        const node = record.target as Text
        const expected = expectedText.get(node)
        if (expected === (node.nodeValue || '')) {
          expectedText.delete(node)
          continue
        }
        expectedText.delete(node)
        const candidate = textCandidates.get(node)
        if (candidate) invalidate(candidate)
        else registerTextNode(node)
        continue
      }
      if (record.type === 'attributes' && record.target instanceof Element) {
        const attribute = record.attributeName as TranslateAttributeName | null
        if (!attribute || !allowedAttributes.has(attribute)) continue
        const expected = expectedAttributes.get(record.target)?.get(attribute)
        if (expected === (record.target.getAttribute(attribute) || '')) {
          expectedAttributes.get(record.target)?.delete(attribute)
          continue
        }
        expectedAttributes.get(record.target)?.delete(attribute)
        const candidate = attributeCandidates.get(record.target)?.get(attribute)
        if (candidate) invalidate(candidate)
        else registerAttribute(record.target, attribute)
      }
    }
  })

  function currentText(candidate: Candidate): string {
    if (candidate.kind === 'text') return candidate.node?.nodeValue || ''
    return candidate.attribute ? candidate.element.getAttribute(candidate.attribute) || '' : ''
  }

  function elementInScope(element: Element): boolean {
    try {
      if (element.closest(skipSelector)) return false
      return !includeSelector || Boolean(element.closest(includeSelector))
    } catch (_) {
      return true
    }
  }

  function observationElement(element: Element): Element {
    let current = element
    for (let depth = 0; depth < 3 && INLINE_CONTAINERS.has(current.tagName); depth += 1) {
      const parent = current.parentElement
      if (!parent || parent === document.body) break
      current = parent
    }
    return current
  }

  function candidateEligible(candidate: Candidate): boolean {
    if (!candidate.element.isConnected) return false
    return !shouldSkipText(currentText(candidate), options.to, options.from)
  }

  function registerCandidate(candidate: Candidate): void {
    let list = elementCandidates.get(candidate.observerElement)
    if (!list) {
      list = []
      elementCandidates.set(candidate.observerElement, list)
      observedElements.add(candidate.observerElement)
      if (active) intersection.observe(candidate.observerElement)
    }
    list.push(candidate)
    targetCount += 1
  }

  function registerTextNode(node: Text, priority = false): void {
    if (targetCount >= MAX_TARGETS || textCandidates.has(node)) return
    const element = node.parentElement
    if (!element || !elementInScope(element)) return
    if (shouldSkipText(node.nodeValue || '', options.to, options.from)) return
    const candidate: Candidate = { element, observerElement: observationElement(element), kind: 'text', node }
    textCandidates.set(node, candidate)
    registerCandidate(candidate)
    if (priority || visibleElements.has(candidate.observerElement)) enqueue(candidate, priority)
  }

  function registerAttribute(element: Element, attribute: TranslateAttributeName, priority = false): void {
    if (targetCount >= MAX_TARGETS || !elementInScope(element)) return
    const value = element.getAttribute(attribute) || ''
    if (!value || shouldSkipText(value, options.to, options.from)) return
    let map = attributeCandidates.get(element)
    if (!map) {
      map = new Map()
      attributeCandidates.set(element, map)
    }
    if (map.has(attribute)) return
    const candidate: Candidate = { element, observerElement: observationElement(element), kind: 'attribute', attribute }
    map.set(attribute, candidate)
    registerCandidate(candidate)
    if (priority || visibleElements.has(candidate.observerElement)) enqueue(candidate, priority)
  }

  function enqueue(candidate: Candidate, priority = false): void {
    if (!active || resolved.has(candidate) || pendingSet.has(candidate) || !candidateEligible(candidate)) return
    if (priority) pending.unshift(candidate)
    else pending.push(candidate)
    pendingSet.add(candidate)
    schedulePump()
  }

  async function pumpVisibility(): Promise<void> {
    if (visibilityPumpRunning) return
    visibilityPumpRunning = true
    try {
      while (active && visibilityQueue.length) {
        const sliceStart = performance.now()
        while (visibilityQueue.length && performance.now() - sliceStart < MAIN_THREAD_SLICE_MS) {
          const candidate = visibilityQueue.shift()!
          visibilitySet.delete(candidate)
          const priority = candidate.priority === true
          delete candidate.priority
          enqueue(candidate, priority)
        }
        if (visibilityQueue.length) await yieldToRender()
      }
    } finally {
      visibilityPumpRunning = false
      if (active && visibilityQueue.length) void pumpVisibility()
    }
  }

  function invalidate(candidate: Candidate): void {
    originals.delete(candidate)
    resolved.delete(candidate)
    if (visibleElements.has(candidate.observerElement)) enqueue(candidate)
    emitProgress()
  }

  function schedulePump(delay = 0): void {
    if (!active || pumpRunning || pumpScheduled || retryTimer || failureCount >= MAX_AUTOMATIC_RETRIES) return
    pumpScheduled = true
    const run = (): void => {
      pumpScheduled = false
      void pump()
    }
    if (delay > 0) retryTimer = setTimeout(() => {
      retryTimer = null
      run()
    }, delay)
    else setTimeout(run, 0)
  }

  function takeBatch(): Candidate[] {
    const batch: Candidate[] = []
    let chars = 0
    while (pending.length) {
      const candidate = pending.shift()!
      pendingSet.delete(candidate)
      if (resolved.has(candidate) || !candidateEligible(candidate)) continue
      const text = currentText(candidate)
      if (batch.length > 0 && (batch.length >= MAX_BATCH_TEXTS || chars + text.length > MAX_BATCH_CHARS)) {
        pending.unshift(candidate)
        pendingSet.add(candidate)
        break
      }
      batch.push(candidate)
      chars += text.length
      if (batch.length >= MAX_BATCH_TEXTS) break
    }
    return batch
  }

  function applyTranslation(candidate: Candidate, translated: string): void {
    if (!active || !translated || !candidate.element.isConnected) return
    const current = currentText(candidate)
    const next = candidate.kind === 'text'
      ? `${current.match(/^\s*/)?.[0] || ''}${translated.trim()}${current.match(/\s*$/)?.[0] || ''}`
      : translated
    if (!next || next === current) {
      resolved.add(candidate)
      return
    }
    if (!originals.has(candidate)) originals.set(candidate, current)
    if (candidate.kind === 'text' && candidate.node) {
      expectedText.set(candidate.node, next)
      candidate.node.nodeValue = next
    } else if (candidate.attribute) {
      let expected = expectedAttributes.get(candidate.element)
      if (!expected) {
        expected = new Map()
        expectedAttributes.set(candidate.element, expected)
      }
      expected.set(candidate.attribute, next)
      candidate.element.setAttribute(candidate.attribute, next)
    }
    resolved.add(candidate)
  }

  async function pumpWorker(): Promise<void> {
    while (active) {
      await yieldToRender()
      const batch = takeBatch()
      if (!batch.length) return
      const texts = batch.map(currentText)
      try {
        const response = await options.translateBatch(texts)
        if (!active) {
          for (const candidate of batch) {
            if (!pendingSet.has(candidate)) {
              pending.unshift(candidate)
              pendingSet.add(candidate)
            }
          }
          return
        }
        if (!Array.isArray(response.texts) || response.texts.length !== batch.length) {
          throw new Error('翻译结果数量不一致')
        }
        let writeSlice = performance.now()
        for (let index = 0; index < response.texts.length; index += 1) {
          applyTranslation(batch[index], String(response.texts[index] || ''))
          if (performance.now() - writeSlice >= MAIN_THREAD_SLICE_MS) {
            await yieldToRender()
            writeSlice = performance.now()
          }
        }
        if (response.providerLabel) providerLabel = response.providerLabel
        failureCount = 0
        emitProgress()
      } catch (error) {
        for (const candidate of batch) {
          if (!pendingSet.has(candidate)) {
            pending.unshift(candidate)
            pendingSet.add(candidate)
          }
        }
        failureCount += 1
        const failure = error instanceof Error ? error : new Error(String(error))
        options.onError?.(failureCount >= MAX_AUTOMATIC_RETRIES
          ? new Error(`${failure.message}（自动重试已暂停）`)
          : failure)
        if (failureCount < MAX_AUTOMATIC_RETRIES) {
          schedulePump(Math.min(15_000, 1_500 * 2 ** (failureCount - 1)))
        }
        return
      }
    }
  }

  async function pump(): Promise<void> {
    if (pumpRunning) return
    pumpRunning = true
    try {
      await Promise.all(Array.from({ length: BATCH_CONCURRENCY }, () => pumpWorker()))
    } finally {
      pumpRunning = false
      if (active && pending.length && !retryTimer) schedulePump()
    }
  }

  function emitProgress(): void {
    if (!active) return
    options.onProgress?.({
      translatedCount: originals.size,
      pendingCount: pending.length,
      targetCount,
      scanning: scanning > 0 || scanQueue.length > 0,
      providerLabel
    })
  }

  function observeMutationRoot(root: Node): void {
    if (mutationRoots.has(root)) return
    mutationRoots.add(root)
    if (active) {
      mutations.observe(root, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: translatableAttributes
      })
    }
  }

  function scheduleScan(root: Node, priority = false): void {
    if (!active || root.parentElement?.closest('[data-hira-ui="translate"]')) return
    if (priority) priorityScans.add(root)
    if (!queuedScans.has(root)) {
      queuedScans.add(root)
      scanQueue.push(root)
    }
    scheduleScanDrain()
  }

  function collectViewportRoots(): Node[] {
    const roots = new Set<Node>()
    for (const y of [0.1, 0.3, 0.5, 0.7, 0.9]) {
      for (const x of [0.15, 0.5, 0.85]) {
        const element = document.elementFromPoint(
          Math.max(1, window.innerWidth * x),
          Math.max(1, window.innerHeight * y)
        )
        if (!element || element.closest('[data-hira-ui="translate"]') || element === document.body) continue
        let root = element.closest(VIEW_ROOT_SELECTOR) || element
        if (root.tagName === 'LI') {
          root = root.parentElement?.closest('MENU,NAV,OL,UL') || root
        }
        roots.add(root)
      }
    }
    return [...roots]
  }

  function scheduleViewportScan(): void {
    if (!active || viewportScanTimer) return
    viewportScanTimer = setTimeout(() => {
      viewportScanTimer = null
      for (const root of collectViewportRoots()) scheduleScan(root, true)
    }, 140)
  }

  function scheduleScanDrain(): void {
    if (scanScheduled) return
    scanScheduled = true
    setTimeout(() => {
      scanScheduled = false
      void drainScans()
    }, 0)
  }

  async function drainScans(): Promise<void> {
    while (active && scanQueue.length && targetCount < MAX_TARGETS) {
      const root = scanQueue.shift()!
      queuedScans.delete(root)
      const priority = priorityScans.delete(root)
      await scanTree(root, 0, priority)
    }
    emitProgress()
  }

  async function scanTree(scope: Node, depth: number, priority = false): Promise<void> {
    if (!active || depth > 8 || scannedRoots.has(scope) || scanningRoots.has(scope)) return
    scanningRoots.add(scope)
    scanning += 1
    let completed = false
    try {
      if (scope.nodeType === Node.TEXT_NODE) {
        registerTextNode(scope as Text, priority)
        scannedRoots.add(scope)
        completed = true
        return
      }
      if (scope instanceof Element && scope.shadowRoot) {
        observeMutationRoot(scope.shadowRoot)
        await scanTree(scope.shadowRoot, depth + 1, priority)
      }
      const walker = document.createTreeWalker(scope, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT)
      let node = walker.nextNode()
      while (node && active && targetCount < MAX_TARGETS) {
        const sliceStart = performance.now()
        while (node && active && targetCount < MAX_TARGETS &&
          performance.now() - sliceStart < MAIN_THREAD_SLICE_MS) {
          if (node.nodeType === Node.TEXT_NODE) {
            registerTextNode(node as Text, priority)
          } else {
            const element = node as Element
            if (element.shadowRoot) {
              observeMutationRoot(element.shadowRoot)
              await scanTree(element.shadowRoot, depth + 1, priority)
            }
            for (const attribute of translatableAttributes) {
              const value = element.getAttribute(attribute)
              if (value) registerAttribute(element, attribute, priority)
            }
          }
          node = walker.nextNode()
        }
        if (node && active && targetCount < MAX_TARGETS) {
          if (priority) await yieldToRender()
          else await yieldToIdle()
        }
      }
      completed = !node && (active || targetCount >= MAX_TARGETS)
      if (completed) {
        scannedRoots.add(scope)
        incompleteRoots.delete(scope)
      }
    } finally {
      scanningRoots.delete(scope)
      if (!completed) incompleteRoots.add(scope)
      scanning -= 1
    }
  }

  function observeAll(): void {
    for (const element of observedElements) intersection.observe(element)
    for (const root of mutationRoots) {
      mutations.observe(root, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: translatableAttributes
      })
    }
  }

  function pause(): void {
    if (!active) return
    active = false
    intersection.disconnect()
    mutations.disconnect()
    document.removeEventListener('scroll', scheduleViewportScan, true)
    if (viewportScanTimer) {
      clearTimeout(viewportScanTimer)
      viewportScanTimer = null
    }
    if (retryTimer) {
      clearTimeout(retryTimer)
      retryTimer = null
    }
  }

  return {
    start(): void {
      if (!active || !document.body) return
      observeMutationRoot(document.body)
      document.addEventListener('scroll', scheduleViewportScan, { capture: true, passive: true })
      for (const root of collectViewportRoots()) scheduleScan(root, true)
    },
    pause,
    resume(): void {
      if (active) {
        for (const element of visibleElements) {
          for (const candidate of elementCandidates.get(element) || []) enqueue(candidate)
        }
        return
      }
      active = true
      failureCount = 0
      observeAll()
      document.addEventListener('scroll', scheduleViewportScan, { capture: true, passive: true })
      for (const root of incompleteRoots) scheduleScan(root, true)
      for (const root of collectViewportRoots()) scheduleScan(root, true)
      if (scanQueue.length) scheduleScanDrain()
      schedulePump()
    },
    restore(): void {
      const wasActive = active
      active = false
      intersection.disconnect()
      mutations.disconnect()
      document.removeEventListener('scroll', scheduleViewportScan, true)
      if (viewportScanTimer) {
        clearTimeout(viewportScanTimer)
        viewportScanTimer = null
      }
      if (retryTimer) {
        clearTimeout(retryTimer)
        retryTimer = null
      }
      for (const [candidate, original] of originals) {
        if (!candidate.element.isConnected) continue
        if (candidate.kind === 'text' && candidate.node) {
          expectedText.set(candidate.node, original)
          candidate.node.nodeValue = original
        } else if (candidate.attribute) {
          let expected = expectedAttributes.get(candidate.element)
          if (!expected) {
            expected = new Map()
            expectedAttributes.set(candidate.element, expected)
          }
          expected.set(candidate.attribute, original)
          candidate.element.setAttribute(candidate.attribute, original)
        }
      }
      originals.clear()
      pending.length = 0
      pendingSet.clear()
      resolved.clear()
      if (wasActive) emitProgress()
    },
    translatedCount(): number {
      return originals.size
    }
  }
}

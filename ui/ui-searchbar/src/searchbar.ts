import { parseBangQueryEntry } from '@hira-ng/shared-types/src/commands.mjs'
import { defaultSearchUrl } from '@hira-ng/shared-types/src/search-engines.mjs'
import { resolveSuggestionAnchor } from './anchor'
import { resolveVerbatimTarget, suggestionToUrl } from './core/navigation'
import { createPhaseGate } from './core/phase-gate'
import {
  mergeSuggestions,
  sameSuggestionList,
  selectionKey
} from './core/ranking'
import { createSuggestorRegistry } from './core/registry'
import { collectSuggestions, partitionSuggestors } from './core/suggestor-runner'
import { suggestionField } from './core/suggestion-field'
import { bangsSuggestor } from './suggestors/bangs'
import { calcSuggestor } from './suggestors/calc'
import { developmentModeSuggestor } from './suggestors/development-mode'
import { instantAnswerSuggestor } from './suggestors/instant-answer'
import { openTabsSuggestor } from './suggestors/open-tabs'
import { pedalSuggestor } from './suggestors/pedals'
import { remoteSuggestor } from './suggestors/remote'
import { verbatimSuggestor } from './suggestors/verbatim'
import type {
  CustomBangInfo,
  HideSearchbarOptions,
  SearchBarController,
  SearchBarOptions,
  SearchSettings,
  SearchbarOverlayAdapter,
  SuggestorContext,
  Suggestor,
  Suggestion,
  SuggestionAnchor
} from './types'

const IME_BLUR_GRACE_MS = 1200
const RELEASE_FOCUS_DELAY_MS = 300
const RECLAIM_WINDOW_MS = 200
const OVERLAY_STEAL_BLUR_GRACE_MS = 120
const BLUR_SUPPRESS_MS = 150
const WINDOW_REFOCUS_GRACE_MS = 200
const SLOW_DEBOUNCE_MS = 120

export const ADDRESS_BAR_SHORTCUTS: Readonly<{ pasteAndGo: string }> = Object.freeze({
  pasteAndGo: 'CommandOrControl+Shift+V'
})

export function createSearchBar(input: HTMLInputElement, opts: SearchBarOptions): SearchBarController {
  const builtinSuggestors: Suggestor[] = [
    verbatimSuggestor,
    calcSuggestor,
    bangsSuggestor,
    openTabsSuggestor,
    pedalSuggestor,
    remoteSuggestor,
    instantAnswerSuggestor,
    developmentModeSuggestor
  ]
  const registry = createSuggestorRegistry([...builtinSuggestors, ...(opts.suggestors || [])])
  const phaseGate = createPhaseGate()

  let currentSuggestions: Suggestion[] = []
  let selectedIndex = -1
  let keyboardSelected = false
  let requestSeq = 0
  let suppressFocusSuggestions = false
  let blurHideTimer: ReturnType<typeof setTimeout> | null = null
  let lastBlurAt = 0
  let overlayShown = false
  let blurIgnoreUntil = 0
  let composing = false
  let lastCompositionEndAt = 0
  /** 组合开始前的稳定值，用于识别浏览器在失焦时把输入回滚到空串。 */
  let compositionBeforeValue = ''
  /** IME 组合过程中的完整输入快照（通常就是用户看到的拼音字母）。 */
  let compositionDraft = ''
  /** 最近一次 compositionupdate 的原始数据；某些 IME 不把它写进 input.value。 */
  let compositionData = ''
  /** 用户主动按 Esc 取消组合时，不再把未上屏字母恢复回来。 */
  let compositionCanceled = false
  /** 失焦后仍需保护的 IME 草稿；直到用户重新编辑或显式导航才释放。 */
  let interruptedDraft = ''
  let interruptedBaseline = ''
  let interruptedRestoreTimers: Array<ReturnType<typeof setTimeout>> = []
  let pendingReleaseTimer: ReturnType<typeof setTimeout> | null = null
  let windowRefocusedAt = 0
  let disposed = false
  let anchorCache: SuggestionAnchor | null = null
  let anchorObserver: ResizeObserver | null = null
  let arrowOriginalValue = ''
  let arrowSaved = false

  function flag(name: keyof SearchSettings, fallback: boolean): boolean {
    try {
      const value = opts.searchSettings?.[name]
      if (typeof value === 'boolean') return value
    } catch {
      // A live setting getter may be temporarily unavailable during profile changes.
    }
    return fallback
  }

  const suggestionsEnabled = (): boolean => flag('suggestionsEnabled', true)
  const bangsEnabled = (): boolean => flag('bangsEnabled', true)

  function searchUrl(query: string): string {
    try {
      const url = opts.getSearchUrl?.(query)
      if (typeof url === 'string' && url) return url
    } catch {
      // Fall back to the canonical engine shipped with shared-types.
    }
    return defaultSearchUrl(query)
  }

  function getAnchorRect(): SuggestionAnchor {
    if (anchorCache) return anchorCache
    const rect = input.getBoundingClientRect()
    const styles = getComputedStyle(input)
    const readPx = (name: string, fallback: number): number => {
      const value = parseFloat(styles.getPropertyValue(name))
      return Number.isFinite(value) && value > 0 ? value : fallback
    }
    const sideHost = input.closest('[data-host-axis="column"]') as HTMLElement | null
    let sideHostRect: DOMRect | null = null
    try {
      sideHostRect = sideHost?.getBoundingClientRect() || null
    } catch {
      sideHostRect = null
    }
    anchorCache = resolveSuggestionAnchor({
      rect,
      viewportWidth: window.innerWidth || 0,
      maxWidth: readPx('--ng-omnibox-max-width', 720),
      sideWidth: readPx('--ng-omnibox-side-dropdown-width', 600),
      sideHostRect
    })
    return anchorCache
  }

  function invalidateAnchor(): void {
    anchorCache = null
  }

  function render(): void {
    if (currentSuggestions.length === 0) {
      hidePassive()
      return
    }
    const activeOverlay: SearchbarOverlayAdapter | undefined = opts.overlay
    if (!activeOverlay || typeof activeOverlay.showSearchbar !== 'function') return

    if (!overlayShown) {
      blurIgnoreUntil = Date.now() + BLUR_SUPPRESS_MS
      overlayShown = true
    }
    try {
      activeOverlay.showSearchbar({
        anchor: getAnchorRect(),
        suggestions: currentSuggestions,
        selectedIndex,
        query: input.value
      })
    } catch {
      overlayShown = false
    }
  }

  function currentPreserveKey(): string {
    if (!keyboardSelected || selectedIndex < 0) return ''
    return selectionKey(currentSuggestions[selectedIndex])
  }

  function applySuggestions(next: Suggestion[], preserveKey: string): void {
    const unchanged = sameSuggestionList(currentSuggestions, next)
    currentSuggestions = next
    if (next.length === 0) {
      selectedIndex = -1
      hidePassive()
      return
    }
    if (unchanged) return
    if (!keyboardSelected) {
      selectedIndex = -1
    } else {
      const preservedIndex = preserveKey
        ? next.findIndex((suggestion) => selectionKey(suggestion) === preserveKey)
        : -1
      selectedIndex = preservedIndex >= 0 ? preservedIndex : Math.min(selectedIndex, next.length - 1)
    }
    render()
  }

  async function requestSuggestions(options?: { immediate?: boolean }): Promise<void> {
    if (disposed) return
    const query = input.value
    const seq = ++requestSeq
    arrowSaved = false
    keyboardSelected = false

    if (!suggestionsEnabled()) {
      phaseGate.cancel()
      currentSuggestions = []
      selectedIndex = -1
      hidePassive()
      return
    }

    const context: SuggestorContext = {
      query,
      getOpenTabs: opts.getOpenTabs,
      getRemoteSuggestions: opts.getRemoteSuggestions,
      getEngines: opts.getEngines,
      getCustomBangs: opts.getCustomBangs,
      getPanels: opts.getPanels,
      isDevelopmentMode: opts.isDevelopmentMode,
      getInstantAnswers: opts.getInstantAnswers,
      getDefaultEngine: opts.getDefaultEngine,
      searchUrl,
      navigate: (url) => opts.onCommit(url, false),
      openUrl: (url, newTab) => opts.onCommit(url, newTab)
    }

    const { fast, slow } = partitionSuggestors(
      registry.snapshot(),
      (suggestor) => suggestor !== bangsSuggestor || bangsEnabled()
    )
    const fastResults = await collectSuggestions(fast, context)
    if (seq !== requestSeq) return
    if (fastResults.length > 0) {
      applySuggestions(mergeSuggestions([fastResults], query), currentPreserveKey())
    }

    if (slow.length === 0) {
      if (fastResults.length === 0) applySuggestions([], '')
      return
    }

    if (options?.immediate) phaseGate.cancel()
    else if (!(await phaseGate.wait(SLOW_DEBOUNCE_MS))) return
    if (seq !== requestSeq) return

    const slowResults = await collectSuggestions(slow, context)
    if (seq !== requestSeq) return
    applySuggestions(mergeSuggestions([fastResults, slowResults], query), currentPreserveKey())
  }

  function recordBangUse(suggestion: Suggestion | undefined): void {
    const bangId = suggestionField(suggestion, 'bangId')
    if (!bangId || typeof opts.onBangUsed !== 'function') return
    try {
      opts.onBangUsed(bangId)
    } catch {
      // Usage accounting must never block navigation.
    }
  }

  function recordSearch(suggestion: Suggestion | undefined): void {
    if (!suggestion || (suggestion.type !== 'search' && suggestion.type !== 'search-history')) return
    const query = suggestionField(suggestion, 'query').trim()
    if (!query || typeof opts.onSearch !== 'function') return
    try {
      opts.onSearch(query)
    } catch {
      // Search history is best-effort.
    }
  }

  function commit(suggestion: Suggestion): void {
    clearInterruptedDraft()
    if (suggestion.type === 'pedal') {
      opts.onAction(suggestionField(suggestion, 'action'))
      hide()
      return
    }
    if (suggestion.type === 'open-tab') {
      const tabId = suggestionField(suggestion, 'tabId')
      if (tabId && typeof opts.onActivateTab === 'function') {
        opts.onActivateTab(tabId)
        hide()
        return
      }
    }
    const url = suggestionToUrl(suggestion, searchUrl)
    if (!url) return
    clearInterruptedDraft()
    recordBangUse(suggestion)
    recordSearch(suggestion)
    opts.onCommit(url, false)
    hide()
  }

  function commitVerbatim(raw: string): boolean {
    const query = String(raw ?? '').trim()
    if (!query) return false
    clearInterruptedDraft()

    if (bangsEnabled()) {
      let engines: Record<string, string> | undefined
      let customBangs: CustomBangInfo[] | undefined
      try {
        engines = opts.getEngines?.()
      } catch {
        engines = undefined
      }
      try {
        customBangs = opts.getCustomBangs?.()
      } catch {
        customBangs = undefined
      }
      const entry = parseBangQueryEntry(query, engines ?? {}, customBangs ?? [])
      if (entry && typeof entry.url === 'string' && entry.url) {
        if (entry.custom && typeof entry.id === 'string' && entry.id) {
          try {
            opts.onBangUsed?.(entry.id)
          } catch {
            // Usage accounting is non-critical.
          }
        }
        opts.onCommit(entry.url, false)
        hide()
        return true
      }
    }

    const target = resolveVerbatimTarget(query, searchUrl)
    if (!target) return false
    if (target.kind === 'search') {
      try {
        opts.onSearch?.(target.query)
      } catch {
        // Search history is best-effort.
      }
    }
    opts.onCommit(target.url, false)
    hide()
    return true
  }

  function commitFirstOrVerbatim(): void {
    const suggestion = selectedIndex >= 0 ? currentSuggestions[selectedIndex] : undefined
    if (suggestion) commit(suggestion)
    else commitVerbatim(input.value)
  }

  function restoreArrowPreview(): void {
    if (!arrowSaved) return
    arrowSaved = false
    if (input.value === arrowOriginalValue) return
    input.value = arrowOriginalValue
    try {
      input.setSelectionRange(arrowOriginalValue.length, arrowOriginalValue.length)
    } catch {
      // Some input states do not expose a text selection.
    }
  }

  function hide(options?: HideSearchbarOptions): void {
    requestSeq += 1
    overlayShown = false
    phaseGate.cancel()
    restoreArrowPreview()
    try {
      opts.overlay?.hideSearchbar?.(options)
    } catch {
      // Overlay teardown cannot break the omnibox state machine.
    }
    currentSuggestions = []
    selectedIndex = -1
    keyboardSelected = false
  }

  function hidePassive(): void {
    hide({ keepFocus: true })
  }

  function saveArrowOriginal(): void {
    if (arrowSaved) return
    arrowSaved = true
    arrowOriginalValue = input.value
  }

  function applyArrowPreview(): void {
    const suggestion = currentSuggestions[selectedIndex]
    const preview = suggestionField(suggestion, 'query') || arrowOriginalValue
    if (!arrowSaved || preview === input.value) return
    input.value = preview
    try {
      input.setSelectionRange(preview.length, preview.length)
    } catch {
      // Programmatic selection is optional.
    }
  }

  function clearInterruptedDraft(): void {
    for (const timer of interruptedRestoreTimers) clearTimeout(timer)
    interruptedRestoreTimers = []
    interruptedDraft = ''
    interruptedBaseline = ''
  }

  function shouldRestoreInterruptedDraft(): boolean {
    if (!interruptedDraft || compositionCanceled) return false
    const current = input.value
    if (current === interruptedDraft) return false
    return current === '' ||
      current === interruptedBaseline ||
      (current.length < interruptedDraft.length && interruptedDraft.startsWith(current))
  }

  function restoreInterruptedDraftOnce(): void {
    if (compositionCanceled) {
      clearInterruptedDraft()
      return
    }
    if (!interruptedDraft) return
    if (input.value === interruptedDraft) return
    if (shouldRestoreInterruptedDraft()) {
      input.value = interruptedDraft
      try { input.setSelectionRange(interruptedDraft.length, interruptedDraft.length) } catch (_) {}
      return
    }
    // 已经有另一段有效内容（例如 IME 已成功上屏中文）：解除保护，绝不覆盖。
    if (input.value) clearInterruptedDraft()
  }

  function rememberInterruptedDraft(draft: string, baseline: string): void {
    if (!draft || draft === baseline || compositionCanceled) return
    interruptedDraft = draft
    interruptedBaseline = baseline
    for (const timer of interruptedRestoreTimers) clearTimeout(timer)
    // IME 的取消 / 回滚可能跨越多个原生事件与渲染帧；多点重申，避免只救回一帧。
    interruptedRestoreTimers = [0, 16, 50, 120, 260, 500, 900].map((delay) =>
      setTimeout(restoreInterruptedDraftOnce, delay)
    )
  }

  function restoreCompositionDraft(): void {
    const current = input.value
    const draft = compositionDraft
    const baseline = compositionBeforeValue
    if (!draft || draft === baseline) return
    if (compositionCanceled) {
      clearInterruptedDraft()
      return
    }
    // 浏览器 / IME 在焦点被关闭时可能把输入回滚成空串或组合开始前的值。
    // Edge 等主流浏览器的行为是保留用户已经敲下的字母，而不是整段消失。
    const reverted = current === baseline
    const truncated = current.length < draft.length && draft.startsWith(current)
    rememberInterruptedDraft(draft, baseline)
    if (current === '' || reverted || truncated) {
      input.value = draft
      try { input.setSelectionRange(draft.length, draft.length) } catch (_) {}
    }
  }

  const onCompositionStart = (): void => {
    // 新一轮组合代表用户已继续编辑；上一轮的保护草稿到此完成使命。
    clearInterruptedDraft()
    composing = true
    compositionBeforeValue = input.value
    compositionDraft = input.value
    compositionData = ''
    compositionCanceled = false
  }

  const onCompositionUpdate = (event: CompositionEvent): void => {
    if (!composing) composing = true
    if (event.data) compositionData = event.data
    const current = input.value
    // 有的 IME 把 preedit 写进 input.value；有的完全不写。两种都要能恢复：
    // 前者保留完整 value，后者把 compositionupdate.data 拼在组合前文本之后。
    if (current && current !== compositionBeforeValue) compositionDraft = current
    else if (compositionData) compositionDraft = compositionBeforeValue + compositionData
  }

  const onCompositionEnd = (event: CompositionEvent): void => {
    // compositionend 在部分 IME + 失焦组合下会先把 value 清空。先恢复草稿，
    // 再退出 composing，避免紧随其后的 setQuery / hide 读到空值。
    if (!compositionData && event.data) compositionData = event.data
    if (compositionData && (!compositionDraft || compositionDraft === compositionBeforeValue)) {
      compositionDraft = compositionBeforeValue + compositionData
    }
    restoreCompositionDraft()
    composing = false
    lastCompositionEndAt = Date.now()
    compositionBeforeValue = ''
    compositionDraft = ''
    compositionData = ''
    compositionCanceled = false
    if (!suppressFocusSuggestions) void requestSuggestions()
  }

  const onInput = (): void => {
    if (composing) {
      const current = input.value
      if (current && current !== compositionBeforeValue) compositionDraft = current
      else if (compositionData) compositionDraft = compositionBeforeValue + compositionData
      return
    }
    // 非空的新值说明用户已经重新编辑或 IME 成功上屏；旧保护草稿不能覆盖它。
    if (interruptedDraft && input.value && input.value !== interruptedDraft && input.value !== interruptedBaseline) {
      clearInterruptedDraft()
    }
    void requestSuggestions()
  }

  const onKeyDown = (event: KeyboardEvent): void => {
    if (composing || event.isComposing || event.keyCode === 229) {
      // Esc 是 IME 的“取消当前组合”，这与失焦丢值不同：用户明确不要这串字母。
      if (event.key === 'Escape') compositionCanceled = true
      return
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault()
      if (currentSuggestions.length === 0) return
      keyboardSelected = true
      saveArrowOriginal()
      selectedIndex = (selectedIndex + 1) % currentSuggestions.length
      applyArrowPreview()
      opts.overlay?.updateSelection?.(selectedIndex)
      return
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault()
      if (currentSuggestions.length === 0) return
      keyboardSelected = true
      saveArrowOriginal()
      selectedIndex = selectedIndex <= 0 ? currentSuggestions.length - 1 : selectedIndex - 1
      applyArrowPreview()
      opts.overlay?.updateSelection?.(selectedIndex)
      return
    }

    if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'v') {
      event.preventDefault()
      opts.onPasteAndGo?.()
      return
    }

    if (event.key === 'Enter') {
      event.preventDefault()
      if (event.ctrlKey || event.metaKey) {
        const selectionStart = input.selectionStart ?? 0
        const selectionEnd = input.selectionEnd ?? selectionStart
        const selectedText = input.value.substring(selectionStart, selectionEnd).trim()
        const text = selectedText || input.value.trim()
        if (text) {
          opts.onCommit(`https://www.${text}.com`, false)
          hide()
          return
        }
      }
      commitFirstOrVerbatim()
      return
    }

    if (event.key === 'Escape') hidePassive()
  }

  const onFocus = (): void => {
    // 回到地址栏时先确保保护草稿仍在；用户接下来可以继续组合或回车提交。
    restoreInterruptedDraftOnce()
    try {
      opts.overlay?.warmSearchbar?.()
    } catch {
      // Warmup is opportunistic.
    }
    if (Date.now() - lastBlurAt < RECLAIM_WINDOW_MS && blurHideTimer !== null) {
      clearTimeout(blurHideTimer)
      blurHideTimer = null
    }
    if (Date.now() - windowRefocusedAt < WINDOW_REFOCUS_GRACE_MS) return
    if (suppressFocusSuggestions) return
    void requestSuggestions({ immediate: true })
  }

  const captureCompositionDraft = (): void => {
    if (!composing) return
    const current = input.value
    if (current) compositionDraft = current
    if (compositionDraft && compositionDraft !== compositionBeforeValue) {
      rememberInterruptedDraft(compositionDraft, compositionBeforeValue)
    }
  }

  const onBlur = (): void => {
    // blur 与 compositionend 的先后顺序随 IME / Chromium 版本变化：在失焦这一拍
    // 再抓一次完整输入，确保随后到达的 compositionend 有草稿可恢复。
    captureCompositionDraft()
    restoreInterruptedDraftOnce()
    if (blurHideTimer !== null) clearTimeout(blurHideTimer)
    lastBlurAt = Date.now()
    if (lastBlurAt < blurIgnoreUntil) {
      blurHideTimer = setTimeout(() => {
        blurHideTimer = null
        hide()
      }, blurIgnoreUntil - lastBlurAt + 20)
      return
    }
    if (overlayShown) {
      blurHideTimer = setTimeout(() => {
        blurHideTimer = null
        hide()
      }, OVERLAY_STEAL_BLUR_GRACE_MS)
      return
    }
    hide()
  }

  const markWindowRefocus = (): void => {
    windowRefocusedAt = Date.now()
  }

  const onWindowFocus = (): void => {
    if (disposed || document.activeElement === input) return
    if (Date.now() - lastBlurAt > RECLAIM_WINDOW_MS) return
    suppressFocusSuggestions = true
    try {
      input.focus()
    } catch {
      // The window can lose activation while restoring DOM focus.
    } finally {
      suppressFocusSuggestions = false
    }
  }

  const cancelPendingRelease = (): void => {
    if (pendingReleaseTimer === null) return
    clearTimeout(pendingReleaseTimer)
    pendingReleaseTimer = null
  }

  function releaseFocus(): void {
    if (disposed || composing) return
    if (Date.now() - lastCompositionEndAt < IME_BLUR_GRACE_MS) return
    if (document.activeElement !== input) return
    try {
      input.blur()
    } catch {
      return
    }
    lastBlurAt = 0
  }

  function scheduleReleaseFocus(): void {
    if (disposed) return
    cancelPendingRelease()
    pendingReleaseTimer = setTimeout(() => {
      pendingReleaseTimer = null
      releaseFocus()
    }, RELEASE_FOCUS_DELAY_MS)
  }

  function selectAllText(): void {
    try {
      input.select()
    } catch {
      // Selection is unavailable for some programmatic focus paths.
    }
  }

  const onInputPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || document.activeElement === input) return
    event.preventDefault()
    try {
      input.focus()
    } catch {
      return
    }
    selectAllText()
  }

  const onWindowResize = (): void => {
    invalidateAnchor()
    if (currentSuggestions.length > 0) render()
  }

  const onAnchorResize = (): void => {
    if (disposed) return
    invalidateAnchor()
    if (currentSuggestions.length > 0) render()
  }

  input.addEventListener('compositionstart', onCompositionStart)
  input.addEventListener('compositionupdate', onCompositionUpdate)
  input.addEventListener('compositionend', onCompositionEnd)
  input.addEventListener('pointerdown', onInputPointerDown)
  input.addEventListener('input', onInput)
  input.addEventListener('keydown', onKeyDown)
  input.addEventListener('focus', onFocus)
  input.addEventListener('blur', onBlur)
  window.addEventListener('focus', markWindowRefocus)
  window.addEventListener('focus', onWindowFocus)
  window.addEventListener('focus', cancelPendingRelease)
  window.addEventListener('blur', captureCompositionDraft)
  window.addEventListener('resize', onWindowResize)

  if (typeof ResizeObserver === 'function') {
    anchorObserver = new ResizeObserver(onAnchorResize)
    anchorObserver.observe(input)
    if (input.parentElement) anchorObserver.observe(input.parentElement)
  }

  return {
    shortcuts: ADDRESS_BAR_SHORTCUTS,

    setQuery(query, options) {
      const next = String(query ?? '')
      if (options?.force === true) clearInterruptedDraft()
      // 地址栏里仍有未确认的 IME 草稿时，迟到的“清空回填”不能把它吃掉。
      else if (interruptedDraft && !next) {
        restoreInterruptedDraftOnce()
        return
      }
      if (composing || input.value === next) return
      if (interruptedDraft && next !== interruptedDraft) clearInterruptedDraft()
      input.value = next
    },

    submit(text) {
      if (composing) return false
      const next = String(text ?? '').trim()
      if (!next) return false
      clearInterruptedDraft()
      input.value = next
      return commitVerbatim(next)
    },

    focus(options) {
      const silent = options?.openSuggestions === false
      if (silent) suppressFocusSuggestions = true
      try {
        input.focus()
      } finally {
        suppressFocusSuggestions = false
      }
      selectAllText()
    },

    releaseFocus: scheduleReleaseFocus,
    hide,

    refreshSuggestions() {
      if (disposed || !overlayShown) return Promise.resolve()
      return requestSuggestions({ immediate: true })
    },

    getSuggestions() {
      return [...currentSuggestions]
    },

    addSuggestor(suggestor) {
      if (disposed) return () => {}
      return registry.add(suggestor)
    },

    removeSuggestor(suggestor) {
      return registry.remove(suggestor)
    },

    destroy() {
      if (disposed) return
      disposed = true
      if (blurHideTimer !== null) clearTimeout(blurHideTimer)
      blurHideTimer = null
      if (pendingReleaseTimer !== null) clearTimeout(pendingReleaseTimer)
      pendingReleaseTimer = null
      clearInterruptedDraft()
      phaseGate.cancel()
      anchorObserver?.disconnect()
      anchorObserver = null
      anchorCache = null
      input.removeEventListener('compositionstart', onCompositionStart)
      input.removeEventListener('compositionupdate', onCompositionUpdate)
      input.removeEventListener('compositionend', onCompositionEnd)
      input.removeEventListener('pointerdown', onInputPointerDown)
      input.removeEventListener('input', onInput)
      input.removeEventListener('keydown', onKeyDown)
      input.removeEventListener('focus', onFocus)
      input.removeEventListener('blur', onBlur)
      window.removeEventListener('focus', markWindowRefocus)
      window.removeEventListener('focus', onWindowFocus)
      window.removeEventListener('focus', cancelPendingRelease)
      window.removeEventListener('blur', captureCompositionDraft)
      window.removeEventListener('resize', onWindowResize)
      hide()
    }
  }
}

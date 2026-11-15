/**
 * 探针：标签组投影（projectTabStacks）
 *
 * 守的是一个**用户报过的症状**：把标签收进折叠的标签组之后，「地址栏空白了」。
 *
 * 根因：投影是渲染层唯一的真相源 —— 标签条靠它画活动态，地址栏靠
 * `projection.find(t => t.active)` 拿当前页。折叠组若把**活动成员**也一起藏掉，
 * 那个 find 就返回 null，页面还在显示、地址栏却空了。
 *
 * 用法：node scripts/verify-tab-stack-projection.cjs
 */
const path = require('node:path')
import type { StackRecord, StackView, TabRecord } from '../domain/domain-tabs/src/types.ts'

type ProjectionItem = StackView | TabRecord

const { projectTabStacks } = require(path.join(__dirname, '..', 'domain', 'domain-tabs', 'src', 'TabStacks.js')) as {
  projectTabStacks: (tabs: unknown[], stacks: unknown[]) => ProjectionItem[]
}

let pass = 0
let fail = 0

function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) {
    pass++
    console.log(`PASS  ${label}  实为 ${JSON.stringify(actual)}`)
  } else {
    fail++
    console.log(`FAIL  ${label}  期望 ${JSON.stringify(expected)}，实为 ${JSON.stringify(actual)}`)
  }
}

/** 投影里每个条目的短名：`tab:<id>` 或 `stack:<id>`。 */
const shape = (proj: ProjectionItem[]): string[] => proj.map((it) => (
  it.type === 'stack' ? `stack:${it.stackId}` : `tab:${it.tabId}`
))

function run() {
  const stack: StackRecord = { stackId: 's1', label: '工作', accent: '', collapsed: false, pinned: false }

  // ① 展开：组行 + 全部成员，顺序与标签顺序一致
  const expanded = projectTabStacks([
    { tabId: 't1', stackId: 's1', active: false },
    { tabId: 't2', stackId: 's1', active: true },
    { tabId: 't3', stackId: null, active: false }
  ], [stack])
  check('展开：组行 + 全部成员按序展开', shape(expanded), ['stack:s1', 'tab:t1', 'tab:t2', 'tab:t3'])
  check('展开：活动标签在投影里（地址栏有内容）', expanded.some((it) => it.tabId === 't2' && it.active), true)

  // ② 折叠 + 活动成员在组内 → **活动成员必须留下**（本次修复的正是这条）
  const collapsedActive = projectTabStacks([
    { tabId: 't1', stackId: 's1', active: false },
    { tabId: 't2', stackId: 's1', active: true },
    { tabId: 't3', stackId: null, active: false }
  ], [{ ...stack, collapsed: true }])
  check('折叠：非活动成员收起', shape(collapsedActive), ['stack:s1', 'tab:t2', 'tab:t3'])
  check('折叠：活动成员仍在投影里（地址栏不空白）', collapsedActive.find((it) => it.active)?.tabId, 't2')

  // ③ 折叠 + 活动标签在组外 → 成员全部收起，活动标签照常
  const collapsedOutside = projectTabStacks([
    { tabId: 't1', stackId: 's1', active: false },
    { tabId: 't2', stackId: 's1', active: false },
    { tabId: 't3', stackId: null, active: true }
  ], [{ ...stack, collapsed: true }])
  check('折叠：活动在组外时组内成员全部收起', shape(collapsedOutside), ['stack:s1', 'tab:t3'])
  check('折叠：活动标签仍在投影里', collapsedOutside.find((it) => it.active)?.tabId, 't3')

  // ④ 组行本身带上成员数与 children（面板/标签条据此渲染折叠态与计数）
  const withMeta = projectTabStacks([
    { tabId: 't1', stackId: 's1', active: false },
    { tabId: 't2', stackId: 's1', active: true }
  ], [{ ...stack, collapsed: true }])
  const row = withMeta.find((it): it is StackView => it.type === 'stack')
  check('组行：count = 全部成员数（折叠时也不缩水）', row?.count, 2)
  check('组行：children = 全部成员 id', row?.children, ['t1', 't2'])
  check('组行：collapsed 透传', row?.collapsed, true)

  // ⑤ 无标签组时原样返回（不引入任何组行）
  const plain = projectTabStacks([{ tabId: 't1', stackId: null, active: true }], [])
  check('没有标签组时：原样返回', shape(plain), ['tab:t1'])
}

console.log('══ 标签组投影探针 ══════════════════════════════════')
run()
console.log(`\n════ 结果：${pass}/${pass + fail} 通过，${fail} 条 FAIL ════`)
if (fail > 0) process.exit(1)
console.log('全部通过 —— 折叠标签组不会再让地址栏空白。')

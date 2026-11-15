import { describe, expect, it } from 'vitest'

const {
  projectTabStacks,
  renameStack,
  setStackColor,
  mergeStacks,
  splitStack,
  dissolveStack,
  moveTabToStack,
  reorderTabs
} = await import('./index.ts')

const tabs = [
  { tabId: 'a', title: 'A' },
  { tabId: 'b', title: 'B', stackId: 's1' },
  { tabId: 'c', title: 'C', stackId: 's1' },
  { tabId: 'd', title: 'D' }
]

const stacks = [
  { stackId: 's1', label: '工作', accent: '#123', collapsed: false },
  { stackId: 's2', label: '阅读', accent: '#456', collapsed: true }
]

describe('projectTabStacks', () => {
  it('保留扁平标签并在首个成员位置插入展开栈投影', () => {
    expect(projectTabStacks(tabs, [{ stackId: 's1', label: '工作', collapsed: false }])).toEqual([
      tabs[0],
      { type: 'stack', stackId: 's1', label: '工作', accent: '', collapsed: false, pinned: false, count: 2, children: ['b', 'c'] },
      tabs[1],
      tabs[2],
      tabs[3]
    ])
  })

  it('折叠栈只投影 chip，不泄漏其成员，同时不影响非成员扁平标签', () => {
    expect(projectTabStacks(tabs, [{ stackId: 's1', label: '工作', accent: '#123', collapsed: true }])).toEqual([
      tabs[0],
      { type: 'stack', stackId: 's1', label: '工作', accent: '#123', collapsed: true, pinned: false, count: 2, children: ['b', 'c'] },
      tabs[3]
    ])
  })

  it('忽略不存在的栈引用，维持原始扁平顺序', () => {
    expect(projectTabStacks([{ tabId: 'a', stackId: 'missing' }], [])).toEqual([{ tabId: 'a', stackId: 'missing' }])
  })
})

describe('dissolveStack', () => {
  it('成员全部回到散标签，组元数据删掉（顺带回收空壳组）', () => {
    const result = dissolveStack(tabs, stacks, { stackId: 's1' })
    // ⚠ tabs 必须是**全量**：宿主的 applyStackRule 按「结果集里没出现 = 该标签没了」同步，
    //   漏一个标签就会把它删掉。
    expect(result.tabs.map((t) => t.tabId)).toEqual(['a', 'b', 'c', 'd'])
    expect(result.tabs.map((t) => t.stackId || null)).toEqual([null, null, null, null])
    // s1 被删；夹具里的 s2 本来就没人（悬空元数据），顺带一起回收 ——
    // 与 mergeStacks / reorderTabs 走的是同一个 pruneEmptyStacks 口径。
    expect(result.stacks.map((s) => s.stackId)).toEqual([])
    expect(result.children).toEqual(['b', 'c'])
  })

  it('组不存在 → null（不静默成功）', () => {
    expect(dissolveStack(tabs, stacks, { stackId: 'missing' })).toBeNull()
  })

  it('纯函数：不改动入参', () => {
    dissolveStack(tabs, stacks, { stackId: 's1' })
    expect(tabs[1].stackId).toBe('s1')
    expect(tabs[2].stackId).toBe('s1')
    expect(stacks.length).toBe(2)
  })
})

describe('TabStacks mutations', () => {
  it('重命名和改色返回新栈快照，不修改输入', () => {
    const renamed = renameStack(stacks, { stackId: 's1', label: '  新名称  ' })
    const recolored = setStackColor(renamed.stacks, { stackId: 's1', accent: '  #999  ' })
    expect(renamed).toMatchObject({ stackId: 's1', label: '新名称' })
    expect(recolored).toMatchObject({ stackId: 's1', accent: '#999' })
    expect(stacks[0]).toEqual({ stackId: 's1', label: '工作', accent: '#123', collapsed: false })
  })

  it('合并时迁移成员并删除来源栈', () => {
    const result = mergeStacks([...tabs, { tabId: 'e', stackId: 's2' }], stacks, { sourceStackId: 's1', targetStackId: 's2' })
    expect(result).toMatchObject({ sourceStackId: 's1', targetStackId: 's2', count: 2 })
    expect(result.tabs.map((tab) => tab.stackId || null)).toEqual([null, 's2', 's2', null, 's2'])
    expect(result.stacks.map((stack) => stack.stackId)).toEqual(['s2'])
  })

  it('拆分只迁移来源栈中被选成员，并继承未覆盖的元数据', () => {
    const result = splitStack(tabs, stacks, { stackId: 's1', tabIds: ['c', 'd'], nextStackId: 's3', label: '  拆出  ' })
    expect(result).toMatchObject({ stackId: 's3', label: '拆出', accent: '#123', collapsed: false, count: 1, children: ['c'] })
    expect(result.tabs.map((tab) => tab.stackId || null)).toEqual([null, 's1', 's3', null])
  })

  it('拖入 stack chip 迁移成员并在来源栈为空时清理元数据', () => {
    const result = reorderTabs(tabs, stacks, { draggedId: 'd', targetStackId: 's1' })
    expect(result.ok).toBe(true)
    expect(result.tabs.map((tab) => tab.stackId || null)).toEqual([null, 's1', 's1', 's1'])
    expect(result.stacks.map((stack) => stack.stackId)).toEqual(['s1'])

    const movedOnlyMember = reorderTabs(
      [{ tabId: 'a', stackId: 's1' }, { tabId: 'b' }],
      [{ stackId: 's1' }, { stackId: 's2' }],
      { draggedId: 'a', targetStackId: 's2' }
    )
    expect(movedOnlyMember.ok).toBe(true)
    expect(movedOnlyMember.tabs.map((tab) => tab.stackId || null)).toEqual(['s2', null])
    expect(movedOnlyMember.stacks.map((stack) => stack.stackId)).toEqual(['s2'])
  })

  it('stack 内排序保留成员关系，跨 stack 排序会脱离原组', () => {
    const moved = moveTabToStack(tabs, stacks, { tabId: 'a', stackId: 's1' })
    expect(moved.tabs.map((tab) => tab.stackId || null)).toEqual(['s1', 's1', 's1', null])

    const reordered = reorderTabs(moved.tabs, moved.stacks, { draggedId: 'a', targetId: 'c', insertAfter: true })
    expect(reordered.ok).toBe(true)
    expect(reordered.tabs.map((tab) => tab.tabId)).toEqual(['b', 'c', 'a', 'd'])
    expect(reordered.tabs.find((tab) => tab.tabId === 'a').stackId).toBe('s1')

    const detached = reorderTabs(reordered.tabs, reordered.stacks, { draggedId: 'a', targetId: 'd', insertAfter: true })
    expect(detached.ok).toBe(true)
    expect(detached.tabs.map((tab) => tab.tabId)).toEqual(['b', 'c', 'd', 'a'])
    expect(detached.tabs.find((tab) => tab.tabId === 'a').stackId).toBeNull()
  })

  it('对缺失 tab 或栈返回失败快照', () => {
    expect(renameStack(stacks, { stackId: 'missing', label: 'x' })).toBeNull()
    expect(mergeStacks(tabs, stacks, { sourceStackId: 's1', targetStackId: 'missing' })).toBeNull()
    expect(splitStack(tabs, stacks, { stackId: 's1', tabIds: ['a'], nextStackId: 's3' })).toBeNull()
    expect(reorderTabs(tabs, stacks, { draggedId: 'missing', targetId: 'a' })).toEqual({ ok: false })
  })
})

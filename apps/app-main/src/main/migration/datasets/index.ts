/**
 * 4 套测试数据集生成器。
 *
 * DATA1 空：无数据，验证迁移幂等
 * DATA2 2000 书签 + 200 文件夹 + 50000 历史：性能基准 <30s
 * DATA3 100k 历史：极端历史数据 <2min
 * DATA4 8 个构造脏数据：回归 8 个历史 bug
 *
 * 解耦：纯函数，不依赖 DB。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export interface MigrationDataset {
  bookmarks: unknown[]
  history: unknown[]
  downloads: unknown[]
  notes: unknown[]
  tabs: unknown[]
  settings: Record<string, unknown>
  passwords: unknown[]
  permissions: unknown[]
}

export type DatasetName = 'empty' | 'medium' | 'largeHistory' | 'dirty'

function uid() {
  return crypto.randomUUID()
}

/** 生成 DATA1：空数据集 */
export function genData1(): MigrationDataset {
  return {
    bookmarks: [],
    history: [],
    downloads: [],
    notes: [],
    tabs: [],
    settings: {},
    passwords: [],
    permissions: []
  }
}

/** 生成 DATA2：2000 书签 + 200 文件夹 + 50000 历史 */
export function genData2(): MigrationDataset {
  const bookmarks: unknown[] = []
  const folders: Array<{ id: string; parentId: null; title: string; url: null; createdAt: number; modifiedAt: number }> = []

  // 200 文件夹
  for (let i = 0; i < 200; i++) {
    folders.push({
      id: uid(),
      parentId: null,
      title: `文件夹 ${i + 1}`,
      url: null,
      createdAt: Date.now() - i * 1000,
      modifiedAt: Date.now()
    })
  }

  // 2000 书签（分布在文件夹中）
  for (let i = 0; i < 2000; i++) {
    const folder = folders[i % 200]
    bookmarks.push({
      id: uid(),
      parentId: folder.id,
      title: `书签 ${i + 1}`,
      url: `https://example.com/page/${i + 1}`,
      favicon: null,
      createdAt: Date.now() - i * 500,
      modifiedAt: Date.now()
    })
  }

  // 50000 历史
  const history: unknown[] = []
  for (let i = 0; i < 50000; i++) {
    history.push({
      id: uid(),
      url: `https://example.com/visit/${i + 1}`,
      title: `页面 ${i + 1}`,
      favicon: null,
      visitCount: Math.floor(Math.random() * 10) + 1,
      lastVisitAt: Date.now() - i * 100,
      firstVisitAt: Date.now() - i * 1000
    })
  }

  return {
    bookmarks: [...folders, ...bookmarks],
    history,
    downloads: [],
    notes: [],
    tabs: [],
    settings: { 'theme': 'dark', 'language': 'zh-CN' },
    passwords: [],
    permissions: []
  }
}

/** 生成 DATA3：100k 历史 */
export function genData3(): MigrationDataset {
  const history: unknown[] = []
  for (let i = 0; i < 100000; i++) {
    history.push({
      id: uid(),
      url: `https://example.com/visit/${i + 1}`,
      title: `页面 ${i + 1}`,
      favicon: null,
      visitCount: Math.floor(Math.random() * 5) + 1,
      lastVisitAt: Date.now() - i * 50,
      firstVisitAt: Date.now() - i * 200
    })
  }
  return {
    bookmarks: [],
    history,
    downloads: [],
    notes: [],
    tabs: [],
    settings: {},
    passwords: [],
    permissions: []
  }
}

/**
 * 生成 DATA4：8 个构造脏数据（回归 8 个历史 bug）
 *
 * bug1: 书签字段缺失 → 应有默认值
 * bug2: 历史 URL 重复 → 不崩溃
 * bug3: 下载 state 非法值 → 能插入
 * bug4: 笔记 title 为空 → 用默认标题
 * bug5: tabs position 重复 → 能插入
 * bug6: settings key 含点号 → 能存储
 * bug7: 密码 domain 为空字符串 → 不崩溃
 * bug8: 权限 setting 非法 → 用 ask
 */
export function genData4(): MigrationDataset {
  return {
    bookmarks: [
      // bug1: 缺失字段
      { id: uid(), title: '', url: 'https://example.com' },
      { id: uid(), parentId: null, title: '正常书签', url: 'https://example.com/ok', createdAt: Date.now(), modifiedAt: Date.now() }
    ],
    history: [
      // bug2: URL 重复
      { id: uid(), url: 'https://dup.example.com', title: '重复1', lastVisitAt: Date.now(), firstVisitAt: Date.now() },
      { id: uid(), url: 'https://dup.example.com', title: '重复2', lastVisitAt: Date.now(), firstVisitAt: Date.now() }
    ],
    downloads: [
      // bug3: state 非法
      { id: uid(), url: 'https://example.com/file.zip', filename: 'file.zip', state: 'invalid_state', startedAt: Date.now() }
    ],
    notes: [
      // bug4: title 空
      { id: uid(), title: '', content: '内容', createdAt: Date.now(), modifiedAt: Date.now() }
    ],
    tabs: [
      // bug5: position 重复
      { id: uid(), url: 'https://a.com', position: 0, createdAt: Date.now() },
      { id: uid(), url: 'https://b.com', position: 0, createdAt: Date.now() }
    ],
    // bug6: key 含点号
    settings: { 'a.b.c': 'dot-key-value', 'normal': 'normal-value' },
    passwords: [
      // bug7: domain 空
      { id: uid(), domain: '', username: 'user', backend: 'builtin', createdAt: Date.now() }
    ],
    permissions: [
      // bug8: setting 非法
      { id: uid(), domain: 'example.com', permissionType: 'popup', setting: 'INVALID', updatedAt: Date.now() }
    ]
  }
}

export const DATASETS: Record<DatasetName, () => MigrationDataset> = {
  empty: genData1,
  medium: genData2,
  largeHistory: genData3,
  dirty: genData4
}

/**
 * 将数据集写入源目录（每个表一个 JSON 文件）。
 * @param {string} dir
 * @param {object} dataset
 */
export function writeDatasetToDir(dir: string, dataset: MigrationDataset): void {
  fs.mkdirSync(dir, { recursive: true })
  const fileMap: Record<keyof MigrationDataset, string> = {
    bookmarks: 'bookmarks.json',
    history: 'history.json',
    downloads: 'downloads.json',
    notes: 'notes.json',
    tabs: 'tabs.json',
    settings: 'settings.json',
    passwords: 'passwords.json',
    permissions: 'permissions.json'
  }
  for (const key of Object.keys(fileMap) as Array<keyof MigrationDataset>) {
    const file = fileMap[key]
    const data = dataset[key]
    fs.writeFileSync(path.join(dir, file), JSON.stringify(data, null, 2))
  }
}


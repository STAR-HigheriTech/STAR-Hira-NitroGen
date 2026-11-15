import { describe, it, expect } from 'vitest'
import {
  computeProgressPercent,
  computeBytesRemaining,
  isPending, isDownloading, isPaused, isCompleted, isCancelled, isInterrupted,
  parseContentDisposition,
  extractFilenameFromUrl,
  chooseFallbackFilename,
  stripExtension,
  hashUrl
} from './util.ts'

describe('进度与剩余', () => {
  it('computeProgressPercent：clamp 与保留 1 位', () => {
    expect(computeProgressPercent(0, 100)).toBe(0)
    expect(computeProgressPercent(50, 100)).toBe(50)
    expect(computeProgressPercent(5, 100)).toBe(5)
    expect(computeProgressPercent(20, 100)).toBe(20)
    expect(computeProgressPercent(200, 100)).toBe(100)
    expect(computeProgressPercent(10, 0)).toBe(0)
    expect(computeProgressPercent(1, null)).toBe(0)
    expect(computeProgressPercent(1, 3)).toBe(33.3)
  })
  it('computeBytesRemaining：越界归零', () => {
    expect(computeBytesRemaining(30, 100)).toBe(70)
    expect(computeBytesRemaining(100, 100)).toBe(0)
    expect(computeBytesRemaining(120, 100)).toBe(0)
    expect(computeBytesRemaining(1, null)).toBe(0)
  })
})

describe('状态标签与判定', () => {
  it('谓词判二等分状态', () => {
    expect(isPending('pending')).toBe(true)
    expect(isDownloading('in_progress')).toBe(true)
    expect(isPaused('paused')).toBe(true)
    expect(isCompleted('completed')).toBe(true)
    expect(isCancelled('cancelled')).toBe(true)
    expect(isInterrupted('failed')).toBe(true)
    expect(isInterrupted('interrupted')).toBe(true)
    expect(isInterrupted('completed')).toBe(false)
  })
})

describe('文件名决策', () => {
  it('parseContentDisposition：filename*= 优先', () => {
    expect(parseContentDisposition("attachment; filename*=UTF-8''%E7%A4%BA%E4%BE%8B.txt")).toBe('示例.txt')
    expect(parseContentDisposition('attachment; filename="a b.txt"')).toBe('a b.txt')
    expect(parseContentDisposition('inline')).toBe('')
    expect(parseContentDisposition(null)).toBe('')
  })
  it('extractFilenameFromUrl：去查询串与解码', () => {
    expect(extractFilenameFromUrl('https://x/a%20b.txt?sig=1')).toBe('a b.txt')
    expect(extractFilenameFromUrl('https://x/')).toBe('')
    expect(extractFilenameFromUrl('')).toBe('')
  })
  it('chooseFallbackFilename：优先级链', () => {
    expect(chooseFallbackFilename({ url: 'https://x/f.txt', contentDisposition: 'attachment; filename="g.txt"' })).toBe('g.txt')
    expect(chooseFallbackFilename({ url: 'https://x/f.txt' })).toBe('f.txt')
    expect(chooseFallbackFilename({ url: 'https://x/' })).toBe('download')
  })
  it('stripExtension', () => {
    expect(stripExtension('a.tar.gz')).toBe('a.tar')
    expect(stripExtension('noext')).toBe('noext')
    expect(stripExtension('.hidden')).toBe('.hidden')
    expect(stripExtension('')).toBe('')
  })
})

describe('散列', () => {
  it('hashUrl：确定性且区分大小写', () => {
    expect(hashUrl('https://a/b')).toBe(hashUrl('https://a/b'))
    expect(hashUrl('https://a/b')).not.toBe(hashUrl('https://A/b'))
  })
})

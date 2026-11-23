// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { IMAGE_PATH, isFileHref } from '../file-paste'

describe('ファイルのリンク', () => {
  it('保管庫の中の、ページでないファイルだけをファイルとして扱う', () => {
    expect(isFileHref('企画/見積書.pdf')).toBe(true)
    expect(isFileHref('企画/メモ.html')).toBe(true)
    expect(isFileHref('../資料/表.xlsx')).toBe(true)
    expect(isFileHref('企画/ページ.md')).toBe(false)
    expect(isFileHref('ページ.md#見出し')).toBe(false)
    expect(isFileHref('https://example.com/a.pdf')).toBe(false)
    expect(isFileHref('mailto:a@example.com')).toBe(false)
    expect(isFileHref('#見出し')).toBe(false)
    expect(isFileHref('')).toBe(false)
  })

  it('画像は画像として、ほかは名前のリンクとして入れる', () => {
    expect(IMAGE_PATH.test('企画/写真.HEIC')).toBe(true)
    expect(IMAGE_PATH.test('企画/見積書.pdf')).toBe(false)
  })
})

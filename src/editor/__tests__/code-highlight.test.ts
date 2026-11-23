// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { codeLanguagesReady, highlightLanguage, loadCodeLanguages } from '../plugins'

describe('コードの色付けの言語は、使うときに初めて読み込む', () => {
  it('読み込む前は色付けしない言語として扱い、読み込んだあとは色付けできる', async () => {
    expect(codeLanguagesReady()).toBe(false)
    expect(highlightLanguage('typescript')).toBe(false)
    await loadCodeLanguages()
    expect(codeLanguagesReady()).toBe(true)
    expect(highlightLanguage('typescript')).toBe(true)
    expect(highlightLanguage('rust')).toBe(true)
    expect(highlightLanguage('存在しない言語')).toBe(false)
    // 二度目は何もしない
    await loadCodeLanguages()
  })
})

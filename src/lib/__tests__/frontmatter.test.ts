import { describe, expect, it } from 'vitest'
import { readIcon, writeIcon } from '../frontmatter'

describe('readIcon', () => {
  it('フロントマターの icon を読む', () => {
    expect(readIcon('---\ntitle: x\nicon: 📝\n---\n本文\n')).toBe('📝')
    expect(readIcon('---\nicon: "🚀"\n---\n')).toBe('🚀')
    expect(readIcon('﻿---\r\nicon: 🌱\r\n---\r\n')).toBe('🌱')
  })

  it('無いとき・先頭にないときは null', () => {
    expect(readIcon('本文\n')).toBeNull()
    expect(readIcon('本文\n---\nicon: 📝\n---\n')).toBeNull()
    expect(readIcon('---\ntitle: x\n---\nicon: 📝\n')).toBeNull()
  })
})

describe('writeIcon', () => {
  it('フロントマターが無ければ先頭に作る', () => {
    expect(writeIcon('本文\n', '📝')).toBe('---\nicon: 📝\n---\n本文\n')
    expect(writeIcon('', '📝')).toBe('---\nicon: 📝\n---\n')
  })

  it('ほかの行はそのままに、icon だけを足す・替える', () => {
    expect(writeIcon('---\ntitle: x\n---\n本文\n', '📝')).toBe('---\nicon: 📝\ntitle: x\n---\n本文\n')
    expect(writeIcon('---\ntitle: x\nicon: 📝\n---\n本文\n', '🚀')).toBe('---\ntitle: x\nicon: 🚀\n---\n本文\n')
  })

  it('消すと、ほかに何もなければフロントマターごと消す', () => {
    expect(writeIcon('---\nicon: 📝\n---\n本文\n', null)).toBe('本文\n')
    expect(writeIcon('---\ntitle: x\nicon: 📝\n---\n本文\n', null)).toBe('---\ntitle: x\n---\n本文\n')
    expect(writeIcon('本文\n', null)).toBe('本文\n')
  })

  it('CRLF と BOM を保つ', () => {
    expect(writeIcon('﻿本文\r\n', '📝')).toBe('﻿---\r\nicon: 📝\r\n---\r\n本文\r\n')
    expect(writeIcon('﻿---\r\nicon: 📝\r\n---\r\n本文\r\n', '🚀')).toBe('﻿---\r\nicon: 🚀\r\n---\r\n本文\r\n')
  })

  it('書いたものを読み戻せる', () => {
    expect(readIcon(writeIcon('本文\n', '👨‍👩‍👧'))).toBe('👨‍👩‍👧')
  })
})

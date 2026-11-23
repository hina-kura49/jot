// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { buildPageHtml } from '../export-html'

describe('buildPageHtml', () => {
  it('編集のための部品と属性を外し、保管庫の中へのリンクは文字だけにする', async () => {
    const article = document.createElement('article')
    article.className = 'page'
    article.style.transform = 'translateX(4px)'
    article.innerHTML = `
      <div class="page-icon no-print"><button class="page-icon-emoji">🚀</button></div>
      <div class="page-icon no-print"><button class="page-icon-add">アイコンを追加</button></div>
      <h1 class="page-title" contenteditable="plaintext-only" spellcheck="false">題 & <b></h1>
      <div class="editor-host">
        <div class="jot-editor" style="visibility: hidden">
          <div class="ProseMirror" contenteditable="true">
            <p><a href="other.md">中</a> <a href="https://example.com">外</a></p>
            <p><img src="data:image/png;base64,AAAA" alt="図"></p>
            <ul><li><input type="checkbox" checked>済</li></ul>
          </div>
        </div>
        <button class="drag-handle">⠿</button>
      </div>`
    const html = await buildPageHtml(article, '題 & <b>')
    const body = html.split('<body>')[1]

    expect(html).toContain('<title>題 &amp; &lt;b&gt;</title>')
    expect(body).not.toContain('contenteditable')
    expect(body).not.toContain('drag-handle')
    expect(body).not.toContain('アイコンを追加')
    expect(body).toContain('🚀')
    expect(body).not.toContain('visibility: hidden')
    expect(body).toContain('<a>中</a>')
    expect(body).toContain('<a href="https://example.com" target="_blank" rel="noopener">外</a>')
    expect(body).toContain('src="data:image/png;base64,AAAA"')
    expect(body).toMatch(/<input type="checkbox" checked="" disabled="">/)
  })
})

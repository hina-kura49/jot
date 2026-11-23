// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { setBackend } from '@/backend'
import { MockBackend } from '@/backend/mock'
import { roundTrip, topLevelTypes } from '@/editor/__tests__/helpers'
import { useApp } from '../app'
import { GUIDE_PATH, guideMarkdown } from '../guide'

const initialState = useApp.getState()
const app = () => useApp.getState()
const treeHas = (path: string) => JSON.stringify(app().tree).includes(`"path":"${path}"`)

async function start(options: ConstructorParameters<typeof MockBackend>[0]): Promise<MockBackend> {
  const mock = new MockBackend(options)
  setBackend(mock)
  useApp.setState(initialState, true)
  await app().init()
  return mock
}

describe('使い方のノート', () => {
  beforeEach(() => useApp.setState(initialState, true))

  it('空のフォルダを保管庫に選ぶと、使い方のノートを1枚作って開く', async () => {
    const mock = await start({ vault: null, empty: true })
    await app().openVault()
    expect(treeHas(GUIDE_PATH)).toBe(true)
    expect(app().page?.path).toBe(GUIDE_PATH)
    expect((await mock.readPage(GUIDE_PATH)).content).toBe(guideMarkdown())
  })

  it('すでにノートがあるフォルダには、何も足さない', async () => {
    await start({ vault: null })
    await app().openVault()
    expect(treeHas(GUIDE_PATH)).toBe(false)
  })

  it('起動しただけでは作らない(空の保管庫のまま開き直しても、消したノートは戻らない)', async () => {
    await start({ empty: true })
    expect(app().tree).toEqual([])
  })

  it('コマンドパレットの「使い方のノートを開く」: なければ作り、あればそれを開く', async () => {
    const mock = await start({})
    await app().openGuide()
    expect(app().page?.path).toBe(GUIDE_PATH)
    await mock.writePage(GUIDE_PATH, '書き換えた\n', (await mock.readPage(GUIDE_PATH)).version)
    await app().openPage('仕事/企画/プロダクトの方向性.md')
    await app().openGuide()
    expect(app().page?.path).toBe(GUIDE_PATH)
    expect((await mock.readPage(GUIDE_PATH)).content).toBe('書き換えた\n')
  })

  it('中身は、エディタが扱える書き方だけで書いてある(開いて保存しても変わらない)', async () => {
    for (const ctrl of [false, true]) {
      const md = guideMarkdown(ctrl)
      expect((await roundTrip(md)).preserved).toBe(md)
      expect(await topLevelTypes(md)).not.toContain('raw_block')
    }
  })

  it('ショートカットは、Mac では ⌘、ほかでは Ctrl で書く', () => {
    expect(guideMarkdown(false)).toContain('`⌘K`')
    expect(guideMarkdown(false)).toContain('`⌘⇧N`')
    expect(guideMarkdown(true)).toContain('`Ctrl+K`')
    expect(guideMarkdown(true)).toContain('`Ctrl+Shift+N`')
    expect(guideMarkdown(true)).not.toContain('⌘')
  })
})

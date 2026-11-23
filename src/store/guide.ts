import { backend } from '@/backend'
import CAPTURE_SHORTCUT from '@/capture/shortcut.json'
import { usesCtrlAsMod } from '@/lib/keyboard'

// 使い方のノート。空のフォルダを保管庫に選んだときに1枚だけ作る(すでにノートがあるフォルダには何も足さない)。
// コマンドパレットの「使い方のノートを開く」でも開ける(なければ作る)。中身はふつうのページなので、消しても書き換えてもよい。
// 日本語と英語の2つを持ち、OS の言語が日本語なら日本語、ほかは英語で作る。

export type GuideLanguage = 'ja' | 'en'

const TITLES: Record<GuideLanguage, string> = { ja: 'Jot の使い方', en: 'Getting started with Jot' }

/** OS(ブラウザ)の言語から決める。日本語のほかは英語 */
export const guideLanguage = (): GuideLanguage => (typeof navigator !== 'undefined' && /^ja\b/i.test(navigator.language || '') ? 'ja' : 'en')

export const guideTitle = (lang: GuideLanguage = guideLanguage()): string => TITLES[lang]
export const guidePath = (lang: GuideLanguage = guideLanguage()): string => `${TITLES[lang]}.md`

/** ショートカットの表記(Mac は ⌘⇧N、ほかは Ctrl+Shift+N) */
const keys = (ctrlAsMod: boolean) => ({
  mod: (key: string) => (ctrlAsMod ? `Ctrl+${key}` : `⌘${key}`),
  modShift: (key: string) => (ctrlAsMod ? `Ctrl+Shift+${key}` : `⌘⇧${key}`),
  capture: ctrlAsMod ? CAPTURE_SHORTCUT.accelerator : CAPTURE_SHORTCUT.label,
})

export function guideMarkdown(lang: GuideLanguage = guideLanguage(), ctrlAsMod: boolean = usesCtrlAsMod): string {
  const k = keys(ctrlAsMod)
  return lang === 'ja' ? japanese(k) : english(k)
}

type Keys = ReturnType<typeof keys>

const japanese = (k: Keys): string => `Jot へようこそ。このページは使い方の案内です。読み終わったら、消しても書き換えてもかまいません。

## ノートはただのファイル

選んだフォルダ（保管庫）の中の Markdown ファイルが、そのままノートです。このページも \`${guidePath('ja')}\` という1つのファイルで、ほかのエディタでも開けます。保存の操作は要りません。書いたそばから自動で保存します。

## 書く

行頭で記号を打つと、その場で形が変わります。

| 打つもの | なるもの |
| --- | --- |
| \`#\` \`##\` \`###\` のあとに空白 | 見出し |
| \`-\` のあとに空白 | リスト |
| \`1.\` のあとに空白 | 番号付きリスト |
| \`[]\` のあとに空白 | チェックリスト |
| \`>\` のあとに空白 | 引用 |
| バッククォート3つ | コードブロック |
| \`---\` | 区切り線 |

\`/\` を打つと、ブロックのメニューが開きます。表・コールアウト・トグル・Mermaid の図などは、ここから入れます。

ためしてみましょう。

- [ ] この下の行で \`/\` を打って、メニューを開く
- [ ] このチェックを押して、済みにする
- [ ] \`${k.mod('K')}\` でコマンドパレットを開き、「使い方」と打つ

## コード

コードブロックは、帯のある窓の形で出ます。帯の言語は書き換えられて、右のボタンで中身をコピーできます。

\`\`\`ts
function greet(name: string): string {
  return \`こんにちは、\${name}\`
}
\`\`\`

## 目立たせる・たたむ

> [!note] コールアウト
> 目立たせたいことを、枠で囲んで書けます。

> [!note]- トグル（左の三角を押すと開きます）
> たたんでおきたい内容を、ここに書けます。

## ページを整理する

- \`${k.mod('N')}\` で新しいページ、\`${k.modShift('N')}\` で子ページを作ります。
- 左のツリーの行をつかんで、別の場所へ動かせます。動かしても、ページの間のリンクはつながったままです。
- \`/page\` で、いまのページの下に子ページを作ってリンクを入れます。
- タイトルの上にマウスを乗せると、ページにアイコンを付けられます。
- ブロックは、左に出るつまみをドラッグするか、\`${k.modShift('↑')}\` \`${k.modShift('↓')}\` で並べ替えられます。

## 探す

- \`${k.mod('K')}\`: ページの名前・本文・コマンドを、ひとつの入力欄から探します。
- \`${k.mod('F')}\`: 開いているページの中を探します。

## そのほか

- **クイックキャプチャ**: \`${k.capture}\` で、ほかのアプリを使っていても小さな入力欄が出ます。書いたものは \`Inbox\` のページにたまります。
- **書き出し**: \`${k.modShift('H')}\` で、ページを HTML 1枚に書き出して人に送れます。
- **Vim のキー操作**: コマンドパレットで「Vim」と打つと、オン・オフを切り替えられます。

この案内は、コマンドパレットの「使い方のノートを開く」でいつでも開き直せます。
`

const english = (k: Keys): string => `Welcome to Jot. This page is a short tour. Edit it or delete it whenever you like.

## Notes are just files

Every note is a Markdown file inside the folder you picked (your vault). This page is a single file called \`${guidePath('en')}\`, and any other editor can open it. There is no save button: Jot saves as you type.

## Writing

Type one of these at the start of a line and it turns into a block.

| Type this | To get |
| --- | --- |
| \`#\` \`##\` \`###\` then a space | Heading |
| \`-\` then a space | List |
| \`1.\` then a space | Numbered list |
| \`[]\` then a space | Checklist |
| \`>\` then a space | Quote |
| Three backticks | Code block |
| \`---\` | Divider |

Press \`/\` to open the block menu. Tables, callouts, toggles and Mermaid diagrams are in there.

Try it out.

- [ ] Type \`/\` on the line below to open the menu
- [ ] Click this checkbox to tick it off
- [ ] Press \`${k.mod('K')}\` to open the command palette

## Code

Code blocks are drawn as a small window. You can change the language in the title bar, and the button on the right copies the code.

\`\`\`ts
function greet(name: string): string {
  return \`Hello, \${name}\`
}
\`\`\`

## Callouts and toggles

> [!note] Callout
> Put things you want to stand out in a box.

> [!note]- Toggle (click the triangle to open)
> Tuck away the details here.

## Organizing pages

- \`${k.mod('N')}\` creates a page and \`${k.modShift('N')}\` creates a child page.
- Drag rows in the tree on the left to move them. Links between pages keep working after a move.
- \`/page\` creates a child page under this one and inserts a link to it.
- Hover above the title to give the page an icon.
- Reorder blocks by dragging the handle on the left, or with \`${k.modShift('↑')}\` and \`${k.modShift('↓')}\`.

## Finding things

- \`${k.mod('K')}\`: search page titles, full text and commands from one box.
- \`${k.mod('F')}\`: find within the open page.

## More

- **Quick capture**: \`${k.capture}\` opens a small input from any app. What you write is appended to the \`Inbox\` page.
- **Export**: \`${k.modShift('H')}\` exports the page as a single HTML file you can send to someone.
- **Vim mode**: type "Vim" in the command palette to turn Vim keybindings on or off.

You can reopen this tour from the command palette at any time.
`

/** 使い方のノートを保管庫の直下に作り、その path を返す */
export async function createGuide(): Promise<string> {
  const { path } = await backend().createPage(null, guideTitle())
  const { version } = await backend().readPage(path)
  await backend().writePage(path, guideMarkdown(), version)
  return path
}

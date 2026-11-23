import { backend } from '@/backend'
import CAPTURE_SHORTCUT from '@/capture/shortcut.json'
import { usesCtrlAsMod } from '@/lib/keyboard'

// 使い方のノート。空のフォルダを保管庫に選んだときに1枚だけ作る(すでにノートがあるフォルダには何も足さない)。
// コマンドパレットの「使い方のノートを開く」でも開ける(なければ作る)。中身はふつうのページなので、消しても書き換えてもよい。

export const GUIDE_TITLE = 'Jot の使い方'
export const GUIDE_PATH = `${GUIDE_TITLE}.md`

/** ショートカットの表記(Mac は ⌘⇧N、ほかは Ctrl+Shift+N) */
const keys = (ctrlAsMod: boolean) => ({
  mod: (key: string) => (ctrlAsMod ? `Ctrl+${key}` : `⌘${key}`),
  modShift: (key: string) => (ctrlAsMod ? `Ctrl+Shift+${key}` : `⌘⇧${key}`),
  capture: ctrlAsMod ? CAPTURE_SHORTCUT.accelerator : CAPTURE_SHORTCUT.label,
})

export function guideMarkdown(ctrlAsMod: boolean = usesCtrlAsMod): string {
  const k = keys(ctrlAsMod)
  return `Jot へようこそ。このページは使い方の案内です。読み終わったら、消しても書き換えてもかまいません。

## ノートはただのファイル

選んだフォルダ（保管庫）の中の Markdown ファイルが、そのままノートです。このページも \`${GUIDE_PATH}\` という1つのファイルで、ほかのエディタでも開けます。保存の操作は要りません。書いたそばから自動で保存します。

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
}

/** 使い方のノートを保管庫の直下に作り、その path を返す */
export async function createGuide(): Promise<string> {
  const { path } = await backend().createPage(null, GUIDE_TITLE)
  const { version } = await backend().readPage(path)
  await backend().writePage(path, guideMarkdown(), version)
  return path
}

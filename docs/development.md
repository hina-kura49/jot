# 開発の手引き

動かし方、フォルダの構成、設計の約束をまとめています。

## 技術の構成

| 部分 | 使っているもの |
| --- | --- |
| フロントエンド（`src/`） | React 19、TypeScript（strict：型の検査を厳しくする設定）、Vite、Tailwind CSS v4、Milkdown 7（Markdown のエディタ）、TanStack Virtual（長い一覧の仮想表示）、Zustand（状態の管理）、cmdk（コマンドパレット）、Vitest（テスト） |
| バックエンド（`core/`） | Rust のクレート（ライブラリ）`jot-core`。Tauri には依存しません |

## 動かし方

Node.js と npm が必要です。

```sh
npm install      # 依存パッケージを入れる
npm run dev      # 開発用サーバーを起動する（http://localhost:5173）
npm test         # テストを実行する（vitest run）
npm run lint     # コードの検査をする（oxlint）
npm run build    # 型の検査（tsc -b）をしてから、本番用にビルドする（vite build）
```

`npm run dev` でブラウザから開くと、MockBackend（本物のファイルを使わない、見せかけのバックエンド）で動きます。Rust 側がなくても画面を確かめられます。
ポートは Tauri から開くときのために 5173 に固定しています（`vite.config.ts` の `strictPort`）。ほかのアプリが 5173 を使っていると起動しません。

### Mock の状態を URL で切り替える

`src/backend/index.ts` が URL の引数（`?` の後ろ）を読み、Mock の状態を変えます。

| 引数 | 意味 |
| --- | --- |
| `?vault=none` | 初回起動の状態。保管庫のフォルダがまだ選ばれていません |
| `?empty` | ページが1つもない保管庫で始めます |
| `?latency=300` | バックエンドの呼び出しをすべて 300ms 遅らせます（数字はミリ秒）。ページを切り替えるときの確認に使います |

組み合わせることもできます（例：`http://localhost:5173/?empty&latency=500`）。

また、開発者ツールのコンソールから `__mock` で Mock を操作でき、ほかのアプリで変更されたときの動きを再現できます。

```js
__mock.simulateExternalEdit(path, content) // 外部でファイルが書き換えられた
__mock.simulateExternalDelete(path)        // 外部でファイルが削除された
__mock.setReadOnly(path, true)             // ファイルを読み取り専用にする
```


クイックキャプチャの画面は、`http://localhost:5173/?window=capture` でブラウザでも確かめられます（ウィンドウを隠す動きはありません）。

### Tauri のアプリとして動かす

Rust（`cargo`）が必要です。

```sh
npm run app        # MockBackend で動かす(core はビルドしない)
npm run app:core   # core/ につないで動かす(VITE_BACKEND=tauri と Cargo の機能 core を付ける)
npm run gen:types  # Rust の型から TypeScript の型を作り直す(src/backend/generated/)
```

### 大きな保管庫でのメモリを測る

```sh
cd core && cargo run --release --example memory -- <保管庫のフォルダ> <索引用の空のフォルダ>
```

保管庫を開く・ツリーを作る・検索する、の各段階のメモリ（macOS の physical footprint）と経過時間を表示します。


### 大きな保管庫での速さを測る

```sh
cd core && cargo run --release --example timing -- <保管庫のフォルダ> <索引用のフォルダ>
```

開く・ページの一覧・検索（1文字ずつ打ったとき）・最近のページ・読み直しにかかる時間を表示します。
### 本番用のアプリを作る

```sh
npm run build:app  # 本番用の Jot.app を作る(core を必ず使う)
```

- できたアプリは `src-tauri/target/release/bundle/macos/Jot.app` です。「アプリケーション」フォルダに入れて使います。

#### Linux（Ubuntu・GNOME）で作る

```sh
sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev librsvg2-dev libayatana-appindicator3-dev libxdo-dev libssl-dev
npx tauri build --features core --no-bundle   # src-tauri/target/release/jot ができる
```

- `⌘` のショートカットは `Ctrl` に読み替えます（`⌘K` → `Ctrl+K`）。画面の表記は `⌘` のままです。
- アプリのデータ用フォルダは `~/.local/share/app.jot.notes/` です。
- ゴミ箱は FreeDesktop のゴミ箱（`~/.local/share/Trash`）、ファイルやリンクを開くのは `xdg-open` を使います。
- Linux では使えないもの: PDF への書き出し（印刷ダイアログ）、ほかのアプリでコピーした画像の貼り付け（クリップボードを直接読む部分）。
- Dock がないので、閉じた（隠した）ウィンドウは、アプリをもう一度起動すると出し直します。
- 本番用のビルドでは、画面はいつも TauriBackend（core）を使います。Mock は開発中だけです。
- Cargo の機能 `core` を付けずに本番用にビルドする（`npx tauri build` など）と、ビルドの途中でエラーになって止まります。core なしでは何も保存できないアプリになるためです。
- Apple の署名と公証はしていません。自分の Mac でビルドして使う分には要りません。ほかの Mac に配るときは別に設定が要ります。

- `npm run app` は開発用サーバー（5173）も自分で起動します。`npm run dev` がすでに動いているときは、先に止めてください（ポートがぶつかります）。止めずに使うときは `npx tauri dev --config '{"build":{"beforeDevCommand":""}}'` で、動いているサーバーをそのまま使えます。アプリが起動している間も、ブラウザで http://localhost:5173 を開けます。
- `npm run app` では、アプリの中でも MockBackend で動きます。core はビルドしないので、core を編集している途中でも起動できます。
- `npm run app:core` では、TauriBackend から `src-tauri/src/vault.rs` のコマンドを通して core の `Vault` を呼びます。
- 最後に開いた保管庫の場所（`settings.json`）と、索引用のフォルダ（`index/<フォルダ名>-<場所から作った番号>/`）は、アプリのデータ用フォルダ（`~/Library/Application Support/app.jot.notes/`）に置きます。保管庫の中には何も作りません。
- 保管庫を選び直すときは、メニューの「ファイル」→「保管庫を開く…」を使います。
- Mock はウィンドウごとに別のメモリを持つので、クイックキャプチャのウィンドウはメインのウィンドウの Mock に取り込みを頼みます（`src/backend/mock-relay.ts`）。取り込むと、メインのウィンドウに変更が伝わり、Inbox を開いていれば読み直されます。
- クイックキャプチャのホットキーは `src/capture/shortcut.json` の1か所で決めています。Rust 側の登録も、画面の表示も、このファイルから読みます。`⌃Space` は macOS の入力ソースの切り替えと重なるので使いません。

### `core/` のテスト

`core/` は独立した Cargo のパッケージです。Rust 標準の `core` と名前がぶつかるので、パッケージ名は `jot-core` にしています。

```sh
cd core
cargo test                         # テストを実行する
cargo bench --bench large_vault    # 大きな保管庫（5,000 ページ）での速さを測る
```

- テストは `core/tests/` にあります。例を書いて確かめるテスト（`write_page.rs` など）と、proptest（入力を自動で大量に作って確かめる仕組み）を使うテスト（`*_props.rs`）があります。
- 速さの測定（`benches/large_vault.rs`）は `cargo test` では走りません。目安を超えても失敗にはせず、数値と目安を並べて表示します。

## フォルダの構成

```
src/
  backend/   バックエンドとの接続部
  editor/    Markdown のエディタ
  app/       画面の部品
  store/     アプリの状態
  lib/       小さな共通の処理
  capture/   クイックキャプチャのウィンドウ
  main.tsx   入口（URL の ?window=capture でクイックキャプチャの画面に振り分ける）
  index.css  共通のスタイル
src-tauri/   Tauri のアプリの殻（ウィンドウ、グローバルホットキー、メニュー、core とのつなぎ）
core/        Rust のバックエンド
```

### `src/backend`

画面の部品は Tauri を直接呼ばず、必ずここの `Backend` インターフェースを通します。

- `types.ts`：バックエンドとの契約です。`Backend` インターフェースと、やりとりする型（`TreeNode`、`PageMeta`、`WriteResult` など）、エラーの型 `BackendError` を決めています。`version` は受け取った値をそのまま次の `writePage` に渡す、`path` は加工しない、知らないエラーの種類が来ても落ちない、といった約束もここに書いてあります。
- `mock.ts`：MockBackend。メモリの中だけで動き、ブラウザ単体で使えます。
- `mock-data.ts`、`mock-samples.ts`：Mock の最初のデータと、表示の確認用のページです。
- `tauri.ts`：TauriBackend。Tauri の `invoke`（Rust の関数の呼び出し）とイベントを呼ぶだけの薄い層です。Rust 側との取り決め（コマンド名、エラーの形、`external-change` イベントなど）がファイルの先頭にあります。
- `generated/`：Rust の型（`src-tauri/src/ipc.rs`）から ts-rs（Rust の型から TypeScript の型を作る道具）で作った型です。手で直さず、`npm run gen:types` で作り直します。`types.ts` は、契約の型（`TreeNode`、`NodeKind`、`Snippet`、`SearchHit`、`WriteResult`、エラーの種類）としてこれをそのまま使います。`PageMeta` だけは、生成された `modifiedAt` が `bigint`（Rust の `u64`）なので契約は `number` のままにし、`tauri.ts` で数値にそろえます。
- `mock-relay.ts`：Tauri のアプリを Mock のまま動かすときに、クイックキャプチャのウィンドウからメインのウィンドウの Mock へ取り込みを中継します。
- `index.ts`：どのバックエンドを使うかを決め、`backend()` で返します。テスト用の `setBackend()` もあります。

エラーの通知には、バックエンド（core）の文をそのまま出しません。本文はエラーの種類ごとに `src/lib/error-text.ts` で日本語の文を決め、場面によって言い方を変えたいものだけ上書きします。バックエンドの文は、開発者ツールの記録（console）にだけ残します。

### `src/editor`

Milkdown を使った Markdown のエディタです。

- `MarkdownEditor.tsx`：エディタの本体の部品です。
- `session.ts`：1つのエディタの保存を受け持ちます（自動保存、衝突やエラーのときの通知）。
- `markdown.ts`：Markdown の読み込みと書き出しです。変えていないブロックを原文のまま書き戻す仕組みがここにあります。
- `slash.ts`、`EditorOverlays.tsx`：スラッシュコマンドと、エディタの上に出すメニュー（書式メニューなど）です。
- `block-move.ts`、`block-drag.ts`：ブロックの並べ替え（キーボードとドラッグ）です。
- `keys.ts`：追加のショートカットです。
- `plugins.ts`：コードの色付け、画像、チェックリスト、貼り付けなどの部品です。
- `mermaid.ts`：Mermaid の図を描く部品です。
- `page-link.ts`：`/page` で入れるページへのリンクの作り方です。
- `registry.ts`：いま表示しているエディタへの窓口です。ストアはここを通して「保存し終える」のを待ちます。
- `tracked-pos.ts`、`view-bridge.ts`：非同期の処理を待つ間の位置の追跡と、エディタの変化を React の部品に伝える仕組みです。
- `__tests__/`：往復テスト（`fixtures/` の Markdown を読み込み、何も編集せずに保存すると元と同じになるか）などのテストです。

### `src/app`

画面の部品です。

- `App.tsx`：全体の配置です。
- `Sidebar.tsx`：ページのツリーです（TanStack Virtual で、見えている行だけを描きます）。
- `PageView.tsx`、`PageTitle.tsx`：ページの表示と、その場で書き換えられるタイトルです。
- `ContextMenu.tsx`：右クリックなどで開く小さなメニューです。
- `CommandPalette.tsx`、`palette-store.ts`、`palette-search.ts`：コマンドパレットです。`palette-search.ts` は検索の順番を管理し、最後に確定した検索語の結果だけを表示に回します（古い問い合わせの結果が後から届いても捨てます）。
- `NoticeBar.tsx`：画面上部の通知（「他のアプリで変更されました」など）です。
- `EmptyState.tsx`：空の状態や例外の状態の表示です。次の画面で使います。
  - 初回起動（`FirstLaunch.tsx`）：保管庫のフォルダを選ぶ画面です。保管庫を読めなかったときも、通知で知らせてここに戻ります。
  - ページが1つもない：本文の場所に「まだページがありません」と、新規ページを作るボタンを出します。
  - 空のページ：本文が空のあいだ、1行目の下に書き始めの案内を出します（`src/editor/EditorOverlays.tsx`）。マウスの操作は下のエディタに通し、変換中は出しません。
  - 開けないページ（UTF-8 でないファイル）：エディタを出さずに「このファイルは開けません」を出します。

### `src/store`

- `app.ts`：Zustand のストアです。ページのツリー、最近のページ、開いているページ、通知、サイドバーの開閉などの状態と、保管庫を開く・ページを開く・作る・名前を変える・削除する・外部の変更に対応する、といった操作を持ちます。

### `src/lib`

- `paths.ts`：保管庫の中のパスの計算（相対パス、保管庫の外に出ないかの確認など）です。
- `keyboard.ts`：ショートカットと、日本語の変換中かどうかの判定（`isComposing`）です。
- `platform.ts`：ウィンドウを隠す・アプリを終了するときの保存など、Tauri とブラウザの違いを吸収します。
- `motion.ts`、`presence.ts`、`flip-rows.ts`：アニメーションの共通処理です。
- `cn.ts`：CSS のクラス名をまとめる小さな関数です。

### `src-tauri`

- `src/lib.rs`：ウィンドウ、メニュー、グローバルホットキー、閉じる・終了するときの流れです。
- `src/vault.rs`：契約の各操作に対応するコマンドです。core の `Vault` を呼ぶだけで、ロジックは書きません。呼び出しは別のスレッドで行い、画面と入力を止めません。core が panic しても、アプリは落とさずにエラーとして返します。保管庫のフォルダの監視もここです（変更を 300ms まとめてから `rescan` を呼び、`external-change` を出します。core の一時ファイルと隠しファイルの変更は除きます）。
- `src/ipc.rs`：フロントとの境界を越える型と、core のエラーの種類の対応づけです。core の型の欄はすべて名指しで取り出すので、core に欄が増えるとコンパイルが通らなくなります。
- `build.rs`：core の `Error` は `#[non_exhaustive]`（ほかのクレートからは種類を数えきれない印）なので、コンパイラは種類が増えても知らせてくれません。そこで、core のソースと `ipc.rs` の対応づけを突き合わせ、食い違えばビルドを止めます。
- core につなぐコードは、Cargo の機能 `core` を付けたときだけビルドします。

### `core`

- `src/lib.rs`：保管庫を扱う `Vault`（開く、ツリーを返す、読む、書く、作る、名前を変える、削除する、検索、最近のページ、Inbox への追記など）と、エラーの型です。
- `tests/`：上で書いたテストです。`tests/common/mod.rs` はテスト用の保管庫を組み立てる補助です。
- `benches/large_vault.rs`：速さの測定です。

## 設計の約束

### 打鍵の経路でバックエンドを呼ばない

文字を打ってから画面に出るまでの間に、バックエンドの呼び出しをはさみません。保存は入力とは関係なく、裏で行います（`src/editor/session.ts`）。

### 自動保存

- 最後の入力から 500ms 後に保存します（`SAVE_DELAY_MS`）。
- ページを切り替えたとき、ウィンドウを隠すとき、⌘Q で終了するとき、アプリが後ろに回ったときにも保存します（`src/lib/platform.ts`）。
  - Tauri では、隠すのも終了するのも、書き終えるまで待たせます。保存できない変更が残っていたら、終了をやめてメインのウィンドウを出します。
  - ⌘Q はメニューの自前の項目です。macOS の既定の「終了」は、その場でアプリを終えてしまい、保存を待てないためです。
  - Dock の「終了」やログアウトでは保存を待てません。その前にアプリが後ろに回ったときの保存で守ります。
  - ブラウザ（`npm run dev`）では待てないので、書き出しを始めるだけです。
- 保存は `writePage` に、読み込んだときの `version` を添えて行います。ほかのアプリで先に変更されていたら（衝突）、「再読み込み」か「自分の変更を保持」かを通知で尋ねます。

### 原文を残す書き出し

保存するとき、変えていないブロックは、読み込んだときの原文をそのまま書き出します。変えたブロックだけを Milkdown で書き出し直します（`src/editor/markdown.ts`）。

- ファイルの先頭の BOM（文字コードの印）とフロントマター（先頭の `---` で囲んだ設定の部分）は、エディタには出さず、保存のときにそのまま戻します。
- エディタで扱えない書き方（HTML のブロック、脚注など）は、編集できない部品として原文のまま表示し、原文のまま書き戻します。
- コールアウトとトグルは、Obsidian のコールアウトの書き方で保存します（`src/editor/callout.ts`）。Obsidian でもそのまま表示できます。
  - コールアウト：`> [!note] タイトル`（タイトルは省略できます）。2行目から後ろが本文です。
  - トグル：`> [!note]- タイトル`（折りたためるコールアウト）。トグル見出しは `> [!note|h2]- タイトル` のように、`|` の後ろに `h1`〜`h3` を書きます。
  - トグルの開閉はエディタの中だけの状態で、ファイルには書きません。読み込んだときは、`-` のトグルを閉じて、`+` のトグルを開いて表示します。
- ブロック数式は `$$` で囲んで保存します（TeX の原文を書くブロック。数式の描画はしません）。`$` 1つの行内の数式は読まないので、「$5 と $10」のような文は文字のままです。
- 何も編集せずに保存すると元のファイルと同じになることを、往復テストで確かめています（`src/editor/__tests__/roundtrip.test.ts`）。

### 日本語の変換中の規則

IME（日本語入力）で変換している最中は、確定前の文字やキーに反応しません。

- 変換中は保存も読み直しもしません。変換が終わってから行います。
- タイトルの書き換え、メニュー、サイドバーなどは、変換中のキー（確定の Enter や取り消しの Esc など）に反応しません。
- コマンドパレットは、変換中は検索せず直前の結果を出したままにし、確定した時点で検索します。変換確定の Enter では結果を開きません。
- 変換中に打った「/」ではスラッシュコマンドを開きません。変換して確定した「／」では開きます。メニューの絞り込みも、確定してから反映します。
- macOS の WKWebView（Tauri が使う表示部品）では、確定の Enter が `isComposing=false`、`keyCode=229` で届くことがあります。そのため変換中かどうかは両方を見て判定します（`src/lib/keyboard.ts` の `isComposing`）。

---

[README に戻る](../README.md)

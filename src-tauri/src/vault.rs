//! 契約の各操作に対応する Tauri のコマンド。core の Vault の関数を呼ぶだけで、ロジックは書かない。
//!
//! - core の呼び出しは spawn_blocking で別のスレッドに出す(重い処理でも画面の処理と入力を止めない)
//! - core の関数が panic しても、アプリは落とさずにエラーとして返す
//! - 最後に開いた保管庫の場所と、索引用のフォルダ(index_dir)は、アプリのデータ用フォルダに置く。保管庫の中には何も作らない
//! - 保管庫のフォルダを監視し、変更があれば短い間まとめてから rescan を呼び、フロントに知らせる

use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use std::{fs, thread};

use notify::{RecursiveMode, Watcher};
use jot_core::{SystemTrash, Vault, TEMP_FILE_PREFIX};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;

use crate::ipc::{IpcError, PageContent, PageMeta, SearchHit, TreeNode, WriteResult};

/// 外部の変更をフロントに知らせるイベント(src/backend/tauri.ts の EXTERNAL_CHANGE_EVENT と同じ)
pub(crate) const EXTERNAL_CHANGE_EVENT: &str = "external-change";
/// 監視で受けた変更を、この間だけ待ってまとめる(保存は一時ファイルへの書き込みと rename の2つの変更になる、など)
const WATCH_DEBOUNCE: Duration = Duration::from_millis(300);
/// アプリのデータ用フォルダの中の、設定のファイルと索引のフォルダ
const SETTINGS_FILE: &str = "settings.json";
const INDEX_DIR: &str = "index";

type CmdResult<T> = Result<T, IpcError>;

/// 開いている保管庫。監視は保管庫と一緒に持ち、別の保管庫を開いたら止める(drop で止まる)
struct Opened {
    root: PathBuf,
    vault: Arc<Vault>,
    _watcher: notify::RecommendedWatcher,
}

#[derive(Default)]
pub struct VaultState {
    opened: Mutex<Option<Opened>>,
    /// 最後にウィンドウへ落とされたファイル。save_dropped_files と open_attachment の確かめに使う
    dropped: Mutex<Vec<PathBuf>>,
}

impl VaultState {
    /// ウィンドウにファイルが落とされた(lib.rs のウィンドウのイベントから呼ぶ)
    pub fn remember_drop(&self, paths: &[PathBuf]) {
        if let Ok(mut dropped) = self.dropped.lock() {
            *dropped = paths.to_vec();
        }
    }

}

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Settings {
    /// 最後に開いた保管庫のフォルダ
    last_vault: Option<PathBuf>,
}

// ---- 保管庫を開く ----

/// 前回開いた保管庫。まだ開いていなければ、覚えている場所を開く。なければ null
#[tauri::command]
pub async fn current_vault(app: AppHandle, state: State<'_, VaultState>) -> CmdResult<Option<String>> {
    if let Some(root) = opened_root(&state) {
        return Ok(Some(display(&root)));
    }
    let Some(root) = load_settings(&app).last_vault else {
        return Ok(None);
    };
    open_at(&app, &state, root).await.map(Some)
}

/// フォルダ選択のダイアログを出し、選ばれたら開く。キャンセルなら null(開いている保管庫はそのまま)
#[tauri::command]
pub async fn open_vault(app: AppHandle, state: State<'_, VaultState>) -> CmdResult<Option<String>> {
    let mut dialog = app.dialog().file().set_title("保管庫のフォルダを選択");
    if let Some(root) = opened_root(&state) {
        dialog = dialog.set_directory(root);
    }
    // ダイアログを閉じるまで待つ処理は、画面の処理とは別のスレッドで行う
    let picked = tauri::async_runtime::spawn_blocking(move || dialog.blocking_pick_folder())
        .await
        .map_err(|e| IpcError::io(format!("フォルダ選択のダイアログを出せませんでした: {e}")))?;
    let Some(root) = picked.and_then(|p| p.into_path().ok()) else {
        return Ok(None);
    };
    open_at(&app, &state, root).await.map(Some)
}

async fn open_at(app: &AppHandle, state: &State<'_, VaultState>, root: PathBuf) -> CmdResult<String> {
    let index_dir = index_dir_for(app, &root)?;
    let opened_root = root.clone();
    // ゴミ箱は macOS のもの(core の SystemTrash)を渡す
    let vault = blocking(move || Vault::open_with_trash(&opened_root, &index_dir, Box::new(SystemTrash))).await?;
    let vault = Arc::new(vault);
    let watcher = watch(app.clone(), &root, vault.clone())?;
    // 画像などを表示用の URL(asset プロトコル)で読めるのは、保管庫の中だけにする
    app.asset_protocol_scope()
        .allow_directory(&root, true)
        .map_err(|e| IpcError::io(format!("保管庫のファイルを表示できるようにできませんでした: {e}")))?;
    *state.opened.lock().map_err(|_| IpcError::io("保管庫の状態を読めません"))? =
        Some(Opened { root: root.clone(), vault, _watcher: watcher });
    save_settings(app, &Settings { last_vault: Some(root.clone()) });
    Ok(display(&root))
}

// ---- ページの操作(core を呼ぶだけ) ----

#[tauri::command]
pub async fn list_tree(state: State<'_, VaultState>) -> CmdResult<Vec<TreeNode>> {
    let vault = vault(&state)?;
    let tree = blocking(move || vault.list_tree()).await?;
    Ok(tree.into_iter().map(Into::into).collect())
}

#[tauri::command]
pub async fn read_page(state: State<'_, VaultState>, path: String) -> CmdResult<PageContent> {
    let vault = vault(&state)?;
    let (content, version) = blocking(move || vault.read_page(&path)).await?;
    Ok(PageContent { content, version })
}

#[tauri::command]
pub async fn write_page(state: State<'_, VaultState>, path: String, content: String, base_version: String) -> CmdResult<WriteResult> {
    let vault = vault(&state)?;
    Ok(blocking(move || vault.write_page(&path, &content, &base_version)).await?.into())
}

#[tauri::command]
pub async fn create_page(state: State<'_, VaultState>, parent_path: Option<String>, title: String) -> CmdResult<PageMeta> {
    let vault = vault(&state)?;
    Ok(blocking(move || vault.create_page(parent_path.as_deref(), &title)).await?.into())
}

#[tauri::command]
pub async fn rename_page(state: State<'_, VaultState>, path: String, new_title: String) -> CmdResult<PageMeta> {
    let vault = vault(&state)?;
    Ok(blocking(move || vault.rename_page(&path, &new_title)).await?.into())
}

#[tauri::command]
pub async fn delete_page(state: State<'_, VaultState>, path: String) -> CmdResult<()> {
    let vault = vault(&state)?;
    blocking(move || vault.delete_page(&path)).await
}

#[tauri::command]
pub async fn create_folder(state: State<'_, VaultState>, parent_path: Option<String>, name: String) -> CmdResult<String> {
    let vault = vault(&state)?;
    blocking(move || vault.create_folder(parent_path.as_deref(), &name)).await
}

#[tauri::command]
pub async fn rename_folder(state: State<'_, VaultState>, path: String, new_name: String) -> CmdResult<String> {
    let vault = vault(&state)?;
    blocking(move || vault.rename_folder(&path, &new_name)).await
}

/// ページに貼り付けた画像などを保存し、ページから見た相対パスを返す。
/// 画像の中身は JSON の数の並びにすると大きく遅くなるので、生のバイト列(本文)で受け取る。
/// ページの path とファイル名は、ヘッダー x-page / x-name に URL エンコードして入れてもらう。
#[tauri::command]
pub async fn save_attachment(state: State<'_, VaultState>, request: tauri::ipc::Request<'_>) -> CmdResult<String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err(IpcError::io("ファイルの中身がバイト列で届いていません"));
    };
    let header = |name: &str| -> CmdResult<String> {
        let raw = request.headers().get(name).and_then(|v| v.to_str().ok()).ok_or_else(|| IpcError::io(format!("{name} がありません")))?;
        percent_decode(raw).ok_or_else(|| IpcError::io(format!("{name} を読めません")))
    };
    let (page, name, bytes) = (header("x-page")?, header("x-name")?, bytes.clone());
    let vault = vault(&state)?;
    blocking(move || vault.save_attachment(&page, &name, &bytes)).await
}

/// クリップボードのファイルや画像を、ページの子フォルダに保存する(⌘V でページにファイルが届かなかったとき)。
/// 返すのは保存したファイルの相対パス(save_attachment と同じ)。なければ空。`stem` はスクリーンショットなどの名前
#[tauri::command]
pub async fn paste_clipboard_files(state: State<'_, VaultState>, page_path: String, stem: String) -> CmdResult<Vec<String>> {
    let vault = vault(&state)?;
    blocking(move || crate::clipboard::files(&stem).into_iter().map(|file| vault.save_attachment(&page_path, &file.name, &file.bytes)).collect())
        .await
}

/// ウィンドウに落とされたファイル(PDF・写真・HTML など)を、ページの子フォルダに保存する。返すのは保存したファイルの相対パス。
/// 読むのは、実際にウィンドウへ落とされたファイルだけ(フロントが別のファイルを指しても読まない)。フォルダは除く
#[tauri::command]
pub async fn save_dropped_files(state: State<'_, VaultState>, page_path: String, paths: Vec<String>) -> CmdResult<Vec<String>> {
    let dropped = state.dropped.lock().map_err(|_| IpcError::io("落とされたファイルを読めません"))?.clone();
    let files: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).filter(|p| dropped.contains(p)).collect();
    let vault = vault(&state)?;
    blocking(move || {
        files
            .iter()
            .filter_map(|path| crate::clipboard::read_file(path))
            .map(|file| vault.save_attachment(&page_path, &file.name, &file.bytes))
            .collect()
    })
    .await
}

/// 保管庫の中のフォルダ(x-folder。「添付/2026-11-17」の形)にファイルを保存し、保管庫から見た path を返す。
/// 途中のフォルダが無ければ作る。中身は save_attachment と同じく生のバイト列で受け取り、フォルダと名前はヘッダーに入れてもらう
/// 保管庫の中のフォルダ(「メモ/2026-11-17」など)に、新しいページを作って中身を書き、保管庫から見た path を返す。
/// 途中のフォルダは作り、同じ名前があれば「 2」から番号を付ける
#[tauri::command]
pub async fn save_page(state: State<'_, VaultState>, folder: String, title: String, content: String) -> CmdResult<String> {
    let vault = vault(&state)?;
    blocking(move || vault.save_page(&folder, &title, &content)).await
}

#[tauri::command]
pub async fn save_file(state: State<'_, VaultState>, request: tauri::ipc::Request<'_>) -> CmdResult<String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err(IpcError::io("ファイルの中身がバイト列で届いていません"));
    };
    let header = |name: &str| -> CmdResult<String> {
        let raw = request.headers().get(name).and_then(|v| v.to_str().ok()).ok_or_else(|| IpcError::io(format!("{name} がありません")))?;
        percent_decode(raw).ok_or_else(|| IpcError::io(format!("{name} を読めません")))
    };
    let (folder, name, bytes) = (header("x-folder")?, header("x-name")?, bytes.clone());
    let vault = vault(&state)?;
    blocking(move || vault.save_file(&folder, &name, &bytes)).await
}

/// ファイルの名前と中身を、1 つのバイト列に並べる(JSON の数の並びにすると大きな画像で遅いので)。
/// 形は、ファイルごとに「名前のバイト数(u32 LE)・名前(UTF-8)・中身のバイト数(u32 LE)・中身」。src/backend/tauri.ts の unpackFiles が読む
fn pack_files(files: &[crate::clipboard::ClipFile]) -> Vec<u8> {
    let mut out = Vec::with_capacity(files.iter().map(|f| f.name.len() + f.bytes.len() + 8).sum());
    for file in files {
        out.extend_from_slice(&(file.name.len() as u32).to_le_bytes());
        out.extend_from_slice(file.name.as_bytes());
        out.extend_from_slice(&(file.bytes.len() as u32).to_le_bytes());
        out.extend_from_slice(&file.bytes);
    }
    out
}

/// クリップボードのファイルや画像を読んで、保存せずに返す(保存前のプレビュー)。なければ空。`stem` は画像のデータの名前
#[tauri::command]
pub async fn read_clipboard_files(stem: String) -> CmdResult<tauri::ipc::Response> {
    blocking(move || Ok(tauri::ipc::Response::new(pack_files(&crate::clipboard::files(&stem))))).await
}

/// ウィンドウに落とされたファイルを読んで、保存せずに返す(保存前のプレビュー)。
/// 読むのは、実際にウィンドウへ落とされたファイルだけ(save_dropped_files と同じ)
#[tauri::command]
pub async fn read_dropped_files(state: State<'_, VaultState>, paths: Vec<String>) -> CmdResult<tauri::ipc::Response> {
    let dropped = state.dropped.lock().map_err(|_| IpcError::io("落とされたファイルを読めません"))?.clone();
    let files: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).filter(|p| dropped.contains(p)).collect();
    blocking(move || Ok(tauri::ipc::Response::new(pack_files(&files.iter().filter_map(|p| crate::clipboard::read_file(p)).collect::<Vec<_>>())))).await
}

/// そのまま開いてよいファイルの拡張子(書類・画像・音や動画)。ほかのもの(アプリやスクリプトなど、開くと動いてしまうもの)は、
/// 開かずに Finder で場所を見せる
const OPENABLE_EXTS: &[&str] = &[
    "pdf", "html", "htm", "txt", "md", "csv", "tsv", "json", "xml", "rtf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "pages", "numbers", "key",
    "png", "jpg", "jpeg", "gif", "webp", "heic", "heif", "tif", "tiff", "bmp", "svg", "avif", "mp3", "m4a", "wav", "aac", "flac", "mp4", "mov",
    "m4v", "webm", "zip",
];

/// 保管庫の中のファイル(path は保管庫のルートからの相対)を、Mac で決まっているアプリで開く(PDF ならプレビュー、HTML ならブラウザ)。
/// 開くと動いてしまう種類のファイルは、Finder で場所を見せるだけにする。保管庫の外は開かない
#[tauri::command]
pub async fn open_attachment(state: State<'_, VaultState>, path: String) -> CmdResult<()> {
    let root = opened_root(&state).ok_or_else(|| IpcError::io("保管庫がまだ開かれていません"))?;
    let root = fs::canonicalize(&root).map_err(|e| IpcError::io(e.to_string()))?;
    let file = fs::canonicalize(root.join(&path)).map_err(|_| IpcError::io("ファイルが見つかりません"))?;
    if !file.starts_with(&root) || !file.is_file() {
        return Err(IpcError::io("保管庫の中のファイルではありません"));
    }
    let ext = file.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).unwrap_or_default();
    let status = if OPENABLE_EXTS.contains(&ext.as_str()) { crate::sysopen::open(&file) } else { crate::sysopen::reveal(&file) }.map_err(|e| IpcError::io(e.to_string()))?;
    if status.success() {
        Ok(())
    } else {
        Err(IpcError::io("ファイルを開けませんでした"))
    }
}

/// ページの外のリンクを、Mac で決まっているアプリ(既定のブラウザなど)で開く。
/// 開けるのは http・https・mailto だけ(file: やアプリを開く URL は渡さない)。フロントの isExternalUrl と同じ決まり
#[tauri::command]
pub fn open_external_url(url: String) -> CmdResult<()> {
    if !is_external_url(&url) {
        return Err(IpcError { kind: crate::ipc::ErrorKind::InvalidPath, message: "http・https・mailto のリンクではありません".into() });
    }
    let status = crate::sysopen::open(&url).map_err(|e| IpcError::io(e.to_string()))?;
    if status.success() {
        Ok(())
    } else {
        Err(IpcError::io("リンクを開けませんでした"))
    }
}

fn is_external_url(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    let rest = ["https://", "http://", "mailto:"].iter().find_map(|p| lower.strip_prefix(p));
    matches!(rest, Some(r) if !r.is_empty()) && !url.chars().any(|c| c.is_whitespace() || c.is_control())
}

/// %XX を戻す(encodeURIComponent の逆)。UTF-8 にならなければ None
fn percent_decode(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            out.push(u8::from_str_radix(std::str::from_utf8(&bytes[i + 1..i + 3]).ok()?, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

#[tauri::command]
pub async fn move_page(state: State<'_, VaultState>, path: String, parent_path: Option<String>) -> CmdResult<PageMeta> {
    let vault = vault(&state)?;
    Ok(blocking(move || vault.move_page(&path, parent_path.as_deref())).await?.into())
}

#[tauri::command]
pub async fn move_folder(state: State<'_, VaultState>, path: String, parent_path: Option<String>) -> CmdResult<String> {
    let vault = vault(&state)?;
    blocking(move || vault.move_folder(&path, parent_path.as_deref())).await
}

#[tauri::command]
pub async fn delete_folder(state: State<'_, VaultState>, path: String) -> CmdResult<()> {
    let vault = vault(&state)?;
    blocking(move || vault.delete_folder(&path)).await
}

#[tauri::command]
pub async fn search(state: State<'_, VaultState>, query: String, limit: usize) -> CmdResult<Vec<SearchHit>> {
    let vault = vault(&state)?;
    let hits = blocking(move || vault.search(&query, limit)).await?;
    Ok(hits.into_iter().map(Into::into).collect())
}

#[tauri::command]
pub async fn recent_pages(state: State<'_, VaultState>, limit: usize) -> CmdResult<Vec<PageMeta>> {
    let vault = vault(&state)?;
    let pages = blocking(move || vault.recent_pages(limit)).await?;
    Ok(pages.into_iter().map(Into::into).collect())
}

/// Inbox に書き足し、メインのウィンドウに変更を知らせる(Inbox を開いていれば読み直される)
#[tauri::command]
pub async fn capture_to_inbox(app: AppHandle, state: State<'_, VaultState>, text: String) -> CmdResult<()> {
    let vault = vault(&state)?;
    blocking(move || vault.capture_to_inbox(&text)).await?;
    let _ = app.emit(EXTERNAL_CHANGE_EVENT, ());
    Ok(())
}

// ---- 下回り ----

fn opened_root(state: &State<'_, VaultState>) -> Option<PathBuf> {
    state.opened.lock().ok()?.as_ref().map(|o| o.root.clone())
}

fn vault(state: &State<'_, VaultState>) -> CmdResult<Arc<Vault>> {
    let opened = state.opened.lock().map_err(|_| IpcError::io("保管庫の状態を読めません"))?;
    opened.as_ref().map(|o| o.vault.clone()).ok_or_else(|| IpcError::io("保管庫がまだ開かれていません"))
}

/// core の呼び出しを、画面の処理とは別のスレッドで行う。panic(未実装など)はエラーにして返す
async fn blocking<T, F>(f: F) -> CmdResult<T>
where
    F: FnOnce() -> jot_core::Result<T> + Send + 'static,
    T: Send + 'static,
{
    match tauri::async_runtime::spawn_blocking(f).await {
        Ok(result) => result.map_err(Into::into),
        Err(e) => Err(IpcError::io(format!("バックエンドの処理が途中で止まりました: {e}"))),
    }
}

fn display(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn data_dir(app: &AppHandle) -> CmdResult<PathBuf> {
    app.path().app_data_dir().map_err(|e| IpcError::io(format!("アプリのデータ用フォルダが分かりません: {e}")))
}

fn load_settings(app: &AppHandle) -> Settings {
    data_dir(app)
        .ok()
        .and_then(|dir| fs::read(dir.join(SETTINGS_FILE)).ok())
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

/// 設定を覚える。書けなくても保管庫は使えるので、知らせるだけにする
fn save_settings(app: &AppHandle, settings: &Settings) {
    let result = data_dir(app).map_err(|e| e.message).and_then(|dir| {
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let json = serde_json::to_vec_pretty(settings).map_err(|e| e.to_string())?;
        fs::write(dir.join(SETTINGS_FILE), json).map_err(|e| e.to_string())
    });
    if let Err(e) = result {
        eprintln!("最後に開いた保管庫を覚えられませんでした: {e}");
    }
}

/// 保管庫ごとの索引用のフォルダ。<データ用フォルダ>/index/<フォルダ名>-<場所から作った番号>
/// (同じ名前の別の場所の保管庫と混ざらないように、場所から番号を作る。作るのは core の open)
fn index_dir_for(app: &AppHandle, root: &Path) -> CmdResult<PathBuf> {
    let key = fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    let name: String = key
        .file_name()
        .map(|n| n.to_string_lossy().chars().map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).collect())
        .unwrap_or_else(|| "vault".to_string());
    Ok(data_dir(app)?.join(INDEX_DIR).join(format!("{name}-{:016x}", fnv1a(key.to_string_lossy().as_bytes()))))
}

/// 保管庫の場所から番号を作る(Rust の版が変わっても同じ値になるように、ハッシュは自前で持つ)
fn fnv1a(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf2_9ce4_8422_2325, |hash, b| (hash ^ u64::from(*b)).wrapping_mul(0x0000_0100_0000_01b3))
}

// ---- 外部の変更の監視 ----

/// 保管庫のフォルダを監視する。変更は WATCH_DEBOUNCE の間まとめ、関係のある変更があれば rescan してからフロントに知らせる
fn watch(app: AppHandle, root: &Path, vault: Arc<Vault>) -> CmdResult<notify::RecommendedWatcher> {
    // macOS の監視は実体の場所(/private/var など)で届くので、比べるほうもそろえる
    let base = fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    let (tx, rx) = mpsc::channel::<notify::Result<notify::Event>>();
    let mut watcher = notify::recommended_watcher(tx).map_err(|e| IpcError::io(format!("保管庫を監視できません: {e}")))?;
    watcher
        .watch(root, RecursiveMode::Recursive)
        .map_err(|e| IpcError::io(format!("保管庫を監視できません: {e}")))?;

    thread::spawn(move || {
        // watcher が drop されると送り手がなくなり、recv が失敗してこのスレッドも終わる
        while let Ok(first) = rx.recv() {
            let mut relevant = is_relevant(&base, &first);
            loop {
                match rx.recv_timeout(WATCH_DEBOUNCE) {
                    Ok(event) => relevant |= is_relevant(&base, &event),
                    Err(RecvTimeoutError::Timeout) => break,
                    Err(RecvTimeoutError::Disconnected) => return,
                }
            }
            if !relevant {
                continue;
            }
            // panic しても、監視は続ける
            let rescanned = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| vault.rescan()));
            match rescanned {
                Ok(Ok(())) => {}
                Ok(Err(e)) => eprintln!("保管庫の読み直し(rescan)に失敗しました: {e}"),
                Err(_) => eprintln!("保管庫の読み直し(rescan)が途中で止まりました"),
            }
            let _ = app.emit(EXTERNAL_CHANGE_EVENT, ());
        }
    });
    Ok(watcher)
}

/// 知らせる必要のある変更か。core の一時ファイルと、隠しファイル(隠しフォルダの中を含む)の変更は除く
fn is_relevant(base: &Path, event: &notify::Result<notify::Event>) -> bool {
    let Ok(event) = event else {
        // 監視そのものの失敗(取りこぼしなど)は、念のため読み直す
        return true;
    };
    event.paths.iter().any(|path| {
        let Ok(rel) = path.strip_prefix(base) else {
            return true;
        };
        !rel.components().any(|c| {
            let name = c.as_os_str().to_string_lossy();
            name.starts_with(TEMP_FILE_PREFIX) || name.starts_with('.')
        })
    })
}

#[cfg(test)]
mod tests {
    #[test]
    fn external_url_only_web_and_mail() {
        assert!(super::is_external_url("https://github.com/a/b/pull/1"));
        assert!(super::is_external_url("HTTP://example.com"));
        assert!(super::is_external_url("mailto:a@example.com"));
        assert!(!super::is_external_url("https://"));
        assert!(!super::is_external_url("file:///etc/passwd"));
        assert!(!super::is_external_url("x-apple.systempreferences:"));
        assert!(!super::is_external_url("-a Calculator"));
        assert!(!super::is_external_url("https://a.com/ b"));
        assert!(!super::is_external_url("https://a.com/\nb"));
    }

    use super::*;

    fn event(paths: &[&str]) -> notify::Result<notify::Event> {
        let mut e = notify::Event::new(notify::EventKind::Any);
        e.paths = paths.iter().map(PathBuf::from).collect();
        Ok(e)
    }

    #[test]
    fn 一時ファイルと隠しファイルの変更は知らせない() {
        let base = Path::new("/v");
        assert!(!is_relevant(base, &event(&[&format!("/v/a/{TEMP_FILE_PREFIX}123")])));
        assert!(!is_relevant(base, &event(&["/v/.DS_Store"])));
        assert!(!is_relevant(base, &event(&["/v/.git/index"])));
        assert!(is_relevant(base, &event(&["/v/日記/今日.md"])));
        assert!(is_relevant(base, &event(&["/v/.DS_Store", "/v/a.md"])));
    }

    #[test]
    fn 索引のフォルダの名前は場所ごとに変わり_同じ場所なら同じ() {
        assert_eq!(fnv1a(b"/Users/a/notes"), fnv1a(b"/Users/a/notes"));
        assert_ne!(fnv1a(b"/Users/a/notes"), fnv1a(b"/Users/b/notes"));
    }
}

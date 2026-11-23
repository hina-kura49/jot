//! ページを HTML 1枚に書き出す。中身(本文・画像・見た目を詰め込んだ HTML)はフロントが作り、
//! ここでは保存先を尋ねて書き込むだけ。

use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;

/// 保存先を尋ねて `html` を書き込み、書き込んだ場所を返す。やめたら None
#[tauri::command]
pub async fn save_html(app: AppHandle, file_name: String, html: String) -> Result<Option<String>, String> {
    let mut dialog = app.dialog().file().set_title("HTML に書き出す").set_file_name(&file_name).add_filter("HTML", &["html"]);
    if let Ok(downloads) = app.path().download_dir() {
        dialog = dialog.set_directory(downloads);
    }
    let picked = tauri::async_runtime::spawn_blocking(move || dialog.blocking_save_file()).await.map_err(|e| e.to_string())?;
    let Some(path) = picked else {
        return Ok(None);
    };
    let path = path.into_path().map_err(|e| e.to_string())?;
    std::fs::write(&path, html).map_err(|e| e.to_string())?;
    Ok(Some(path.display().to_string()))
}

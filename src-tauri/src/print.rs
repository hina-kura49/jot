//! PDF に書き出す。macOS の印刷ダイアログを開き、左下の「PDF」から保存してもらう。
//! WKWebView では window.print() が何もしないので、WKWebView の印刷の仕組みをここから呼ぶ。
//! 見た目はフロントの @media print(index.css)で整える。

use tauri::Webview;

/// 紙の余白(ポイント。1mm ≒ 2.83pt)。上下 18mm、左右 16mm
const MARGIN_VERTICAL: f64 = 51.0;
const MARGIN_HORIZONTAL: f64 = 45.0;

/// 印刷ダイアログを開く。`title` は保存するファイル名の候補になる
#[tauri::command]
pub fn print_page(webview: Webview, title: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        webview.with_webview(move |platform| unsafe { open_dialog(platform.inner(), platform.ns_window(), &title) }).map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (webview, title);
        Err("PDF への書き出しは macOS だけで使えます".into())
    }
}

/// メインスレッドで呼ばれる(with_webview)
#[cfg(target_os = "macos")]
unsafe fn open_dialog(webview: *mut std::ffi::c_void, window: *mut std::ffi::c_void, title: &str) {
    use objc2_app_kit::{NSPrintInfo, NSWindow};
    use objc2_foundation::{NSCopying, NSString};
    use objc2_web_kit::WKWebView;

    let (Some(webview), Some(window)) = ((webview as *const WKWebView).as_ref(), (window as *const NSWindow).as_ref()) else {
        return;
    };
    // 共有の設定を書き換えないよう、写しを使う
    let info = NSPrintInfo::sharedPrintInfo().copy();
    info.setTopMargin(MARGIN_VERTICAL);
    info.setBottomMargin(MARGIN_VERTICAL);
    info.setLeftMargin(MARGIN_HORIZONTAL);
    info.setRightMargin(MARGIN_HORIZONTAL);
    let operation = webview.printOperationWithPrintInfo(&info);
    operation.setJobTitle(Some(&NSString::from_str(title)));
    // WKWebView の印刷は、表示の大きさが決まっていないと白紙になることがある
    if let Some(view) = operation.view() {
        view.setFrame(webview.bounds());
    }
    operation.setCanSpawnSeparateThread(true);
    operation.runOperationModalForWindow_delegate_didRunSelector_contextInfo(window, None, None, std::ptr::null_mut());
}

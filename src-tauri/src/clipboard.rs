//! クリップボードのファイルや画像を読む(⌘V で貼るとき)。
//! WKWebView は、Finder でコピーしたファイルや、ほかのアプリでコピーした画像を、
//! ページの貼り付けのイベントに渡さないことがある。そのときは、macOS のクリップボードをここで直接読む。

/// 1つのファイルの大きさの上限(フロントと同じ 100MB)
const MAX_BYTES: u64 = 100 * 1024 * 1024;

/// クリップボードのファイル。name は保存するときの名前(拡張子つき)
pub struct ClipFile {
    pub name: String,
    pub bytes: Vec<u8>,
}

/// クリップボードにあるファイルを返す。コピーされたファイル(PDF・写真・HTML など)があればそのファイルを、
/// なければ画像のデータ(スクリーンショットなど)を PNG などにして返す。データの画像の名前は `stem` を使う。
/// なければ空。フォルダと、上限を超えるファイルは除く
pub fn files(stem: &str) -> Vec<ClipFile> {
    #[cfg(target_os = "macos")]
    {
        mac::files(stem)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = stem;
        Vec::new()
    }
}

/// ファイルを読む。フォルダ・大きすぎる・読めないなら None(⌘V のファイルと、ドロップしたファイルで使う)
pub fn read_file(path: &std::path::Path) -> Option<ClipFile> {
    let name = path.file_name()?.to_str()?.to_owned();
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > MAX_BYTES {
        return None;
    }
    Some(ClipFile { name, bytes: std::fs::read(path).ok()? })
}

#[cfg(target_os = "macos")]
mod mac {
    use std::path::Path;

    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSPasteboard, NSPasteboardTypeFileURL, NSPasteboardTypePNG, NSPasteboardTypeTIFF};
    use objc2_foundation::{NSDictionary, NSString, NSURL};

    use super::{ClipFile, MAX_BYTES};

    pub fn files(stem: &str) -> Vec<ClipFile> {
        let pasteboard = NSPasteboard::generalPasteboard();

        // コピーされたファイル(Finder など)。ファイルにはアイコンの画像も付いてくるので、先に見る。
        // ファイルがあれば、アイコンは貼らない(フォルダだけのときも何も貼らない)
        let urls: Vec<_> = pasteboard
            .pasteboardItems()
            .map(|items| items.iter().filter_map(|item| item.stringForType(unsafe { NSPasteboardTypeFileURL })).collect())
            .unwrap_or_default();
        if !urls.is_empty() {
            return urls.iter().filter_map(|url| read_url(url)).collect();
        }

        // 画像のデータ(スクリーンショット、ブラウザやプレビューでのコピーなど)
        let typed = |uti: &str| pasteboard.dataForType(&NSString::from_str(uti)).map(|d| d.to_vec());
        let data = if let Some(png) = pasteboard.dataForType(unsafe { NSPasteboardTypePNG }) {
            Some((png.to_vec(), "png"))
        } else if let Some(jpeg) = typed("public.jpeg") {
            Some((jpeg, "jpg"))
        } else if let Some(heic) = typed("public.heic") {
            Some((heic, "heic"))
        } else {
            // TIFF はブラウザで表示できないことがあるので、PNG にする
            pasteboard.dataForType(unsafe { NSPasteboardTypeTIFF }).and_then(|tiff| {
                let rep = NSBitmapImageRep::imageRepWithData(&tiff)?;
                let png = unsafe { rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &NSDictionary::new()) }?;
                Some((png.to_vec(), "png"))
            })
        };
        data.filter(|(bytes, _)| bytes.len() as u64 <= MAX_BYTES)
            .map(|(bytes, ext)| vec![ClipFile { name: format!("{stem}.{ext}"), bytes }])
            .unwrap_or_default()
    }

    /// file:// の URL のファイルを読む。フォルダ・大きすぎる・読めないなら None
    fn read_url(url: &NSString) -> Option<ClipFile> {
        let path = NSURL::URLWithString(url)?.path()?.to_string();
        super::read_file(Path::new(&path))
    }
}

#[cfg(test)]
mod tests {
    /// 手で確かめる: クリップボードにファイルか画像を入れてから `cargo test --features core clipboard -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn print_clipboard_files() {
        for file in super::files("画像") {
            println!("{} {} bytes {:02x?}", file.name, file.bytes.len(), &file.bytes[..8.min(file.bytes.len())]);
        }
    }
}

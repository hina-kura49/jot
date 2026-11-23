//! OS で決まっているアプリで開く・ファイルの場所を見せる。
//! macOS は /usr/bin/open、Linux は xdg-open(場所を見せるのはファイルマネージャーの D-Bus の口、だめなら親フォルダを開く)。

use std::ffi::OsStr;
use std::path::Path;
use std::process::{Command, ExitStatus};

/// URL やファイルを、OS で決まっているアプリで開く
pub fn open(target: impl AsRef<OsStr>) -> std::io::Result<ExitStatus> {
    #[cfg(target_os = "macos")]
    {
        Command::new("/usr/bin/open").arg(target).status()
    }
    #[cfg(not(target_os = "macos"))]
    {
        Command::new("xdg-open").arg(target).status()
    }
}

/// ファイルを開かずに、ファイルマネージャーで場所を見せる
pub fn reveal(file: &Path) -> std::io::Result<ExitStatus> {
    #[cfg(target_os = "macos")]
    {
        Command::new("/usr/bin/open").arg("-R").arg(file).status()
    }
    #[cfg(not(target_os = "macos"))]
    {
        // file:// の URL は、パスの各部分をパーセントエンコードして作る
        let uri = format!("file://{}", file.to_string_lossy().split('/').map(encode_segment).collect::<Vec<_>>().join("/"));
        let shown = Command::new("gio")
            .args(["call", "--session", "--dest", "org.freedesktop.FileManager1", "--object-path", "/org/freedesktop/FileManager1", "--method", "org.freedesktop.FileManager1.ShowItems"])
            .arg(format!("['{}']", uri.replace('\'', "%27")))
            .arg("")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
        match shown {
            Ok(status) if status.success() => Ok(status),
            _ => open(file.parent().unwrap_or(file)),
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn encode_segment(segment: &str) -> String {
    let mut out = String::new();
    for b in segment.bytes() {
        if b.is_ascii_alphanumeric() || b"-._~".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

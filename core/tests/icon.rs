//! ページのアイコン: フロントマターの `icon:` を list_tree の節点に載せる。

mod common;

use common::*;

fn icon(v: &TestVault, path: &str) -> Option<String> {
    find(&v.list_tree().unwrap(), path).unwrap().icon.clone()
}

#[test]
fn icon_is_read_from_frontmatter() {
    let v = VaultBuilder::new()
        .file("a.md", "---\ntitle: x\nicon: 📝\n---\n本文\n")
        .file("b.md", "---\nicon: \"🚀\"\n---\n")
        .file("c.md", "本文だけ\n")
        .file("d.md", "本文\n---\nicon: 📝\n---\n")
        .file("e.md", "\u{FEFF}---\r\nicon: 🌱\r\n---\r\n")
        .open();
    assert_eq!(icon(&v, "a.md").as_deref(), Some("📝"));
    assert_eq!(icon(&v, "b.md").as_deref(), Some("🚀"));
    assert_eq!(icon(&v, "c.md"), None);
    // 先頭にないものはフロントマターではない
    assert_eq!(icon(&v, "d.md"), None);
    assert_eq!(icon(&v, "e.md").as_deref(), Some("🌱"));
}

#[test]
fn icon_follows_writes_and_survives_reopen() {
    let mut v = VaultBuilder::new().file("a.md", "").open();
    let (_, version) = v.read_page("a.md").unwrap();
    v.write_page("a.md", "---\nicon: 📚\n---\n", &version).unwrap();
    assert_eq!(icon(&v, "a.md").as_deref(), Some("📚"));
    v.reopen();
    assert_eq!(icon(&v, "a.md").as_deref(), Some("📚"));
}

#[test]
fn folders_have_no_icon() {
    let v = VaultBuilder::new().dir("f").open();
    assert_eq!(icon(&v, "f"), None);
}

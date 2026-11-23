//! save_attachment: ページに貼り付けた画像を、ページの子フォルダに保存する。

mod common;

use common::*;

#[test]
fn saves_into_page_child_folder_and_returns_relative_path() {
    let v = VaultBuilder::new().file("f/メモ.md", "").open();

    let src = v.save_attachment("f/メモ.md", "スクリーンショット.PNG", b"png").unwrap();

    assert_eq!(src, "メモ/スクリーンショット.png");
    assert_eq!(v.disk_bytes("f/メモ/スクリーンショット.png"), b"png");
    // 画像だけの子フォルダは、ページの子としては出ない
    let tree = v.list_tree().unwrap();
    assert!(find(&tree, "f/メモ.md").unwrap().children.is_empty());
}

#[test]
fn numbers_names_already_taken() {
    let v = VaultBuilder::new().file("a.md", "").file("a/image.png", "old").open();
    assert_eq!(v.save_attachment("a.md", "image.png", b"new").unwrap(), "a/image 2.png");
    assert_eq!(v.save_attachment("a.md", "image.png", b"new").unwrap(), "a/image 3.png");
    assert_eq!(v.disk_bytes("a/image.png"), b"old");
}

#[test]
fn processes_name_like_title() {
    let v = VaultBuilder::new().file("a.md", "").open();
    assert_eq!(v.save_attachment("a.md", "x/y.jpeg", b"").unwrap(), "a/x-y.jpeg");
    assert_eq!(v.save_attachment("a.md", ".png", b"").unwrap(), "a/-png");
}

#[test]
fn child_pages_stay_shown() {
    let v = VaultBuilder::new().file("a.md", "").file("a/b.md", "").open();
    v.save_attachment("a.md", "i.png", b"").unwrap();
    assert_eq!(all_paths(&v.list_tree().unwrap()), ["a.md", "a/b.md"].map(String::from).into());
}

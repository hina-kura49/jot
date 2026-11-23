//! create_folder / rename_folder / delete_folder と、ページのない Folder の節点。

mod common;

use common::*;
use jot_core::{Error, NodeKind};

fn text(v: &TestVault, rel: &str) -> String {
    String::from_utf8(v.disk_bytes(rel)).unwrap()
}

// ================================================================ create_folder

#[test]
fn create_folder_makes_empty_folder_shown_in_tree() {
    let v = VaultBuilder::new().file("a.md", "").open();

    let path = v.create_folder(None, "資料").unwrap();

    assert_eq!(path, "資料");
    assert!(v.root().join("資料").is_dir());
    let tree = v.list_tree().unwrap();
    let node = find(&tree, "資料").unwrap();
    assert_eq!(node.kind, NodeKind::Folder);
    assert!(node.children.is_empty());
}

#[test]
fn create_folder_inside_folder_and_page() {
    let v = VaultBuilder::new().file("a.md", "").dir("f").open();

    assert_eq!(v.create_folder(Some("f"), "g").unwrap(), "f/g");
    // ページの中に作ると、ページの子フォルダ(a/)の中にできる。
    assert_eq!(v.create_folder(Some("a.md"), "h").unwrap(), "a/h");

    let tree = v.list_tree().unwrap();
    assert_eq!(
        all_paths(&tree),
        ["a.md", "a/h", "f", "f/g"].map(String::from).into()
    );
}

#[test]
fn create_folder_numbers_name_taken_by_folder_or_page() {
    let v = VaultBuilder::new().file("メモ.md", "").dir("資料").open();

    assert_eq!(v.create_folder(None, "資料").unwrap(), "資料 2");
    // 同名のページがあると、そのページの子フォルダになってしまうので避ける。
    assert_eq!(v.create_folder(None, "メモ").unwrap(), "メモ 2");
}

#[test]
fn create_folder_processes_name_like_title() {
    let v = VaultBuilder::new().open();
    assert_eq!(v.create_folder(None, "  a/b  ").unwrap(), "a-b");
    assert_eq!(v.create_folder(None, "").unwrap(), "無題");
}

#[test]
fn create_folder_rejects_folder_with_only_attachments_as_parent() {
    let v = VaultBuilder::new().file("画像/x.png", "png").open();
    assert!(matches!(
        v.create_folder(Some("画像"), "a"),
        Err(Error::NotAPage(_))
    ));
}

#[test]
fn created_folder_survives_reopen() {
    let mut v = VaultBuilder::new().open();
    v.create_folder(None, "空").unwrap();
    v.reopen();
    assert_eq!(all_paths(&v.list_tree().unwrap()), ["空".to_string()].into());
}

#[test]
fn create_page_in_empty_folder() {
    let v = VaultBuilder::new().open();
    let folder = v.create_folder(None, "f").unwrap();

    let page = v.create_page(Some(&folder), "メモ").unwrap();

    assert_eq!(page.path, "f/メモ.md");
    assert_eq!(
        all_paths(&v.list_tree().unwrap()),
        ["f", "f/メモ.md"].map(String::from).into()
    );
}

// ================================================================ rename_folder

#[test]
fn rename_folder_moves_contents_and_rewrites_links() {
    let v = VaultBuilder::new()
        .file("f/a.md", "")
        .file("other.md", "[a](f/a.md) と [画像](f/x.png)\n")
        .file("f/x.png", "png")
        .open();

    assert_eq!(v.rename_folder("f", "g").unwrap(), "g");

    assert_eq!(text(&v, "other.md"), "[a](g/a.md) と [画像](g/x.png)\n");
    assert!(v.root().join("g/a.md").is_file());
    assert!(!v.root().join("f").exists());
    assert_eq!(
        all_paths(&v.list_tree().unwrap()),
        ["g", "g/a.md", "other.md"].map(String::from).into()
    );
    assert_eq!(v.search("other", 10).unwrap().len(), 1);
}

#[test]
fn rename_empty_folder() {
    let v = VaultBuilder::new().dir("f").open();
    assert_eq!(v.rename_folder("f", "g").unwrap(), "g");
    assert_eq!(all_paths(&v.list_tree().unwrap()), ["g".to_string()].into());
}

#[test]
fn rename_folder_to_same_name_does_nothing() {
    let v = VaultBuilder::new().dir("f").open();
    assert_eq!(v.rename_folder("f", "f").unwrap(), "f");
}

#[test]
fn rename_folder_rejects_name_taken_by_folder_or_page() {
    let v = VaultBuilder::new()
        .dir("f")
        .dir("g")
        .file("p.md", "")
        .open();
    assert!(matches!(v.rename_folder("f", "g"), Err(Error::NameOccupied(_))));
    assert!(matches!(v.rename_folder("f", "p"), Err(Error::NameOccupied(_))));
    assert!(v.root().join("f").is_dir());
}

#[test]
fn rename_folder_rejects_child_folder_of_page() {
    let v = VaultBuilder::new().file("a.md", "").file("a/b.md", "").open();
    assert!(matches!(v.rename_folder("a", "c"), Err(Error::NotAPage(_))));
}

// ================================================================ delete_folder

#[test]
fn delete_folder_trashes_folder_with_contents() {
    let v = VaultBuilder::new()
        .file("x.md", "")
        .file("f/a.md", "")
        .file("f/g/b.md", "")
        .open();

    v.delete_folder("f").unwrap();

    assert_eq!(v.all_entries(), ["x.md".to_string()].into());
    assert_eq!(all_paths(&v.list_tree().unwrap()), ["x.md".to_string()].into());
    assert!(v.search("b", 10).unwrap().is_empty());
}

#[test]
fn delete_folder_removes_page_folder_left_empty() {
    let v = VaultBuilder::new().file("a.md", "").dir("a/f").open();

    v.delete_folder("a/f").unwrap();

    assert_eq!(v.all_entries(), ["a.md".to_string()].into());
}

#[test]
fn delete_folder_rejects_pages_and_child_folders_of_pages() {
    let v = VaultBuilder::new().file("a.md", "").file("a/b.md", "").open();
    assert!(matches!(v.delete_folder("a"), Err(Error::NotAPage(_))));
    assert!(matches!(v.delete_folder("a.md"), Err(Error::NotAPage(_))));
    assert!(matches!(v.delete_folder("none"), Err(Error::NotFound(_))));
}

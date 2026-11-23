//! move_page / move_folder: ページやフォルダを別の場所へ動かし、リンクを書き換える。

mod common;

use common::*;
use jot_core::Error;

fn text(v: &TestVault, rel: &str) -> String {
    String::from_utf8(v.disk_bytes(rel)).unwrap()
}

fn paths(v: &TestVault) -> Vec<String> {
    all_paths(&v.list_tree().unwrap()).into_iter().collect()
}

// ================================================================ move_page

#[test]
fn move_page_into_folder() {
    let v = VaultBuilder::new().file("a.md", "本文").dir("f").open();

    let meta = v.move_page("a.md", Some("f")).unwrap();

    assert_eq!(meta.path, "f/a.md");
    assert_eq!(text(&v, "f/a.md"), "本文");
    assert!(!v.root().join("a.md").exists());
    assert_eq!(paths(&v), ["f", "f/a.md"]);
}

#[test]
fn move_page_under_page_creates_child_folder() {
    let v = VaultBuilder::new().file("a.md", "").file("b.md", "").open();

    assert_eq!(v.move_page("b.md", Some("a.md")).unwrap().path, "a/b.md");

    assert_eq!(paths(&v), ["a.md", "a/b.md"]);
}

#[test]
fn move_page_to_root_and_removes_page_folder_left_empty() {
    let v = VaultBuilder::new().file("a.md", "").file("a/b.md", "").open();

    assert_eq!(v.move_page("a/b.md", None).unwrap().path, "b.md");

    assert_eq!(v.all_entries(), ["a.md", "b.md"].map(String::from).into());
}

#[test]
fn move_page_takes_child_pages_along() {
    let v = VaultBuilder::new()
        .file("a.md", "")
        .file("a/c.md", "")
        .dir("f")
        .open();

    v.move_page("a.md", Some("f")).unwrap();

    assert_eq!(paths(&v), ["f", "f/a.md", "f/a/c.md"]);
}

#[test]
fn move_page_to_same_place_does_nothing() {
    let v = VaultBuilder::new().file("f/a.md", "x").open();
    assert_eq!(v.move_page("f/a.md", Some("f")).unwrap().path, "f/a.md");
    assert_eq!(text(&v, "f/a.md"), "x");
}

#[test]
fn move_page_into_itself_is_rejected() {
    let v = VaultBuilder::new().file("a.md", "").file("a/b.md", "").open();
    assert!(matches!(v.move_page("a.md", Some("a.md")), Err(Error::InvalidPath(_))));
    assert!(matches!(v.move_page("a.md", Some("a/b.md")), Err(Error::InvalidPath(_))));
    assert_eq!(paths(&v), ["a.md", "a/b.md"]);
}

#[test]
fn move_page_rejects_name_taken_at_destination() {
    let v = VaultBuilder::new().file("a.md", "").file("f/a.md", "").open();
    assert!(matches!(v.move_page("a.md", Some("f")), Err(Error::NameOccupied(_))));
    assert!(v.root().join("a.md").is_file());
}

// ================================================================ リンク

#[test]
fn links_to_moved_page_are_rewritten() {
    let v = VaultBuilder::new()
        .file("a.md", "")
        .file("other.md", "[a](a.md) と [a の中](a/c.md#見出し)\n")
        .file("a/c.md", "")
        .dir("f")
        .open();

    v.move_page("a.md", Some("f")).unwrap();

    assert_eq!(text(&v, "other.md"), "[a](f/a.md) と [a の中](f/a/c.md#見出し)\n");
}

#[test]
fn links_inside_moved_page_keep_pointing_to_same_place() {
    let v = VaultBuilder::new()
        .file("a.md", "[b](b.md) ![画像](img.png) [子](a/c.md) [外](https://example.com)\n")
        .file("a/c.md", "[親の隣](../b.md)\n")
        .file("b.md", "")
        .file("img.png", "png")
        .dir("f/g")
        .open();

    v.move_page("a.md", Some("f/g")).unwrap();

    assert_eq!(
        text(&v, "f/g/a.md"),
        "[b](../../b.md) ![画像](../../img.png) [子](a/c.md) [外](https://example.com)\n"
    );
    assert_eq!(text(&v, "f/g/a/c.md"), "[親の隣](../../../b.md)\n");
}

#[test]
fn link_from_moved_page_to_new_neighbor_becomes_short() {
    let v = VaultBuilder::new()
        .file("a.md", "[b](f/b.md)\n")
        .file("f/b.md", "")
        .open();

    v.move_page("a.md", Some("f")).unwrap();

    assert_eq!(text(&v, "f/a.md"), "[b](b.md)\n");
}

#[test]
fn moved_page_keeps_names_needing_percent_escapes() {
    let v = VaultBuilder::new()
        .file("メモ a.md", "")
        .file("other.md", "[x](<メモ a.md>)\n")
        .dir("f")
        .open();

    v.move_page("メモ a.md", Some("f")).unwrap();

    assert_eq!(text(&v, "other.md"), "[x](<f/メモ%20a.md>)\n");
}

#[test]
fn move_rejects_read_only_page_needing_rewrite() {
    let v = VaultBuilder::new()
        .file("a.md", "")
        .file("other.md", "[a](a.md)\n")
        .dir("f")
        .open();
    let other = v.root().join("other.md");
    let mut perms = std::fs::metadata(&other).unwrap().permissions();
    perms.set_readonly(true);
    std::fs::set_permissions(&other, perms).unwrap();

    assert!(matches!(v.move_page("a.md", Some("f")), Err(Error::ReadOnly(_))));
    assert!(v.root().join("a.md").is_file());
}

#[test]
fn moved_page_is_found_by_search_at_new_path() {
    let v = VaultBuilder::new().file("a.md", "りんご").dir("f").open();
    v.move_page("a.md", Some("f")).unwrap();
    let hits = v.search("りんご", 10).unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].path, "f/a.md");
}

// ================================================================ move_folder

#[test]
fn move_folder_with_contents_and_rewrites_links() {
    let v = VaultBuilder::new()
        .file("f/a.md", "[x](../x.md)\n")
        .file("x.md", "[a](f/a.md)\n")
        .dir("g")
        .open();

    assert_eq!(v.move_folder("f", Some("g")).unwrap(), "g/f");

    assert_eq!(paths(&v), ["g", "g/f", "g/f/a.md", "x.md"]);
    assert_eq!(text(&v, "x.md"), "[a](g/f/a.md)\n");
    assert_eq!(text(&v, "g/f/a.md"), "[x](../../x.md)\n");
}

#[test]
fn move_empty_folder_under_page() {
    let v = VaultBuilder::new().file("p.md", "").dir("f").open();
    assert_eq!(v.move_folder("f", Some("p.md")).unwrap(), "p/f");
    assert_eq!(paths(&v), ["p.md", "p/f"]);
}

#[test]
fn move_folder_into_itself_is_rejected() {
    let v = VaultBuilder::new().dir("f/g").open();
    assert!(matches!(v.move_folder("f", Some("f")), Err(Error::InvalidPath(_))));
    assert!(matches!(v.move_folder("f", Some("f/g")), Err(Error::InvalidPath(_))));
}

#[test]
fn move_folder_rejects_name_taken_by_folder_or_page() {
    let v = VaultBuilder::new()
        .dir("f")
        .dir("g/f")
        .dir("h")
        .file("h/f.md", "")
        .open();
    assert!(matches!(v.move_folder("f", Some("g")), Err(Error::NameOccupied(_))));
    assert!(matches!(v.move_folder("f", Some("h")), Err(Error::NameOccupied(_))));
    assert!(v.root().join("f").is_dir());
}

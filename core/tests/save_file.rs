//! save_file: 保管庫の中の決まったフォルダ(チャットの添付など)にファイルを保存する。

mod common;

use common::*;
use jot_core::Error;

#[test]
fn creates_missing_folders_and_returns_vault_path() {
    let v = VaultBuilder::new().file("チャット/PdM.md", "").open();

    let path = v.save_file("チャット/添付/2026-11-17", "093100-1.PNG", b"png").unwrap();

    assert_eq!(path, "チャット/添付/2026-11-17/093100-1.png");
    assert_eq!(v.disk_bytes("チャット/添付/2026-11-17/093100-1.png"), b"png");
    // 画像だけのフォルダ(2026-11-17)は一覧に出ない。その上の「添付」は、開き直したときと同じくフォルダとして出る
    assert_eq!(all_paths(&v.list_tree().unwrap()), ["チャット", "チャット/PdM.md", "チャット/添付"].map(String::from).into());
}

#[test]
fn numbers_names_already_taken_without_overwriting() {
    let v = VaultBuilder::new().file("チャット/添付/d/a.png", "old").open();
    assert_eq!(v.save_file("チャット/添付/d", "a.png", b"new").unwrap(), "チャット/添付/d/a 2.png");
    assert_eq!(v.disk_bytes("チャット/添付/d/a.png"), b"old");
}

#[test]
fn reuses_existing_folder_names_on_disk() {
    let v = VaultBuilder::new().file("Chat/x.png", "").open();
    assert_eq!(v.save_file("chat/添付", "y.png", b"").unwrap(), "Chat/添付/y.png");
}

#[test]
fn rejects_paths_outside_or_hidden() {
    let v = VaultBuilder::new().file("a.md", "").open();
    for bad in ["", "/abs", "a/../b", "a//b", "a/"] {
        assert!(matches!(v.save_file(bad, "x.png", b""), Err(Error::InvalidPath(_))), "{bad}");
    }
    assert!(matches!(v.save_file(".obsidian/x", "x.png", b""), Err(Error::NotAPage(_))));
}

#[test]
fn does_not_create_pages() {
    let v = VaultBuilder::new().open();
    assert!(matches!(v.save_file("新しい/フォルダ", "x.md", b"# hi"), Err(Error::NotAPage(_))));
    // 作ったフォルダも残さない
    assert!(!v.root().join("新しい").exists());
}

#[test]
fn refuses_to_walk_through_a_file() {
    let v = VaultBuilder::new().file("a/b", "file").open();
    assert!(matches!(v.save_file("a/b/c", "x.png", b""), Err(Error::NameOccupied(_))));
}

#[test]
fn tree_matches_a_fresh_scan() {
    let v = VaultBuilder::new().file("チャット/PdM.md", "").file("チャット/添付/2026-11-16/a.png", "").open();
    let before = all_paths(&v.list_tree().unwrap());
    v.save_file("チャット/添付/2026-11-17", "b.png", b"").unwrap();
    assert_eq!(all_paths(&v.list_tree().unwrap()), before);
}

// ---- save_page: チャットに貼った長い本文を、新しいページとして保存する ----

#[test]
fn save_page_creates_folders_and_a_listed_page() {
    let v = VaultBuilder::new().file("チャット/PdM.md", "").open();
    let path = v.save_page("チャット/貼り付け/2026-11-17", "101500-SQL の結果", "# 貼り付け\n本文\n").unwrap();
    assert_eq!(path, "チャット/貼り付け/2026-11-17/101500-SQL の結果.md");
    assert_eq!(v.disk_bytes(&path), "# 貼り付け\n本文\n".as_bytes());
    // 一覧に出て、すぐ読める(索引と食い違わない)
    assert!(all_paths(&v.list_tree().unwrap()).contains(&path));
    assert_eq!(v.read_page(&path).unwrap().0, "# 貼り付け\n本文\n");
}

#[test]
fn save_page_numbers_names_already_taken() {
    let v = VaultBuilder::new().file("チャット/貼り付け/d/a.md", "old").open();
    assert_eq!(v.save_page("チャット/貼り付け/d", "a", "new").unwrap(), "チャット/貼り付け/d/a 2.md");
    assert_eq!(v.disk_bytes("チャット/貼り付け/d/a.md"), b"old");
}

#[test]
fn save_page_rejects_bad_folders() {
    let v = VaultBuilder::new().open();
    assert!(matches!(v.save_page("a/../b", "x", ""), Err(Error::InvalidPath(_))));
    assert!(matches!(v.save_page(".obsidian", "x", ""), Err(Error::NotAPage(_))));
}

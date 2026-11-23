//! 大きな保管庫を開いたときのメモリ(macOS の physical footprint)を、段階ごとに測る。
//! cargo run --release --example memory -- <保管庫> <索引用のフォルダ>
//! 索引用のフォルダが空なら、索引を作るところから測る。保管庫には何も書かない(残った一時ファイルの削除を除く)。

use std::path::Path;
use std::process::Command;
use std::time::Instant;

use jot_core::Vault;

fn footprint_mb() -> String {
    let out = Command::new("footprint")
        .arg(std::process::id().to_string())
        .output()
        .expect("footprint を実行できません");
    let text = String::from_utf8_lossy(&out.stdout);
    text.lines()
        .find_map(|l| l.split("Footprint: ").nth(1))
        .map(|s| s.split(" (").next().unwrap_or(s).to_string())
        .unwrap_or_else(|| "?".into())
}

fn step(label: &str, start: Instant) {
    println!("{label:<28} {:>10}  ({:.2}s)", footprint_mb(), start.elapsed().as_secs_f64());
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let (root, index) = (Path::new(&args[1]), Path::new(&args[2]));
    let t = Instant::now();
    step("起動直後", t);
    let vault = Vault::open(root, index).unwrap();
    step("open", t);
    let tree = vault.list_tree().unwrap();
    step("list_tree", t);
    drop(tree);
    for q in ["メモ", "the", "設計 テスト"] {
        vault.search(q, 50).unwrap();
    }
    step("search x3", t);
    vault.recent_pages(100).unwrap();
    vault.rescan().unwrap();
    step("rescan", t);
    drop(vault);
    step("close", t);
}

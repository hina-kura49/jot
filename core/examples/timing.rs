//! 大きな保管庫での、操作ごとの時間を測る(体感の速さの確認用)。
//! cargo run --release --example timing -- <保管庫> <索引用のフォルダ>

use std::path::Path;
use std::time::Instant;

use jot_core::Vault;

fn time<T>(label: &str, f: impl FnOnce() -> T) -> T {
    let t = Instant::now();
    let out = f();
    println!("{label:<36} {:>8.1} ms", t.elapsed().as_secs_f64() * 1000.0);
    out
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let (root, index) = (Path::new(&args[1]), Path::new(&args[2]));
    let vault = time("open", || Vault::open(root, index).unwrap());
    let tree = time("list_tree", || vault.list_tree().unwrap());
    println!("  最上位の節点 {}", tree.len());
    // パレットでは1文字打つごとに検索する
    for q in ["メ", "メモ", "a", "ap", "app", "設計 テスト", "存在しない語句xyz"] {
        let hits = time(&format!("search {q:?}"), || vault.search(q, 50).unwrap());
        println!("  {} 件", hits.len());
    }
    time("recent_pages(20)", || vault.recent_pages(20).unwrap());
    time("rescan", || vault.rescan().unwrap());
}

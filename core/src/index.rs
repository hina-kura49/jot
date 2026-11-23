//! 索引: vault のページの一覧と本文をメモリに持ち、index_dir にキャッシュとして保存する。
//!
//! 本文そのものは持たず、比べるための形(fold したもの)だけを持つ。検索結果の抜粋は、当たったページだけをディスクから読んで作る。
//! 保存したものは、次に開くときに読み込みを速くするためだけに使う。
//! 開くたびにディスクと突き合わせ(大きさと mtime が違うページだけ読み直す)、
//! 保存したものが壊れていたり無かったりしても、ディスクから作り直すので結果は変わらない。

use std::cmp::Ordering;
use std::collections::BTreeMap;
use std::fs;
use std::io::{self, BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::disk::{self, modified_ms, modified_ns};
use crate::names::{key, natural_key, natural_path_cmp, nfc, stem};
use crate::search::{fold, query_words, snippet};
use crate::{NodeKind, PageMeta, SearchHit, TreeNode};

const INDEX_FILE: &str = "index.bin";
// 形を変えたら名前か数を変える(合わない索引は読まずに作り直す)
const MAGIC: &[u8; 8] = b"JOTIDX04";

/// 索引の中の1ページ。
pub(crate) struct Entry {
    /// ディスク上の表記のままの相対パス
    disk: String,
    /// アプリに返す path(NFC)
    path: String,
    title: String,
    folded_title: String,
    size: u64,
    mtime_ns: u128,
    modified_at: u64,
    /// UTF-8 として読めたときだけ、本文を比べるための形にしたものを持つ
    folded: Option<String>,
    /// フロントマターの `icon:`
    icon: Option<String>,
}

impl Entry {
    fn new(
        disk: String,
        size: u64,
        mtime_ns: u128,
        modified_at: u64,
        body: Option<String>,
    ) -> Entry {
        let path = nfc(&disk);
        let name = path.rsplit('/').next().unwrap_or(&path);
        let title = stem(name).to_string();
        Entry {
            folded_title: fold(&title),
            disk,
            path,
            title,
            size,
            mtime_ns,
            modified_at,
            icon: body.as_deref().and_then(icon_of),
            folded: body.map(|body| fold(&body)),
        }
    }

    fn read(root: &Path, disk: &str, meta: &fs::Metadata) -> io::Result<Entry> {
        let bytes = fs::read(root.join(disk))?;
        Ok(Entry::new(
            disk.to_string(),
            meta.len(),
            modified_ns(meta),
            modified_ms(meta),
            String::from_utf8(bytes).ok(),
        ))
    }

    fn meta(&self) -> PageMeta {
        PageMeta {
            path: self.path.clone(),
            title: self.title.clone(),
            modified_at: self.modified_at,
        }
    }
}

pub(crate) struct Index {
    file: PathBuf,
    entries: BTreeMap<String, Entry>,
    /// フォルダ(ディスク上の相対パス) → 直下に .md 以外の見えるものがあるか。
    /// 開くたびにディスクから作り直すので、保存しない。
    dirs: BTreeMap<String, bool>,
    /// 保存したものと中身が違うか
    dirty: bool,
}

impl Index {
    /// 保存したものを読み込む。無い・壊れているときは空から始める。
    pub fn load(index_dir: &Path) -> Index {
        let file = index_dir.join(INDEX_FILE);
        match decode(&file) {
            Some(entries) => Index {
                file,
                entries,
                dirs: BTreeMap::new(),
                dirty: false,
            },
            None => Index {
                file,
                entries: BTreeMap::new(),
                dirs: BTreeMap::new(),
                dirty: true,
            },
        }
    }

    /// ディスクと突き合わせる。`full` なら、すべてのページを読み直す。
    pub fn scan(&mut self, root: &Path, full: bool, remove_temp_files: bool) -> io::Result<()> {
        let mut found = Vec::new();
        let mut dirs = Vec::new();
        disk::walk(root, "", remove_temp_files, &mut found, &mut Some(&mut dirs))?;
        self.dirs = dirs.into_iter().collect();
        let mut entries = BTreeMap::new();
        for (rel, meta) in found {
            let reuse = !full
                && self
                    .entries
                    .get(&rel)
                    .is_some_and(|e| e.size == meta.len() && e.mtime_ns == modified_ns(&meta));
            let entry = match self.entries.remove(&rel) {
                Some(e) if reuse => e,
                _ => {
                    self.dirty = true;
                    match Entry::read(root, &rel, &meta) {
                        Ok(e) => e,
                        // 走査の間に消えたページは飛ばす。
                        Err(e) if e.kind() == io::ErrorKind::NotFound => continue,
                        Err(e) => return Err(e),
                    }
                }
            };
            entries.insert(rel, entry);
        }
        if !self.entries.is_empty() {
            self.dirty = true;
        }
        self.entries = entries;
        Ok(())
    }

    /// 1ページを読み直す。無くなっていれば索引から外す。
    pub fn refresh(&mut self, root: &Path, disk: &str) -> io::Result<()> {
        self.dirty = true;
        match fs::symlink_metadata(root.join(disk)) {
            Ok(meta) if meta.is_file() => {
                let entry = Entry::read(root, disk, &meta)?;
                self.entries.insert(disk.to_string(), entry);
                Ok(())
            }
            Ok(_) => {
                self.entries.remove(disk);
                Ok(())
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                self.entries.remove(disk);
                Ok(())
            }
            Err(e) => Err(e),
        }
    }

    /// フォルダ(ディスク上の相対パス)以下のページを、ディスクから読み直す。
    pub fn refresh_dir(&mut self, root: &Path, dir: &str) -> io::Result<()> {
        self.remove_dir(dir);
        let mut found = Vec::new();
        let mut dirs = Vec::new();
        disk::walk(root, dir, false, &mut found, &mut Some(&mut dirs))?;
        self.dirs.extend(dirs);
        for (rel, meta) in found {
            let entry = Entry::read(root, &rel, &meta)?;
            self.entries.insert(rel, entry);
        }
        Ok(())
    }

    pub fn remove(&mut self, disk: &str) {
        self.dirty = true;
        self.entries.remove(disk);
    }

    /// フォルダ(ディスク上の相対パス)と、その中のページとフォルダを索引から外す。
    pub fn remove_dir(&mut self, dir: &str) {
        self.dirty = true;
        let prefix = format!("{dir}/");
        self.entries.retain(|disk, _| !disk.starts_with(&prefix));
        self.dirs.retain(|d, _| d != dir && !d.starts_with(&prefix));
    }

    /// 作ったばかりの空のフォルダ(ディスク上の相対パス)を索引に入れる。
    pub fn add_dir(&mut self, dir: &str) {
        self.dirs.insert(dir.to_string(), false);
    }

    pub fn meta(&self, disk: &str) -> Option<PageMeta> {
        self.entries.get(disk).map(Entry::meta)
    }

    /// 変わっていれば保存する。保存できなくても索引は使えるので、失敗は無視する。
    /// 全体を一度にメモリに作らず、一時ファイルへ順に書いてから置き換える。
    pub fn save(&mut self) {
        if !self.dirty {
            return;
        }
        let Some(dir) = self.file.parent() else {
            return;
        };
        let temp = dir.join(format!("{INDEX_FILE}.tmp"));
        let result = fs::create_dir_all(dir)
            .and_then(|()| encode(&self.entries, &temp))
            .and_then(|()| fs::rename(&temp, &self.file));
        match result {
            Ok(()) => self.dirty = false,
            Err(_) => {
                let _ = fs::remove_file(&temp);
            }
        }
    }

    pub fn list_tree(&self) -> Vec<TreeNode> {
        let mut root = DirBuild::default();
        for (disk, has_other) in &self.dirs {
            root.dir(disk.split('/')).has_other = *has_other;
        }
        for entry in self.entries.values() {
            let mut parts: Vec<&str> = entry.disk.split('/').collect();
            let name = parts.pop().unwrap_or_default();
            root.dir(parts.into_iter()).pages.push((name.to_string(), entry.icon.clone()));
        }
        root.nodes("")
    }

    pub fn recent_pages(&self, limit: usize) -> Vec<PageMeta> {
        let entries: Vec<&Entry> = self.entries.values().collect();
        top(entries, limit, |e| e.modified_at, |a, b| newest_first(a, b))
            .into_iter()
            .map(Entry::meta)
            .collect()
    }

    /// 抜粋を作るために、当たったページ(最大 `limit` 件)だけを `root` から読む。
    pub fn search(&self, root: &Path, query: &str, limit: usize) -> Vec<SearchHit> {
        let words = query_words(query);
        if words.is_empty() || limit == 0 {
            return Vec::new();
        }
        // (タイトルにすべての語があるか, ページ)
        let mut matched: Vec<(bool, &Entry)> = Vec::new();
        for entry in self.entries.values() {
            let Some(folded) = &entry.folded else {
                continue;
            };
            let found = words.iter().all(|w| {
                entry.folded_title.contains(w.as_str()) || folded.contains(w.as_str())
            });
            if found {
                let title_matched = words
                    .iter()
                    .all(|w| entry.folded_title.contains(w.as_str()));
                matched.push((title_matched, entry));
            }
        }
        top(
            matched,
            limit,
            |(t, e)| (*t, e.modified_at),
            |(ta, a), (tb, b)| tb.cmp(ta).then_with(|| newest_first(a, b)),
        )
        .into_iter()
            .map(|(title_matched, entry)| {
                let folded = entry.folded.as_ref().expect("UTF-8 のページだけを集めた");
                let in_body: Vec<String> = words
                    .iter()
                    .filter(|w| folded.contains(w.as_str()))
                    .cloned()
                    .collect();
                // 読めなければ(索引の後で消えた・UTF-8 でなくなったなど)、抜粋は空にする。
                let snippet = fs::read(root.join(&entry.disk))
                    .ok()
                    .and_then(|bytes| String::from_utf8(bytes).ok())
                    .map(|body| snippet(&body, &in_body))
                    .unwrap_or_default();
                SearchHit {
                    path: entry.path.clone(),
                    title: entry.title.clone(),
                    snippet,
                    title_matched,
                }
            })
            .collect()
    }
}

/// アイコンの長さの上限(バイト)。絵文字1つ(結合したものを含む)には足りる
const ICON_MAX_BYTES: usize = 64;

/// 本文の先頭のフロントマター(`---` で挟んだ部分)から `icon:` の値を読む。無ければ None。
/// 値の前後の空白と、囲みの引用符(" か ')は外す。
fn icon_of(body: &str) -> Option<String> {
    let body = body.strip_prefix('\u{FEFF}').unwrap_or(body);
    let mut lines = body.lines();
    if lines.next()?.trim_end() != "---" {
        return None;
    }
    for line in lines {
        let line = line.trim_end();
        if line == "---" {
            return None;
        }
        let Some(value) = line.strip_prefix("icon:") else {
            continue;
        };
        let value = value.trim();
        let value = ['"', '\'']
            .iter()
            .find_map(|q| value.strip_prefix(*q)?.strip_suffix(*q))
            .unwrap_or(value)
            .trim();
        return (!value.is_empty() && value.len() <= ICON_MAX_BYTES).then(|| value.to_string());
    }
    None
}

/// `items` を `cmp` の順に並べた先頭の `limit` 件。
/// `cmp` は「`rank` の大きい順、同じなら別の決まり(重い比べ方)」でなければならない。
/// 全体を重い比べ方で並べると大きな保管庫で遅いので、まず軽い `rank` で上位を選び、
/// 境目と同じ `rank` のものまで含めた分だけを `cmp` で並べる(結果は全体を並べたときと同じ)。
fn top<T, R: Ord + Copy>(
    mut items: Vec<T>,
    limit: usize,
    rank: impl Fn(&T) -> R,
    cmp: impl Fn(&T, &T) -> Ordering,
) -> Vec<T> {
    if limit == 0 {
        return Vec::new();
    }
    if items.len() > limit {
        items.sort_unstable_by_key(|item| std::cmp::Reverse(rank(item)));
        let edge = rank(&items[limit - 1]);
        let keep = items.partition_point(|item| rank(item) >= edge);
        items.truncate(keep);
    }
    items.sort_by(|a, b| cmp(a, b));
    items.truncate(limit);
    items
}

/// 更新日時の新しい順、同じなら path の自然な順。
fn newest_first(a: &Entry, b: &Entry) -> Ordering {
    b.modified_at
        .cmp(&a.modified_at)
        .then_with(|| natural_path_cmp(&a.path, &b.path))
}

/// list_tree を組み立てるための、フォルダ1つ分。
#[derive(Default)]
struct DirBuild {
    /// ディスク上の名前
    name: String,
    /// ページのファイル名(ディスク上の表記)とアイコン
    pages: Vec<(String, Option<String>)>,
    /// 比べるための形 → 子フォルダ
    dirs: BTreeMap<String, DirBuild>,
    /// 直下に .md 以外の見えるものがあるか
    has_other: bool,
}

impl DirBuild {
    /// 名前の並びでたどった子孫のフォルダ。無ければ作る。
    fn dir<'a>(&mut self, parts: impl Iterator<Item = &'a str>) -> &mut DirBuild {
        let mut dir = self;
        for part in parts {
            dir = dir.dirs.entry(key(part)).or_insert_with(|| DirBuild {
                name: part.to_string(),
                ..Default::default()
            });
        }
        dir
    }

    /// このフォルダの中身を節点にする。`prefix` は、このフォルダの path(NFC)の後ろに「/」を付けたもの。
    fn nodes(mut self, prefix: &str) -> Vec<TreeNode> {
        let mut nodes = Vec::new();
        for (page, icon) in std::mem::take(&mut self.pages) {
            let title = nfc(stem(&page));
            // ページと同じ名前のフォルダは、そのページの子になる。
            let children = match self.dirs.remove(&key(&title)) {
                Some(dir) => {
                    let dir_prefix = format!("{prefix}{}/", nfc(&dir.name));
                    dir.nodes(&dir_prefix)
                }
                None => Vec::new(),
            };
            nodes.push(TreeNode {
                kind: NodeKind::Page,
                path: format!("{prefix}{}", nfc(&page)),
                title,
                icon,
                children,
            });
        }
        for dir in std::mem::take(&mut self.dirs).into_values() {
            let name = nfc(&dir.name);
            let path = format!("{prefix}{name}");
            let has_other = dir.has_other;
            let children = dir.nodes(&format!("{path}/"));
            // ページも、出すフォルダも無く、画像などだけを入れたフォルダは出さない(空のフォルダは出す)。
            if children.is_empty() && has_other {
                continue;
            }
            nodes.push(TreeNode {
                kind: NodeKind::Folder,
                path,
                title: name,
                icon: None,
                children,
            });
        }
        // 比べるための形は1つの名前につき1回だけ作る(並べ替えのたびに作ると、大きな保管庫で遅い)
        nodes.sort_by_cached_key(|n| natural_key(&n.title));
        nodes
    }
}

// ---------------------------------------------------------------- 保存の形式
//
// MAGIC、ページの数、ページごとの (disk, size, mtime_ns, modified_at, 本文があるか, 比べるための形, アイコンがあるか, アイコン)、
// 最後にここまでの SHA-256。数はすべてリトルエンディアン。
// 大きな保管庫でも全体を一度にメモリに置かないよう、読み書きはファイルに対して順に行う。

/// 書いたバイト列の SHA-256 を計算しながら書く。
struct HashWriter<W: Write> {
    inner: W,
    hash: Sha256,
}

impl<W: Write> HashWriter<W> {
    fn put(&mut self, bytes: &[u8]) -> io::Result<()> {
        self.hash.update(bytes);
        self.inner.write_all(bytes)
    }

    fn u64(&mut self, n: u64) -> io::Result<()> {
        self.put(&n.to_le_bytes())
    }

    fn str(&mut self, s: &str) -> io::Result<()> {
        self.u64(s.len() as u64)?;
        self.put(s.as_bytes())
    }
}

fn encode(entries: &BTreeMap<String, Entry>, path: &Path) -> io::Result<()> {
    let file = fs::File::create(path)?;
    let mut w = HashWriter {
        inner: BufWriter::new(file),
        hash: Sha256::new(),
    };
    w.put(MAGIC)?;
    w.u64(entries.len() as u64)?;
    for e in entries.values() {
        w.str(&e.disk)?;
        w.u64(e.size)?;
        w.put(&e.mtime_ns.to_le_bytes())?;
        w.u64(e.modified_at)?;
        match &e.folded {
            Some(folded) => {
                w.put(&[1])?;
                w.str(folded)?;
            }
            None => w.put(&[0])?,
        }
        match &e.icon {
            Some(icon) => {
                w.put(&[1])?;
                w.str(icon)?;
            }
            None => w.put(&[0])?,
        }
    }
    let HashWriter { mut inner, hash } = w;
    inner.write_all(&hash.finalize())?;
    inner.into_inner().map_err(|e| e.into_error())?.sync_all()
}

/// 保存したものを索引に戻す。無い・形が少しでもおかしければ None。
fn decode(path: &Path) -> Option<BTreeMap<String, Entry>> {
    let file = fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    let mut r = Reader {
        inner: BufReader::new(file),
        hash: Sha256::new(),
        // 壊れた長さで大きな領域を取らないよう、残りのバイト数を超える長さは読まない。
        left: len,
    };
    if r.take(MAGIC.len())? != MAGIC {
        return None;
    }
    let count = r.u64()?;
    let mut entries = BTreeMap::new();
    for _ in 0..count {
        let disk = r.string()?;
        if !crate::names::is_md_name(&disk) {
            return None;
        }
        let size = r.u64()?;
        let mtime_ns = u128::from_le_bytes(r.take(16)?.try_into().ok()?);
        let modified_at = r.u64()?;
        let folded = match r.take(1)?[0] {
            0 => None,
            1 => Some(r.string()?),
            _ => return None,
        };
        let icon = match r.take(1)?[0] {
            0 => None,
            1 => Some(r.string()?),
            _ => return None,
        };
        let path = nfc(&disk);
        let title = stem(path.rsplit('/').next()?).to_string();
        let entry = Entry {
            folded_title: fold(&title),
            path,
            title,
            disk: disk.clone(),
            size,
            mtime_ns,
            modified_at,
            folded,
            icon,
        };
        entries.insert(disk, entry);
    }
    let expected = r.hash.clone().finalize();
    let mut stored = [0u8; 32];
    r.inner.read_exact(&mut stored).ok()?;
    // 後ろに余計なものが無く、SHA-256 が合うときだけ使う。
    (r.left == 32 && stored.as_slice() == expected.as_slice()).then_some(entries)
}

struct Reader<R: Read> {
    inner: R,
    hash: Sha256,
    left: u64,
}

impl<R: Read> Reader<R> {
    fn take(&mut self, n: usize) -> Option<Vec<u8>> {
        // 最後の 32 バイトは SHA-256 なので、中身としては読まない。
        if n as u64 > self.left.checked_sub(32)? {
            return None;
        }
        let mut buf = vec![0; n];
        self.inner.read_exact(&mut buf).ok()?;
        self.hash.update(&buf);
        self.left -= n as u64;
        Some(buf)
    }

    fn u64(&mut self) -> Option<u64> {
        Some(u64::from_le_bytes(self.take(8)?.try_into().ok()?))
    }

    fn string(&mut self) -> Option<String> {
        let len = usize::try_from(self.u64()?).ok()?;
        String::from_utf8(self.take(len)?).ok()
    }
}

//! Quick open (fuzzy file paths) and search-in-files.
//!
//! The file index is built once per project with a parallel, `.gitignore`-aware walk and
//! cached; the watcher invalidates it. Fuzzy ranking uses nucleo (the matcher behind Helix),
//! with a filename bonus so `main` finds `src/main.rs` before `domain/x.rs`.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

use ignore::{WalkBuilder, WalkState};
use nucleo_matcher::pattern::{AtomKind, CaseMatching, Normalization, Pattern};
use nucleo_matcher::{Config, Matcher, Utf32Str};
use parking_lot::Mutex;
use serde::Serialize;

use crate::fs_ops::{err, guard, CmdResult};

const MAX_INDEX: usize = 300_000;

#[derive(Default)]
pub struct FileIndex {
    by_root: Mutex<HashMap<String, Arc<Vec<String>>>>,
}

impl FileIndex {
    pub fn invalidate(&self, root: &str) {
        self.by_root.lock().remove(root);
    }

    fn get(&self, root: &str) -> Arc<Vec<String>> {
        if let Some(files) = self.by_root.lock().get(root) {
            return files.clone();
        }
        let files = Arc::new(walk_files(Path::new(root)));
        self.by_root.lock().insert(root.to_string(), files.clone());
        files
    }
}

fn walker(root: &Path) -> WalkBuilder {
    let mut b = WalkBuilder::new(root);
    b.hidden(false).git_ignore(true).git_global(true).git_exclude(true).ignore(true).parents(true);
    b.filter_entry(|e| {
        let name = e.file_name().to_string_lossy();
        !matches!(name.as_ref(), ".git" | "node_modules" | ".hg" | ".svn")
    });
    b.threads(std::thread::available_parallelism().map(|n| n.get().min(8)).unwrap_or(4));
    b
}

fn walk_files(root: &Path) -> Vec<String> {
    let out = Mutex::new(Vec::with_capacity(4096));
    walker(root).build_parallel().run(|| {
        let out = &out;
        Box::new(move |entry| {
            let Ok(entry) = entry else { return WalkState::Continue };
            if entry.file_type().is_some_and(|t| t.is_file()) {
                if let Ok(rel) = entry.path().strip_prefix(root) {
                    let mut out = out.lock();
                    if out.len() >= MAX_INDEX {
                        return WalkState::Quit;
                    }
                    out.push(rel.to_string_lossy().replace('\\', "/"));
                }
            }
            WalkState::Continue
        })
    });
    out.into_inner()
}

#[derive(Serialize)]
pub struct QuickOpenHit {
    path: String,
    score: u32,
    /// Matched character indices in `path` (for highlighting).
    indices: Vec<u32>,
}

#[tauri::command]
pub async fn quick_open(index: tauri::State<'_, Arc<FileIndex>>, root: String, query: String, limit: Option<usize>) -> CmdResult<Vec<QuickOpenHit>> {
    let index = index.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let files = index.get(&root);
        let limit = limit.unwrap_or(50);
        let query = query.trim();
        if query.is_empty() {
            return files.iter().take(limit).map(|p| QuickOpenHit { path: p.clone(), score: 0, indices: vec![] }).collect();
        }
        let mut matcher = Matcher::new(Config::DEFAULT.match_paths());
        let pattern = Pattern::new(query, CaseMatching::Smart, Normalization::Smart, AtomKind::Fuzzy);
        let mut buf = Vec::new();
        let mut hits: Vec<(u32, &String)> = Vec::new();
        for path in files.iter() {
            let hay = Utf32Str::new(path, &mut buf);
            if let Some(score) = pattern.score(hay, &mut matcher) {
                let name = path.rsplit('/').next().unwrap_or(path);
                let mut name_buf = Vec::new();
                let bonus = pattern.score(Utf32Str::new(name, &mut name_buf), &mut matcher).map(|s| s / 2).unwrap_or(0);
                // Prefer shorter paths among equals.
                let score = (score + bonus).saturating_sub((path.len() / 16) as u32);
                hits.push((score, path));
            }
        }
        hits.sort_unstable_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.len().cmp(&b.1.len())));
        hits.truncate(limit);
        hits.into_iter()
            .map(|(score, path)| {
                let mut indices = Vec::new();
                pattern.indices(Utf32Str::new(path, &mut buf), &mut matcher, &mut indices);
                indices.sort_unstable();
                indices.dedup();
                QuickOpenHit { path: path.clone(), score, indices }
            })
            .collect()
    })
    .await
    .map_err(err)
}

#[derive(Serialize)]
pub struct TextHit {
    path: String,
    line: u32,
    column: u32,
    text: String,
}

#[derive(Serialize)]
pub struct SearchResult {
    hits: Vec<TextHit>,
    truncated: bool,
    files_searched: usize,
}

#[tauri::command]
pub async fn search_text(root: String, query: String, regex: bool, case_sensitive: bool, max_hits: Option<usize>, folder: Option<String>) -> CmdResult<SearchResult> {
    let base = guard(&root, "")?;
    // Find in folder: walk only that folder; hit paths stay relative to the project.
    let start = match folder.as_deref().map(str::trim).filter(|f| !f.is_empty()) {
        Some(f) => guard(&root, f)?,
        None => base.clone(),
    };
    tauri::async_runtime::spawn_blocking(move || {
        let pattern = if regex { query.clone() } else { regex::escape(&query) };
        let re = regex::RegexBuilder::new(&pattern).case_insensitive(!case_sensitive).build().map_err(err)?;
        let max_hits = max_hits.unwrap_or(2000);
        let hits = Mutex::new(Vec::new());
        let files = std::sync::atomic::AtomicUsize::new(0);
        let done = std::sync::atomic::AtomicBool::new(false);
        walker(&start).build_parallel().run(|| {
            let (hits, files, done, re, base) = (&hits, &files, &done, &re, &base);
            Box::new(move |entry| {
                if done.load(std::sync::atomic::Ordering::Relaxed) {
                    return WalkState::Quit;
                }
                let Ok(entry) = entry else { return WalkState::Continue };
                if !entry.file_type().is_some_and(|t| t.is_file()) || entry.metadata().map(|m| m.len() > 4 << 20).unwrap_or(true) {
                    return WalkState::Continue;
                }
                let Ok(bytes) = std::fs::read(entry.path()) else { return WalkState::Continue };
                if bytes[..bytes.len().min(4096)].contains(&0) {
                    return WalkState::Continue;
                }
                files.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                let text = String::from_utf8_lossy(&bytes);
                let rel = entry.path().strip_prefix(base).unwrap_or(entry.path()).to_string_lossy().replace('\\', "/");
                for (i, line) in text.lines().enumerate() {
                    if let Some(m) = re.find(line) {
                        let mut hits = hits.lock();
                        if hits.len() >= max_hits {
                            done.store(true, std::sync::atomic::Ordering::Relaxed);
                            return WalkState::Quit;
                        }
                        let snippet: String = line.chars().take(300).collect();
                        hits.push(TextHit { path: rel.clone(), line: i as u32 + 1, column: line[..m.start()].chars().count() as u32 + 1, text: snippet });
                    }
                }
                WalkState::Continue
            })
        });
        let mut hits = hits.into_inner();
        hits.sort_by(|a, b| a.path.cmp(&b.path).then(a.line.cmp(&b.line)));
        Ok(SearchResult { truncated: done.into_inner(), files_searched: files.into_inner(), hits })
    })
    .await
    .map_err(err)?
}

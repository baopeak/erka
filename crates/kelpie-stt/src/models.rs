//! The speech models Kelpie offers, where they come from (pinned SHA-256) and how they are laid
//! out once installed: `<models dir>/<id>/`, with a `.complete` marker written after every file
//! was verified.

use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use anyhow::{bail, Context, Result};
use serde::Serialize;
use sha2::{Digest, Sha256};

pub enum Source {
    /// A `.tar.bz2` whose single top folder is unpacked into the model folder.
    Tarball { url: &'static str, sha256: &'static str, size: u64 },
    /// Plain files, each saved under its own name.
    Files(&'static [(&'static str, &'static str, &'static str, u64)]),
}

pub enum Kind {
    /// Zipformer transducer (encoder / decoder / joiner).
    Transducer { encoder: &'static str, decoder: &'static str, joiner: &'static str },
    Whisper { encoder: &'static str, decoder: &'static str },
}

pub struct Model {
    pub id: &'static str,
    pub label: &'static str,
    /// Languages it understands: ISO codes, or "multi" for Whisper's ~100.
    pub languages: &'static str,
    pub tokens: &'static str,
    pub kind: Kind,
    pub source: Source,
    /// Output is upper case without punctuation (the Vietnamese zipformer).
    pub upper_case: bool,
}

const HF: &str = "https://huggingface.co/csukuangfj";
const WHISPER_TOKENS: &str = "b34b360dbb493e781e479794586d661700670d65564001f23024971d1f2fa126";

pub static MODELS: &[Model] = &[
    Model {
        id: "vi-zipformer",
        label: "Vietnamese — Zipformer (fast)",
        languages: "vi",
        tokens: "tokens.txt",
        kind: Kind::Transducer { encoder: "encoder.int8.onnx", decoder: "decoder.onnx", joiner: "joiner.int8.onnx" },
        source: Source::Tarball {
            url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-zipformer-vi-30M-int8-2026-02-09.tar.bz2",
            sha256: "da8b637947091829d7ee9eda23da2a4ec7caa399233a3f4e34eb719fb2ea6b9b",
            size: 26_442_384,
        },
        upper_case: true,
    },
    Model {
        id: "whisper-tiny",
        label: "Whisper tiny — many languages (fastest)",
        languages: "multi",
        tokens: "tiny-tokens.txt",
        kind: Kind::Whisper { encoder: "tiny-encoder.int8.onnx", decoder: "tiny-decoder.int8.onnx" },
        source: Source::Files(&[
            ("tiny-encoder.int8.onnx", "sherpa-onnx-whisper-tiny", "d24fb083ae3b1041fc24e97971d60e280c9342201fbb67b0ab428a8b4a51a434", 12_937_772),
            ("tiny-decoder.int8.onnx", "sherpa-onnx-whisper-tiny", "d2fece8dd42771f1df975c6c0445770d0c292bf7547c2cae04a6c0cc57540925", 89_855_401),
            ("tiny-tokens.txt", "sherpa-onnx-whisper-tiny", WHISPER_TOKENS, 816_730),
        ]),
        upper_case: false,
    },
    Model {
        id: "whisper-base",
        label: "Whisper base — many languages",
        languages: "multi",
        tokens: "base-tokens.txt",
        kind: Kind::Whisper { encoder: "base-encoder.int8.onnx", decoder: "base-decoder.int8.onnx" },
        source: Source::Files(&[
            ("base-encoder.int8.onnx", "sherpa-onnx-whisper-base", "0b8fb1304b6109976038efff5ace81720e00386f3ff6b54ee8c75291ca0a1e11", 29_120_534),
            ("base-decoder.int8.onnx", "sherpa-onnx-whisper-base", "9759d217388a01b3a4c7c15533201067b48ae819c4daafc8624e64b9409dc02d", 130_672_026),
            ("base-tokens.txt", "sherpa-onnx-whisper-base", WHISPER_TOKENS, 816_730),
        ]),
        upper_case: false,
    },
    Model {
        id: "whisper-small",
        label: "Whisper small — many languages (most accurate)",
        languages: "multi",
        tokens: "small-tokens.txt",
        kind: Kind::Whisper { encoder: "small-encoder.int8.onnx", decoder: "small-decoder.int8.onnx" },
        source: Source::Files(&[
            ("small-encoder.int8.onnx", "sherpa-onnx-whisper-small", "4cbe7b22fa9026b843b60a68640c747de05bafb1a11b57edc0e66c232d9f33a9", 112_442_483),
            ("small-decoder.int8.onnx", "sherpa-onnx-whisper-small", "acad50b5c782696e91b55914cc5ab4f756f1532f76e22aa6fc615f39fb69a8ee", 262_226_114),
            ("small-tokens.txt", "sherpa-onnx-whisper-small", WHISPER_TOKENS, 816_730),
        ]),
        upper_case: false,
    },
];

pub fn find(id: &str) -> Result<&'static Model> {
    MODELS.iter().find(|m| m.id == id).with_context(|| format!("unknown model {id:?}"))
}

impl Model {
    pub fn size(&self) -> u64 {
        match &self.source {
            Source::Tarball { size, .. } => *size,
            Source::Files(files) => files.iter().map(|f| f.3).sum(),
        }
    }

    pub fn dir(&self, root: &Path) -> PathBuf {
        root.join(self.id)
    }

    pub fn installed(&self, root: &Path) -> bool {
        self.dir(root).join(".complete").is_file()
    }
}

#[derive(Serialize)]
pub struct ModelInfo {
    id: &'static str,
    label: &'static str,
    languages: &'static str,
    size: u64,
    installed: bool,
}

pub fn list(root: &Path) -> Vec<ModelInfo> {
    MODELS.iter().map(|m| ModelInfo { id: m.id, label: m.label, languages: m.languages, size: m.size(), installed: m.installed(root) }).collect()
}

/// Downloads `url` into `dest`, checking its SHA-256; `progress(bytes)` after each chunk.
fn fetch(url: &str, sha256: &str, dest: &Path, cancel: &AtomicBool, progress: &mut dyn FnMut(u64)) -> Result<()> {
    let resp = ureq::get(url).timeout(std::time::Duration::from_secs(60 * 30)).call().with_context(|| format!("download {url}"))?;
    let mut reader = resp.into_reader();
    let part = dest.with_extension("part");
    let mut file = std::fs::File::create(&part).with_context(|| format!("create {}", part.display()))?;
    let mut hash = Sha256::new();
    let mut buf = vec![0u8; 256 * 1024];
    loop {
        if cancel.load(Ordering::Relaxed) {
            drop(file);
            let _ = std::fs::remove_file(&part);
            bail!("cancelled");
        }
        let n = reader.read(&mut buf).context("download interrupted")?;
        if n == 0 {
            break;
        }
        hash.update(&buf[..n]);
        file.write_all(&buf[..n])?;
        progress(n as u64);
    }
    file.flush()?;
    drop(file);
    let got: String = hash.finalize().iter().map(|b| format!("{b:02x}")).collect();
    if got != sha256 {
        let _ = std::fs::remove_file(&part);
        bail!("checksum mismatch for {url} (the download is corrupt or was changed)");
    }
    std::fs::rename(&part, dest)?;
    Ok(())
}

/// The path inside the archive without its top folder; `None` for anything that is not a plain
/// relative path (absolute, `..`), which is never unpacked.
fn strip_top(path: &Path) -> Option<PathBuf> {
    let mut parts = path.components();
    parts.next()?;
    let rest: PathBuf = parts.collect();
    (!rest.as_os_str().is_empty() && rest.components().all(|c| matches!(c, Component::Normal(_)))).then_some(rest)
}

/// Downloads and verifies a model into `<root>/<id>`; `progress(done, total)`.
pub fn install(model: &Model, root: &Path, cancel: &AtomicBool, progress: &mut dyn FnMut(u64, u64)) -> Result<()> {
    let dir = model.dir(root);
    // A clean folder: an earlier attempt may have left parts behind.
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir)?;
    let total = model.size();
    let mut done = 0u64;
    let result = (|| -> Result<()> {
        match &model.source {
            Source::Tarball { url, sha256, .. } => {
                let archive = dir.join("download.tar.bz2");
                fetch(url, sha256, &archive, cancel, &mut |n| {
                    done += n;
                    progress(done, total);
                })?;
                let mut tar = tar::Archive::new(bzip2::read::BzDecoder::new(std::fs::File::open(&archive)?));
                for entry in tar.entries()? {
                    let mut entry = entry?;
                    if !entry.header().entry_type().is_file() {
                        continue;
                    }
                    let Some(rel) = strip_top(&entry.path()?) else { continue };
                    let out = dir.join(rel);
                    if let Some(parent) = out.parent() {
                        std::fs::create_dir_all(parent)?;
                    }
                    entry.unpack(&out)?;
                }
                std::fs::remove_file(&archive)?;
            }
            Source::Files(files) => {
                for (name, repo, sha256, _) in files.iter() {
                    fetch(&format!("{HF}/{repo}/resolve/main/{name}"), sha256, &dir.join(name), cancel, &mut |n| {
                        done += n;
                        progress(done, total);
                    })?;
                }
            }
        }
        std::fs::write(dir.join(".complete"), b"")?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_dir_all(&dir);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn archive_paths_stay_inside() {
        assert_eq!(strip_top(Path::new("model-x/tokens.txt")), Some(PathBuf::from("tokens.txt")));
        assert_eq!(strip_top(Path::new("model-x/test_wavs/0.wav")), Some(PathBuf::from("test_wavs/0.wav")));
        assert_eq!(strip_top(Path::new("model-x/../../evil")), None);
        assert_eq!(strip_top(Path::new("model-x")), None);
    }

    #[test]
    fn table_is_consistent() {
        for m in MODELS {
            assert!(m.size() > 0);
            if let Source::Files(files) = &m.source {
                assert!(files.iter().any(|f| f.0 == m.tokens), "{} tokens file is downloaded", m.id);
            }
            assert_eq!(MODELS.iter().filter(|x| x.id == m.id).count(), 1, "ids are unique");
        }
    }
}

// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2

//! Shared fixtures of the vault tests. Every note is synthetic.

#![allow(dead_code)]
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

static COUNTER: AtomicU32 = AtomicU32::new(0);

/// A scratch directory removed on drop. The name carries the process id and a
/// counter, so two tests of one run never share a directory.
pub struct Scratch(PathBuf);

impl Scratch {
    pub fn new() -> Self {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let path =
            std::env::temp_dir().join(format!("notebook-vault-test-{}-{n}", std::process::id()));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }

    pub fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// Every file below `root`, as `/`-separated relative paths, in sorted order.
pub fn listing(root: &Path) -> BTreeSet<String> {
    fn walk(root: &Path, directory: &Path, found: &mut BTreeSet<String>) {
        for entry in fs::read_dir(directory).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                walk(root, &path, found);
            } else {
                let relative = path.strip_prefix(root).unwrap();
                found.insert(relative.to_str().unwrap().replace('\\', "/"));
            }
        }
    }
    let mut found = BTreeSet::new();
    walk(root, root, &mut found);
    found
}

/// The byte traps of CA-34 (`tools/qualification/p04-tauri/cr10k.ts`): line
/// endings, BOM, tabs, trailing spaces, a missing final newline, NFC and NFD,
/// characters outside the BMP; then three more an editor must not repair: the
/// empty file, a NUL byte, and bytes that are not UTF-8.
pub fn byte_traps() -> Vec<(&'static str, Vec<u8>)> {
    vec![
        ("crlf", b"# Title\r\n\r\nline one\r\nline two\r\n".to_vec()),
        ("lone-cr", b"# Title\rline one\rline two\r".to_vec()),
        ("bom", b"\xEF\xBB\xBF# Title\n\nbody\n".to_vec()),
        ("tabs", b"- item\n\t- nested\n\t\t- deeper\n".to_vec()),
        (
            "trailing-spaces",
            b"hard break  \nsecond \t \nthird\n".to_vec(),
        ),
        (
            "no-final-newline",
            b"# Title\n\nlast line without newline".to_vec(),
        ),
        ("nfc", "caf\u{e9} \u{e9}t\u{e9}\n".as_bytes().to_vec()),
        ("nfd", "cafe\u{301} e\u{301}te\u{301}\n".as_bytes().to_vec()),
        (
            "non-bmp",
            "emoji \u{1F600} and \u{10348} and \u{1D11E}\n"
                .as_bytes()
                .to_vec(),
        ),
        ("empty", Vec::new()),
        ("nul-byte", b"before\0after\n".to_vec()),
        ("invalid-utf8", vec![0xFF, 0xFE, 0x80, b'\n', 0xC0, 0xAF]),
        ("every-byte-value", (0..=255u8).collect()),
    ]
}

/// 1 MiB of deterministic bytes covering all 256 values (a linear congruential
/// generator, seed fixed): a large body with no structure to lean on.
pub fn one_mebibyte() -> Vec<u8> {
    let mut state: u32 = 0x1234_5678;
    (0..1_048_576)
        .map(|_| {
            state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            state.to_be_bytes()[0]
        })
        .collect()
}

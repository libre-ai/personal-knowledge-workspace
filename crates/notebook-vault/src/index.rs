// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2

//! The full-text index: an in-memory inverted index derived from the folder.
//! Nothing of it is persisted (EF-P04-4): losing it costs one `rebuild_index`.

use std::collections::HashMap;
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::Serialize;
use unicode_normalization::UnicodeNormalization;
use unicode_normalization::char::is_combining_mark;

use crate::error::VaultError;
use crate::path::NOTE_EXTENSION;
use crate::vault::MAX_NOTE_BYTES;

/// Most hits a search returns.
pub const MAX_SEARCH_RESULTS: usize = 100;
const MAX_QUERY_BYTES: usize = 1024;
const MAX_QUERY_TOKENS: usize = 16;
/// Longer words are not indexed: they are hashes and encoded blobs, not words.
const MAX_TOKEN_BYTES: usize = 64;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SearchHit {
    pub path: String,
    /// The sum, over the words of the query, of their occurrences in the note.
    pub score: u32,
}

/// What a rebuild saw. `notes + ignored + unreadable` is the number of
/// directory entries that are not directories; a hidden directory counts once,
/// as ignored, and is not entered.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct IndexStats {
    pub notes: usize,
    /// Hidden entries, symbolic links, files that are not `.md` notes.
    pub ignored: usize,
    /// Notes that could not be read or exceed the size limit.
    pub unreadable: usize,
    /// Distinct words in the index.
    pub terms: usize,
}

#[derive(Debug)]
struct Document {
    path: String,
    terms: Vec<u32>,
}

#[derive(Debug, Default)]
pub(crate) struct Index {
    term_ids: HashMap<Box<str>, u32>,
    /// Per term id: `(document id, occurrences)`, sorted by document id.
    postings: Vec<Vec<(u32, u32)>>,
    /// A rewritten note takes a new id at the end; its old slot becomes `None`.
    documents: Vec<Option<Document>>,
    /// Keyed by the lowercase NFC form of the path (see `path_key`), not by the spelling.
    by_path: HashMap<String, u32>,
}

/// The key of a path in the index. APFS as shipped on a Mac keeps the spelling
/// a name was created with and compares names regardless of Unicode
/// normalisation and of case, so `café.md` written with a precomposed or a
/// decomposed é, and `Case.md` and `case.md`, are one file there; keyed by the
/// raw string each pair would be two entries and the older one would outlive
/// its text. The document keeps the spelling of the latest write, which the
/// file system opens. A file system that tells the spellings apart (Linux,
/// NTFS, APFS formatted case-sensitive) holds two files under one key: the
/// entry is the one indexed last, until the next `rebuild_index`.
///
/// shortcut: the case is folded by `char::to_lowercase`, not by the full case
/// folding of the file system (`ς` and `σ`, `ß` and `ss` stay distinct keys);
/// upgrade trigger: a note name observed on APFS that differs from another only
/// by such a pair, then a case-folding crate.
fn path_key(path: &str) -> String {
    path.chars().flat_map(char::to_lowercase).nfc().collect()
}

/// Calls `emit` with each word of `text`: lowercase, without combining marks,
/// so that NFC and NFD spellings of a word, and its capitalised form, are one
/// term. A word is a run of alphanumeric characters.
fn for_each_word(text: &str, mut emit: impl FnMut(String)) {
    let mut word = String::new();
    for character in text.nfd() {
        if is_combining_mark(character) {
            continue;
        }
        if character.is_alphanumeric() {
            word.extend(character.to_lowercase());
        } else if !word.is_empty() {
            emit(std::mem::take(&mut word));
        }
    }
    if !word.is_empty() {
        emit(word);
    }
}

impl Index {
    /// Walks `root` in sorted order and indexes every `.md` note. A hidden entry
    /// and a symbolic link are ignored (a link could lead outside the vault).
    pub(crate) fn build(root: &Path) -> Result<(Self, IndexStats), VaultError> {
        let mut candidates: Vec<String> = Vec::new();
        let mut ignored = 0;
        let mut unreadable = 0;
        let mut pending: Vec<PathBuf> = vec![PathBuf::new()];
        while let Some(relative) = pending.pop() {
            let entries = match fs::read_dir(root.join(&relative)) {
                Ok(entries) => entries,
                // The root itself must be readable; a subdirectory that is not is counted.
                Err(error) if relative.as_os_str().is_empty() => return Err(error.into()),
                Err(_) => {
                    unreadable += 1;
                    continue;
                }
            };
            for entry in entries {
                let Ok(entry) = entry else {
                    unreadable += 1;
                    continue;
                };
                let file_name = entry.file_name();
                let Some(name) = file_name.to_str() else {
                    ignored += 1;
                    continue;
                };
                let Ok(kind) = entry.file_type() else {
                    unreadable += 1;
                    continue;
                };
                if name.starts_with('.') || kind.is_symlink() {
                    ignored += 1;
                } else if kind.is_dir() {
                    pending.push(relative.join(name));
                } else if kind.is_file() && name.ends_with(NOTE_EXTENSION) {
                    let note = relative.join(name);
                    match note.to_str() {
                        Some(text) => candidates.push(text.replace(std::path::MAIN_SEPARATOR, "/")),
                        None => ignored += 1,
                    }
                } else {
                    ignored += 1;
                }
            }
        }
        candidates.sort();

        let mut index = Self::default();
        let mut notes = 0;
        for path in &candidates {
            let mut bytes = Vec::new();
            let read = File::open(root.join(path))
                .and_then(|file| file.take(MAX_NOTE_BYTES as u64 + 1).read_to_end(&mut bytes));
            if read.is_err() || bytes.len() > MAX_NOTE_BYTES {
                unreadable += 1;
                continue;
            }
            index.update(path, &bytes);
            notes += 1;
        }
        let stats = IndexStats {
            notes,
            ignored,
            unreadable,
            terms: index.term_ids.len(),
        };
        Ok((index, stats))
    }

    /// Replaces the entry of `path` by the words of `bytes`. Bytes that are not
    /// UTF-8 are indexed through their lossy decoding: the replacement
    /// character separates words, the rest still answers searches.
    pub(crate) fn update(&mut self, path: &str, bytes: &[u8]) {
        let key = path_key(path);
        self.remove(&key);
        let Ok(id) = u32::try_from(self.documents.len()) else {
            return;
        };
        let text = String::from_utf8_lossy(bytes);
        let mut frequencies: HashMap<u32, u32> = HashMap::new();
        for_each_word(&text, |word| {
            if word.len() > MAX_TOKEN_BYTES {
                return;
            }
            let term = self.term_id(word);
            let count = frequencies.entry(term).or_insert(0);
            *count = count.saturating_add(1);
        });
        let mut terms: Vec<u32> = frequencies.keys().copied().collect();
        terms.sort_unstable();
        for term in &terms {
            let count = frequencies.get(term).copied().unwrap_or(0);
            if let Some(list) = self.postings.get_mut(*term as usize) {
                list.push((id, count));
            }
        }
        self.documents.push(Some(Document {
            path: path.to_owned(),
            terms,
        }));
        self.by_path.insert(key, id);
    }

    fn term_id(&mut self, word: String) -> u32 {
        if let Some(id) = self.term_ids.get(word.as_str()) {
            return *id;
        }
        let id = u32::try_from(self.postings.len()).unwrap_or(u32::MAX);
        self.postings.push(Vec::new());
        self.term_ids.insert(word.into_boxed_str(), id);
        id
    }

    /// Removes the entry under `key`, a value of `path_key`.
    fn remove(&mut self, key: &str) {
        let Some(id) = self.by_path.remove(key) else {
            return;
        };
        let Some(document) = self.documents.get_mut(id as usize).and_then(Option::take) else {
            return;
        };
        for term in document.terms {
            if let Some(list) = self.postings.get_mut(term as usize)
                && let Ok(position) = list.binary_search_by_key(&id, |entry| entry.0)
            {
                list.remove(position);
            }
        }
    }

    /// Every word of the query must be in the note; best score first, then path.
    pub(crate) fn search(&self, query: &str) -> Result<Vec<SearchHit>, VaultError> {
        if query.len() > MAX_QUERY_BYTES {
            return Err(VaultError::InvalidQuery);
        }
        let mut words: Vec<String> = Vec::new();
        let mut seen = 0;
        for_each_word(query, |word| {
            seen += 1;
            words.push(word);
        });
        if seen == 0 || seen > MAX_QUERY_TOKENS || words.iter().any(|w| w.len() > MAX_TOKEN_BYTES) {
            return Err(VaultError::InvalidQuery);
        }
        words.sort_unstable();
        words.dedup();

        let mut lists: Vec<&[(u32, u32)]> = Vec::with_capacity(words.len());
        for word in &words {
            let list = self
                .term_ids
                .get(word.as_str())
                .and_then(|id| self.postings.get(*id as usize));
            match list {
                Some(list) if !list.is_empty() => lists.push(list.as_slice()),
                _ => return Ok(Vec::new()),
            }
        }
        lists.sort_by_key(|list| list.len());
        let Some((shortest, others)) = lists.split_first() else {
            return Ok(Vec::new());
        };

        let mut hits: Vec<SearchHit> = Vec::new();
        for &(document, occurrences) in *shortest {
            let mut score = occurrences;
            let mut in_all = true;
            for other in others {
                match other.binary_search_by_key(&document, |entry| entry.0) {
                    Ok(position) => {
                        score =
                            score.saturating_add(other.get(position).map_or(0, |entry| entry.1));
                    }
                    Err(_) => {
                        in_all = false;
                        break;
                    }
                }
            }
            let path = self
                .documents
                .get(document as usize)
                .and_then(Option::as_ref);
            if let (true, Some(found)) = (in_all, path) {
                hits.push(SearchHit {
                    path: found.path.clone(),
                    score,
                });
            }
        }
        hits.sort_by(|a, b| b.score.cmp(&a.score).then_with(|| a.path.cmp(&b.path)));
        hits.truncate(MAX_SEARCH_RESULTS);
        Ok(hits)
    }
}

#[cfg(test)]
mod tests;

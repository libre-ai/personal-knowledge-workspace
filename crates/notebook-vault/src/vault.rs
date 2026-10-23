// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2

use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{RwLock, RwLockReadGuard, RwLockWriteGuard};

use crate::atomic::{Faults, NoFaults, write_atomic};
use crate::error::VaultError;
use crate::index::{Index, IndexStats, SearchHit};
use crate::path::components;
use crate::revision::Revision;

/// Largest note the vault reads, writes, previews or indexes: 16 MiB. The
/// largest note of the qualification corpus is 1 MiB (CA-34); the limit keeps a
/// hostile or runaway file from filling the memory of the application.
pub const MAX_NOTE_BYTES: usize = 16 * 1024 * 1024;

/// A note as it is on disk: its exact bytes and their revision.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Note {
    pub bytes: Vec<u8>,
    pub revision: Revision,
}

/// An opened folder of Markdown notes.
#[derive(Debug)]
pub struct Vault {
    root: PathBuf,
    /// Derived data (EF-P04-4): absent until `rebuild_index`, never persisted.
    index: RwLock<Option<Index>>,
}

impl Vault {
    /// Opens `directory`, which must be an absolute path to a directory. The
    /// root is resolved once (symbolic links included) and every later path is
    /// resolved below it.
    pub fn open(directory: &Path) -> Result<Self, VaultError> {
        if !directory.is_absolute() {
            return Err(VaultError::InvalidVault);
        }
        let root = fs::canonicalize(directory).map_err(|_| VaultError::InvalidVault)?;
        if !root.is_dir() {
            return Err(VaultError::InvalidVault);
        }
        Ok(Self {
            root,
            index: RwLock::new(None),
        })
    }

    /// The exact bytes of the note and their revision.
    pub fn read_note(&self, path: &str) -> Result<Note, VaultError> {
        let full = self.resolve(path)?;
        let metadata = fs::symlink_metadata(&full)?;
        if !metadata.is_file() {
            return Err(VaultError::InvalidPath);
        }
        let mut bytes = Vec::new();
        // One byte past the limit tells a file that grew after the check from one at the limit.
        File::open(&full)?
            .take(MAX_NOTE_BYTES as u64 + 1)
            .read_to_end(&mut bytes)?;
        if bytes.len() > MAX_NOTE_BYTES {
            return Err(VaultError::TooLarge);
        }
        let revision = Revision::of(&bytes);
        Ok(Note { bytes, revision })
    }

    /// Replaces the note by exactly `bytes`, or creates it when `expected` is
    /// `None`. A failed write leaves the previous file intact.
    pub fn write_note(
        &self,
        path: &str,
        bytes: &[u8],
        expected: Option<&Revision>,
    ) -> Result<Revision, VaultError> {
        self.write_note_with(path, bytes, expected, &NoFaults)
    }

    /// [`Vault::write_note`] with failure injection at each step of the write.
    pub fn write_note_with(
        &self,
        path: &str,
        bytes: &[u8],
        expected: Option<&Revision>,
        faults: &dyn Faults,
    ) -> Result<Revision, VaultError> {
        if bytes.len() > MAX_NOTE_BYTES {
            return Err(VaultError::TooLarge);
        }
        let full = self.resolve(path)?;
        write_atomic(&full, bytes, expected, faults)?;
        // The rename took place: the index follows the file it derives from.
        if let Some(index) = self.index_write()?.as_mut() {
            index.update(path, bytes);
        }
        Ok(Revision::of(bytes))
    }

    /// Scans the folder and replaces the index by one built from it.
    pub fn rebuild_index(&self) -> Result<IndexStats, VaultError> {
        let (index, stats) = Index::build(&self.root)?;
        *self.index_write()? = Some(index);
        Ok(stats)
    }

    /// The notes holding every word of `query`, best first.
    pub fn search(&self, query: &str) -> Result<Vec<SearchHit>, VaultError> {
        self.index_read()?
            .as_ref()
            .ok_or(VaultError::IndexMissing)?
            .search(query)
    }

    /// The absolute path of a note, once the grammar holds and no component
    /// that exists is a symbolic link or, for a directory component, a file.
    fn resolve(&self, path: &str) -> Result<PathBuf, VaultError> {
        let parts = components(path)?;
        let mut full = self.root.clone();
        let mut exists = true;
        for (position, part) in parts.iter().enumerate() {
            full.push(part);
            if !exists {
                continue;
            }
            match fs::symlink_metadata(&full) {
                Ok(metadata) => {
                    // `symlink_metadata` does not follow a link: a link is neither a
                    // file nor a directory here, so it is refused with the rest.
                    let last = position + 1 == parts.len();
                    let expected_kind = if last {
                        metadata.is_file()
                    } else {
                        metadata.is_dir()
                    };
                    if !expected_kind {
                        return Err(VaultError::InvalidPath);
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => exists = false,
                Err(error) => return Err(error.into()),
            }
        }
        Ok(full)
    }

    fn index_read(&self) -> Result<RwLockReadGuard<'_, Option<Index>>, VaultError> {
        self.index
            .read()
            .map_err(|_| VaultError::Io(std::io::ErrorKind::Other))
    }

    fn index_write(&self) -> Result<RwLockWriteGuard<'_, Option<Index>>, VaultError> {
        self.index
            .write()
            .map_err(|_| VaultError::Io(std::io::ErrorKind::Other))
    }
}

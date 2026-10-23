// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2

//! Atomic replacement of a note: the new bytes go to a temporary file in the
//! same directory, are flushed to the disk, and replace the note by a rename.
//! The note is therefore always either the old file or the new one, whole.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

use crate::error::VaultError;
use crate::revision::Revision;
use crate::vault::MAX_NOTE_BYTES;

/// Size of the slices written to the temporary file, so that a failure can
/// land between two of them (a partial file) and be tested.
const WRITE_CHUNK: usize = 64 * 1024;
const TEMP_ATTEMPTS: u32 = 8;

static TEMP_COUNTER: AtomicU32 = AtomicU32::new(0);

/// The points of a write at which an error can be injected.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WriteStep {
    CreateTemp,
    /// Reached before each slice of the temporary file.
    WriteTemp,
    SyncTemp,
    Rename,
    /// After the rename: the note is the new file, only its durability is in doubt.
    SyncDirectory,
}

/// Failure injection for the write path. Production code passes [`NoFaults`];
/// the tests of CA-39 pass an implementation that fails at one step.
pub trait Faults {
    fn before(&self, step: WriteStep) -> io::Result<()>;
}

#[derive(Debug, Clone, Copy, Default)]
pub struct NoFaults;

impl Faults for NoFaults {
    fn before(&self, _step: WriteStep) -> io::Result<()> {
        Ok(())
    }
}

/// Removes the temporary file unless the rename took it.
struct TempFile {
    path: PathBuf,
    armed: bool,
}

impl Drop for TempFile {
    fn drop(&mut self) {
        if self.armed {
            // Best effort: the original is intact either way, and this file is
            // hidden from the vault (a `.`-prefixed name) and from the index.
            let _ = fs::remove_file(&self.path);
        }
    }
}

fn create_temp(directory: &Path) -> io::Result<(File, TempFile)> {
    let mut last = io::Error::from(io::ErrorKind::AlreadyExists);
    for _ in 0..TEMP_ATTEMPTS {
        let n = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let path = directory.join(format!(".vault-write-{}-{n}.tmp", std::process::id()));
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(file) => return Ok((file, TempFile { path, armed: true })),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => last = error,
            Err(error) => return Err(error),
        }
    }
    Err(last)
}

/// The revision check, run once the temporary file is complete and right
/// before the rename, which leaves the narrowest window between the check and
/// the replacement. A writer that is not this process can still slip in between
/// the two; the vault has one writer, and EF-P04-6 owns the merge of the others.
fn check_revision(target: &Path, expected: Option<&Revision>) -> Result<(), VaultError> {
    let current = match File::open(target) {
        Ok(file) => {
            let mut bytes = Vec::new();
            file.take(MAX_NOTE_BYTES as u64 + 1)
                .read_to_end(&mut bytes)?;
            Some(bytes)
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => None,
        Err(error) => return Err(error.into()),
    };
    match (current, expected) {
        (None, None) => Ok(()),
        (None, Some(_)) => Err(VaultError::NotFound),
        (Some(_), None) => Err(VaultError::RevisionConflict),
        (Some(bytes), Some(revision)) if Revision::of(&bytes) == *revision => Ok(()),
        (Some(_), Some(_)) => Err(VaultError::RevisionConflict),
    }
}

/// Replaces `target` by `bytes`. `expected` is `None` to create the note (it
/// must not exist) or the revision the caller read.
pub(crate) fn write_atomic(
    target: &Path,
    bytes: &[u8],
    expected: Option<&Revision>,
    faults: &dyn Faults,
) -> Result<(), VaultError> {
    let directory = target.parent().ok_or(VaultError::InvalidPath)?;
    fs::create_dir_all(directory)?;

    faults.before(WriteStep::CreateTemp)?;
    let (mut file, mut temp) = create_temp(directory)?;

    if bytes.is_empty() {
        faults.before(WriteStep::WriteTemp)?;
    }
    for chunk in bytes.chunks(WRITE_CHUNK) {
        faults.before(WriteStep::WriteTemp)?;
        file.write_all(chunk)?;
    }
    faults.before(WriteStep::SyncTemp)?;
    file.sync_all()?;

    // A rewrite keeps the mode of the note it replaces.
    if let Ok(metadata) = fs::metadata(target) {
        file.set_permissions(metadata.permissions())?;
    }
    drop(file);

    check_revision(target, expected)?;

    faults.before(WriteStep::Rename)?;
    fs::rename(&temp.path, target)?;
    temp.armed = false;

    faults.before(WriteStep::SyncDirectory)?;
    File::open(directory)?.sync_all()?;
    Ok(())
}

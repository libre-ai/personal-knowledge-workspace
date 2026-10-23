// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2

use std::fmt;
use std::io;

/// Every refusal the vault can give. The set is closed and every variant is a
/// `vault.*` code: no free text, no path and no operating-system message
/// crosses the bridge or reaches a log (EF-P04-9, interface table of the
/// requirements specification, section 6).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VaultError {
    /// The folder to open is not an absolute path to a readable directory.
    InvalidVault,
    /// The note path is outside the grammar of `path.rs`, crosses a symbolic
    /// link, or is a name the operating system refuses (too long below this root).
    InvalidPath,
    NotFound,
    /// The expected revision is not the current one (or the note exists and none was expected).
    RevisionConflict,
    /// A revision that is not 64 lowercase hexadecimal digits.
    InvalidRevision,
    TooLarge,
    NotUtf8,
    InvalidQuery,
    /// `search` before any `rebuild_index`.
    IndexMissing,
    /// An operating-system failure. The kind is kept for tests and diagnosis in
    /// Rust; it is never part of the code.
    Io(io::ErrorKind),
}

impl VaultError {
    /// The codes in declaration order, for the tests that close the list.
    pub const CODES: [&'static str; 10] = [
        "vault.invalid_vault",
        "vault.invalid_path",
        "vault.not_found",
        "vault.revision_conflict",
        "vault.invalid_revision",
        "vault.too_large",
        "vault.not_utf8",
        "vault.invalid_query",
        "vault.index_missing",
        "vault.io",
    ];

    pub fn code(self) -> &'static str {
        match self {
            Self::InvalidVault => "vault.invalid_vault",
            Self::InvalidPath => "vault.invalid_path",
            Self::NotFound => "vault.not_found",
            Self::RevisionConflict => "vault.revision_conflict",
            Self::InvalidRevision => "vault.invalid_revision",
            Self::TooLarge => "vault.too_large",
            Self::NotUtf8 => "vault.not_utf8",
            Self::InvalidQuery => "vault.invalid_query",
            Self::IndexMissing => "vault.index_missing",
            Self::Io(_) => "vault.io",
        }
    }
}

impl fmt::Display for VaultError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code())
    }
}

impl std::error::Error for VaultError {}

impl From<io::Error> for VaultError {
    fn from(error: io::Error) -> Self {
        match error.kind() {
            io::ErrorKind::NotFound => Self::NotFound,
            // The system's own refusal of a name: a path inside the grammar can
            // exceed its limit once the vault root is put in front of it.
            io::ErrorKind::InvalidFilename => Self::InvalidPath,
            kind => Self::Io(kind),
        }
    }
}

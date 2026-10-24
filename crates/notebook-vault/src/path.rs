// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2

use crate::error::VaultError;

const MAX_PATH_BYTES: usize = 1024;
const MAX_COMPONENT_BYTES: usize = 255;

/// The extension of a note. Lowercase only, like the corpus of the qualification.
pub(crate) const NOTE_EXTENSION: &str = ".md";

/// Splits a note path into its components, or refuses it. The grammar is the
/// whole defence against a path that leaves the vault, so it is closed rather
/// than a list of forbidden forms: relative, `/`-separated, no empty,
/// `.`-prefixed (so `.`, `..`, `.git`, `.obsidian` and the vault's own
/// temporary files) or oversized component, no control character, no
/// backslash, and the last component ends in `.md`.
pub(crate) fn components(path: &str) -> Result<Vec<&str>, VaultError> {
    if path.is_empty() || path.len() > MAX_PATH_BYTES {
        return Err(VaultError::InvalidPath);
    }
    if path.chars().any(|c| c.is_control() || c == '\\') {
        return Err(VaultError::InvalidPath);
    }
    let parts: Vec<&str> = path.split('/').collect();
    let valid = parts.iter().all(|part| {
        !part.is_empty() && part.len() <= MAX_COMPONENT_BYTES && !part.starts_with('.')
    });
    let is_note = parts
        .last()
        .is_some_and(|last| last.ends_with(NOTE_EXTENSION));
    if valid && is_note {
        Ok(parts)
    } else {
        Err(VaultError::InvalidPath)
    }
}

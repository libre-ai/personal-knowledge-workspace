// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2

use std::fmt::Write as _;

use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::error::VaultError;

/// The revision of a note: the SHA-256 of its exact bytes, as 64 lowercase
/// hexadecimal digits. It is the "empreinte" of the `vault_changed` event and
/// the guard of `write_note`, and it is derived from the bytes alone: two
/// copies of the same file have the same revision, whoever wrote them.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize)]
#[serde(transparent)]
pub struct Revision(String);

impl Revision {
    pub const LEN: usize = 64;

    pub fn of(bytes: &[u8]) -> Self {
        let mut text = String::with_capacity(Self::LEN);
        for byte in Sha256::digest(bytes).iter() {
            // Writing to a String cannot fail.
            let _ = write!(text, "{byte:02x}");
        }
        Self(text)
    }

    pub fn parse(text: &str) -> Result<Self, VaultError> {
        let valid = text.len() == Self::LEN
            && text
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
        if valid {
            Ok(Self(text.to_owned()))
        } else {
            Err(VaultError::InvalidRevision)
        }
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

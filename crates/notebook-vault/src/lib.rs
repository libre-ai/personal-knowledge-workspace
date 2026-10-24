// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2

//! The Rust core of the P04 vault (EF-P04-9): byte-faithful reads and atomic
//! writes of Markdown notes, the Markdown preview as an attribute tree, and the
//! full-text index. It is distinct from `notebook-core`, which EF-P04-2 forbids
//! any filesystem access; the desktop shell reaches this crate through its
//! bridge commands and the front reimplements none of it (CA-40).
//!
//! The Markdown on disk is the only authority (EF-P04-4): the index is derived
//! from the folder and rebuilt from it, nothing else is persisted.

mod atomic;
mod error;
mod index;
mod path;
mod preview;
mod revision;
mod root;
mod vault;

pub use atomic::{Faults, NoFaults, WriteStep};
pub use error::VaultError;
pub use index::{IndexStats, MAX_SEARCH_RESULTS, SearchHit};
pub use preview::{MAX_PREVIEW_DEPTH, MAX_PREVIEW_NODES, NodeKind, PreviewNode, render_preview};
pub use revision::Revision;
pub use root::{HOME_FORBIDDEN_DIRS, RootPolicy, SYSTEM_DIRS};
pub use vault::{MAX_NOTE_BYTES, Note, Vault};

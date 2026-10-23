// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use super::Index;

/// Reaches the key of the index, which the public API only reaches through a
/// file system that treats two spellings as one file (APFS).
#[test]
fn the_index_key_ignores_the_unicode_spelling_of_a_path() {
    let nfc = "caf\u{e9}.md";
    let nfd = "cafe\u{301}.md";
    assert_ne!(nfc, nfd);

    let mut index = Index::default();
    index.update(nfc, b"alpha original\n");
    index.update(nfd, b"beta rewritten\n");

    assert!(index.search("alpha").unwrap().is_empty(), "stale entry");
    let hits = index.search("beta").unwrap();
    assert_eq!(hits.len(), 1);
    // The hit carries the spelling of the latest write, which the file system opens.
    assert_eq!(hits[0].path, nfd);
}

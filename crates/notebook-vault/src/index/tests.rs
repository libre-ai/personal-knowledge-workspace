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

/// A volume that ignores case (APFS as shipped on a Mac) holds `Case.md` and
/// `case.md` in one file: a rewrite under the other spelling must replace the
/// entry, not add a second one beside a stale text.
#[test]
fn the_index_key_ignores_the_case_of_a_path() {
    let mut index = Index::default();
    index.update("Case.md", b"alpha original\n");
    index.update("case.md", b"beta rewritten\n");

    assert!(index.search("alpha").unwrap().is_empty(), "stale entry");
    let hits = index.search("beta").unwrap();
    assert_eq!(hits.len(), 1);
    // The hit carries the spelling of the latest write, which the file system opens.
    assert_eq!(hits[0].path, "case.md");
}

/// Case and Unicode spelling fold together: `É` precomposed, `e` + U+0301 in
/// lowercase, and `é` are one key.
#[test]
fn the_index_key_folds_case_and_unicode_spelling_together() {
    let mut index = Index::default();
    index.update("CAF\u{c9}.md", b"alpha original\n");
    index.update("cafe\u{301}.md", b"beta rewritten\n");

    assert!(index.search("alpha").unwrap().is_empty(), "stale entry");
    assert_eq!(index.search("beta").unwrap().len(), 1);
}

// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2

//! EF-P04-9, EF-P04-4: the full-text index is derived from the folder alone and
//! can be rebuilt from it; `search` answers from the index, never from the disk.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod common;

use std::fs;

use libre_ai_notebook_vault::{MAX_SEARCH_RESULTS, SearchHit, Vault, VaultError};

use common::Scratch;

fn paths(hits: &[SearchHit]) -> Vec<&str> {
    hits.iter().map(|h| h.path.as_str()).collect()
}

fn vault_with(notes: &[(&str, &str)]) -> (Scratch, Vault) {
    let scratch = Scratch::new();
    for (path, text) in notes {
        let full = scratch.path().join(path);
        fs::create_dir_all(full.parent().unwrap()).unwrap();
        fs::write(full, text).unwrap();
    }
    let vault = Vault::open(scratch.path()).unwrap();
    (scratch, vault)
}

#[test]
fn search_before_a_rebuild_is_a_closed_refusal() {
    let (_scratch, vault) = vault_with(&[("a.md", "alpha\n")]);
    assert_eq!(vault.search("alpha"), Err(VaultError::IndexMissing));
}

#[test]
fn the_rebuild_counts_what_it_indexed_and_what_it_left_out() {
    let (scratch, vault) = vault_with(&[
        ("a.md", "alpha beta\n"),
        ("sub/b.md", "beta gamma\n"),
        ("sub/deep/c.md", "gamma delta\n"),
        ("image.png", "not a note"),
        (".hidden.md", "hidden"),
        (".git/config.md", "hidden dir"),
        ("UPPER.MD", "wrong case"),
    ]);
    let stats = vault.rebuild_index().unwrap();
    println!("rebuild: {stats:?}");
    assert_eq!(stats.notes, 3);
    assert_eq!(stats.ignored, 4);
    assert_eq!(stats.unreadable, 0);
    // beta, alpha, gamma, delta
    assert_eq!(stats.terms, 4);

    // A file larger than the limit is counted as unreadable, not dropped silently.
    let big = fs::File::create(scratch.path().join("big.md")).unwrap();
    big.set_len(libre_ai_notebook_vault::MAX_NOTE_BYTES as u64 + 1)
        .unwrap();
    let stats = vault.rebuild_index().unwrap();
    assert_eq!((stats.notes, stats.ignored, stats.unreadable), (3, 4, 1));
}

#[test]
fn search_is_a_conjunction_of_whole_words_ranked_by_frequency() {
    let (_scratch, vault) = vault_with(&[
        ("a.md", "rust rust rust and tauri\n"),
        ("b.md", "rust and tauri\n"),
        ("c.md", "rust only\n"),
        ("d.md", "trust thrust\n"),
    ]);
    vault.rebuild_index().unwrap();

    assert_eq!(
        paths(&vault.search("rust").unwrap()),
        ["a.md", "b.md", "c.md"]
    );
    let hits = vault.search("rust tauri").unwrap();
    assert_eq!(paths(&hits), ["a.md", "b.md"]);
    assert_eq!(hits[0].score, 4);
    assert_eq!(hits[1].score, 2);
    // A word that no note holds, even beside one that matches, answers nothing.
    assert!(vault.search("rust absent").unwrap().is_empty());
    // The same word twice counts once; order does not matter.
    assert_eq!(
        vault.search("tauri RUST rust").unwrap(),
        vault.search("rust tauri").unwrap()
    );
}

#[test]
fn case_and_accents_do_not_change_the_answer_and_nfc_equals_nfd() {
    let (_scratch, vault) = vault_with(&[
        ("nfc.md", "Le \u{e9}t\u{e9} du Gar\u{e7}on\n"),
        ("nfd.md", "le e\u{301}te\u{301} du Garc\u{327}on\n"),
        ("plain.md", "ete garcon\n"),
        ("other.md", "winter\n"),
    ]);
    vault.rebuild_index().unwrap();
    for query in ["\u{e9}t\u{e9}", "e\u{301}te\u{301}", "ETE", "\u{c9}T\u{c9}"] {
        assert_eq!(
            paths(&vault.search(query).unwrap()),
            ["nfc.md", "nfd.md", "plain.md"],
            "{query:?}"
        );
    }
}

#[test]
fn punctuation_and_markup_separate_words() {
    let (_scratch, vault) = vault_with(&[(
        "a.md",
        "# Title: [[Link-Target|alias]] `code_span` **bold**\n",
    )]);
    vault.rebuild_index().unwrap();
    for word in ["title", "link", "target", "alias", "code", "span", "bold"] {
        assert_eq!(paths(&vault.search(word).unwrap()), ["a.md"], "{word}");
    }
}

#[test]
fn a_write_updates_the_index_without_a_rebuild() {
    let (_scratch, vault) = vault_with(&[("a.md", "before\n")]);
    vault.rebuild_index().unwrap();
    let revision = vault.read_note("a.md").unwrap().revision;
    vault
        .write_note("a.md", b"after\n", Some(&revision))
        .unwrap();
    vault
        .write_note("new/b.md", b"after again\n", None)
        .unwrap();
    assert!(vault.search("before").unwrap().is_empty());
    assert_eq!(paths(&vault.search("after").unwrap()), ["a.md", "new/b.md"]);
}

#[test]
fn the_index_is_derived_from_the_folder_alone() {
    // EF-P04-4: drop the index (a new Vault holds none), rebuild, same answers.
    let (scratch, vault) = vault_with(&[("a.md", "alpha beta\n"), ("s/b.md", "beta gamma\n")]);
    vault.rebuild_index().unwrap();
    vault.write_note("s/c.md", b"beta delta\n", None).unwrap();
    let before = vault.search("beta").unwrap();

    let reopened = Vault::open(scratch.path()).unwrap();
    assert_eq!(reopened.search("beta"), Err(VaultError::IndexMissing));
    reopened.rebuild_index().unwrap();
    assert_eq!(reopened.search("beta").unwrap(), before);
    assert!(!fs::read_dir(scratch.path()).unwrap().any(|e| {
        let name = e.unwrap().file_name();
        let name = name.to_string_lossy().to_string();
        name.contains("index")
    }));
}

#[test]
fn a_query_that_cannot_be_answered_is_refused() {
    let (_scratch, vault) = vault_with(&[("a.md", "a alpha\n")]);
    vault.rebuild_index().unwrap();
    for query in [
        "",
        "   ",
        "!!! ??? ---",
        &"a ".repeat(17),
        &"x".repeat(1025),
    ] {
        assert_eq!(
            vault.search(query),
            Err(VaultError::InvalidQuery),
            "{query:?}"
        );
    }
    assert_eq!(vault.search(&"a ".repeat(16)).map(|h| h.len()), Ok(1));
}

#[test]
fn results_are_capped_and_ordered_deterministically() {
    let notes: Vec<(String, String)> = (0..MAX_SEARCH_RESULTS + 20)
        .map(|n| (format!("n/note-{n:05}.md"), "common\n".to_string()))
        .collect();
    let refs: Vec<(&str, &str)> = notes
        .iter()
        .map(|(p, t)| (p.as_str(), t.as_str()))
        .collect();
    let (_scratch, vault) = vault_with(&refs);
    vault.rebuild_index().unwrap();
    let hits = vault.search("common").unwrap();
    assert_eq!(hits.len(), MAX_SEARCH_RESULTS);
    let mut sorted = paths(&hits)
        .iter()
        .map(|p| p.to_string())
        .collect::<Vec<_>>();
    sorted.sort();
    assert_eq!(
        paths(&hits),
        sorted.iter().map(String::as_str).collect::<Vec<_>>()
    );
    assert_eq!(
        hits.first().map(|h| h.path.as_str()),
        Some("n/note-00000.md")
    );
}

#[cfg(unix)]
#[test]
fn a_symbolic_link_is_ignored_by_the_index_and_counted() {
    use std::os::unix::fs::symlink;

    let outside = Scratch::new();
    fs::write(outside.path().join("secret.md"), "confidential words\n").unwrap();
    let (scratch, vault) = vault_with(&[("a.md", "public\n")]);
    symlink(
        outside.path().join("secret.md"),
        scratch.path().join("link.md"),
    )
    .unwrap();
    symlink(outside.path(), scratch.path().join("linked-dir")).unwrap();
    let stats = vault.rebuild_index().unwrap();
    assert_eq!((stats.notes, stats.ignored), (1, 2));
    assert!(vault.search("confidential").unwrap().is_empty());
}

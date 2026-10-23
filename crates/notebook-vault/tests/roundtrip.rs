// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2

//! CA-39, first clause: `read_note` returns the exact bytes of the file, and
//! `write_note` writes exactly the bytes it is given, on the byte traps of CA-34.
//! The expected bytes are literals of `common`, not the output of the code under test.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod common;

use std::fs;

use libre_ai_notebook_vault::{Revision, Vault, VaultError};

use common::{Scratch, byte_traps, one_mebibyte};

fn open(scratch: &Scratch) -> Vault {
    Vault::open(scratch.path()).unwrap()
}

#[test]
fn every_byte_trap_round_trips_exactly() {
    let scratch = Scratch::new();
    let vault = open(&scratch);
    let traps = byte_traps();
    for (name, bytes) in &traps {
        let path = format!("traps/{name}.md");
        let written = vault.write_note(&path, bytes, None).unwrap();
        // The file on disk is what a third party sees: read it without the vault.
        assert_eq!(
            &fs::read(scratch.path().join(&path)).unwrap(),
            bytes,
            "disk: {name}"
        );
        let note = vault.read_note(&path).unwrap();
        assert_eq!(&note.bytes, bytes, "read: {name}");
        assert_eq!(note.revision, written, "revision: {name}");
        assert_eq!(note.revision, Revision::of(bytes), "digest: {name}");
    }
    println!(
        "byte traps round-tripped exactly: {} of {}",
        traps.len(),
        traps.len()
    );
}

#[test]
fn a_file_written_by_another_program_is_read_unchanged() {
    let scratch = Scratch::new();
    let vault = open(&scratch);
    for (name, bytes) in byte_traps() {
        fs::write(scratch.path().join(format!("{name}.md")), &bytes).unwrap();
        let note = vault.read_note(&format!("{name}.md")).unwrap();
        assert_eq!(note.bytes, bytes, "{name}");
    }
}

#[test]
fn one_mebibyte_of_arbitrary_bytes_round_trips() {
    let scratch = Scratch::new();
    let vault = open(&scratch);
    let body = one_mebibyte();
    let revision = vault.write_note("large.md", &body, None).unwrap();
    assert_eq!(vault.read_note("large.md").unwrap().bytes, body);
    // Rewriting the same bytes changes nothing, the revision included.
    let again = vault
        .write_note("large.md", &body, Some(&revision))
        .unwrap();
    assert_eq!(again, revision);
    assert_eq!(fs::read(scratch.path().join("large.md")).unwrap(), body);
}

#[test]
fn a_known_digest_pins_the_revision_format() {
    // SHA-256("abc"), lowercase hexadecimal: an external vector, not recomputed here.
    let revision = Revision::of(b"abc");
    assert_eq!(
        revision.as_str(),
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
    assert_eq!(Revision::parse(revision.as_str()).unwrap(), revision);
    for bad in [
        "",
        "ABC",
        &"a".repeat(63),
        &"a".repeat(65),
        &"G".repeat(64),
        &"A".repeat(64),
    ] {
        assert_eq!(
            Revision::parse(bad),
            Err(VaultError::InvalidRevision),
            "{bad:?}"
        );
    }
}

#[test]
fn the_expected_revision_guards_every_overwrite() {
    let scratch = Scratch::new();
    let vault = open(&scratch);
    let first = vault.write_note("a.md", b"one\n", None).unwrap();

    // Creating over an existing note, and writing over a stale revision, are refused.
    assert_eq!(
        vault.write_note("a.md", b"two\n", None),
        Err(VaultError::RevisionConflict)
    );
    let stale = Revision::of(b"something else");
    assert_eq!(
        vault.write_note("a.md", b"two\n", Some(&stale)),
        Err(VaultError::RevisionConflict)
    );
    assert_eq!(fs::read(scratch.path().join("a.md")).unwrap(), b"one\n");

    // An edit made behind the vault's back moves the revision on.
    fs::write(scratch.path().join("a.md"), b"edited elsewhere\n").unwrap();
    assert_eq!(
        vault.write_note("a.md", b"two\n", Some(&first)),
        Err(VaultError::RevisionConflict)
    );
    assert_eq!(
        fs::read(scratch.path().join("a.md")).unwrap(),
        b"edited elsewhere\n"
    );

    // The current revision goes through, and a missing note has no revision to match.
    let current = vault.read_note("a.md").unwrap().revision;
    vault.write_note("a.md", b"two\n", Some(&current)).unwrap();
    assert_eq!(fs::read(scratch.path().join("a.md")).unwrap(), b"two\n");
    assert_eq!(
        vault.write_note("missing.md", b"x", Some(&current)),
        Err(VaultError::NotFound)
    );
}

#[test]
fn a_missing_note_is_not_found() {
    let scratch = Scratch::new();
    let vault = open(&scratch);
    assert_eq!(
        vault.read_note("nothing.md").map(|n| n.bytes),
        Err(VaultError::NotFound)
    );
    assert_eq!(
        vault.read_note("dir/nothing.md").map(|n| n.bytes),
        Err(VaultError::NotFound)
    );
}

#[test]
fn a_path_outside_the_vault_grammar_is_refused_before_any_io() {
    let scratch = Scratch::new();
    let vault = open(&scratch);
    let refused = [
        "",
        "/etc/passwd.md",
        "../outside.md",
        "a/../../outside.md",
        "a/./b.md",
        "a//b.md",
        ".hidden.md",
        "a/.git/config.md",
        ".obsidian/workspace.md",
        "note.txt",
        "note",
        "note.md/",
        ".md",
        "a\\b.md",
        "nul\0byte.md",
        "line\nbreak.md",
        "tab\there.md",
        "del\x7fchar.md",
        "NOTE.MD",
        &format!("{}.md", "n".repeat(300)),
        &format!("{}/x.md", "d/".repeat(600)),
    ];
    for path in refused {
        assert_eq!(
            vault.read_note(path).map(|n| n.bytes),
            Err(VaultError::InvalidPath),
            "read {path:?}"
        );
        assert_eq!(
            vault.write_note(path, b"x", None),
            Err(VaultError::InvalidPath),
            "write {path:?}"
        );
    }
    assert!(
        common::listing(scratch.path()).is_empty(),
        "a refused write created a file"
    );
    println!("paths refused: {} of {}", refused.len(), refused.len());
}

#[test]
fn accented_and_astral_names_are_valid() {
    let scratch = Scratch::new();
    let vault = open(&scratch);
    for path in [
        "notes/été.md",
        "notes/cafe\u{301}-nfd.md",
        "notes/\u{1F600}.md",
        "a b/c d.md",
    ] {
        vault.write_note(path, b"x\n", None).unwrap();
        assert_eq!(vault.read_note(path).unwrap().bytes, b"x\n", "{path}");
    }
}

#[cfg(unix)]
#[test]
fn a_symbolic_link_is_never_followed() {
    use std::os::unix::fs::symlink;

    let scratch = Scratch::new();
    let outside = Scratch::new();
    fs::write(outside.path().join("secret.md"), b"outside the vault\n").unwrap();
    fs::create_dir(outside.path().join("dir")).unwrap();
    let vault_root = scratch.path().join("vault");
    fs::create_dir(&vault_root).unwrap();
    symlink(outside.path().join("secret.md"), vault_root.join("link.md")).unwrap();
    symlink(outside.path().join("dir"), vault_root.join("linked-dir")).unwrap();
    let vault = Vault::open(&vault_root).unwrap();

    for path in ["link.md", "linked-dir/new.md"] {
        assert_eq!(
            vault.read_note(path).map(|n| n.bytes),
            Err(VaultError::InvalidPath),
            "read {path}"
        );
        assert_eq!(
            vault.write_note(path, b"x", None),
            Err(VaultError::InvalidPath),
            "write {path}"
        );
    }
    assert_eq!(
        fs::read(outside.path().join("secret.md")).unwrap(),
        b"outside the vault\n"
    );
    assert!(common::listing(&outside.path().join("dir")).is_empty());
}

#[test]
fn opening_something_that_is_not_a_directory_is_refused() {
    let scratch = Scratch::new();
    fs::write(scratch.path().join("file.md"), b"x").unwrap();
    assert_eq!(
        Vault::open(&scratch.path().join("file.md")).err(),
        Some(VaultError::InvalidVault)
    );
    assert_eq!(
        Vault::open(&scratch.path().join("absent")).err(),
        Some(VaultError::InvalidVault)
    );
    assert_eq!(
        Vault::open(std::path::Path::new("relative/dir")).err(),
        Some(VaultError::InvalidVault)
    );
}

#[test]
fn a_note_over_the_size_limit_is_refused_on_both_paths() {
    let scratch = Scratch::new();
    let vault = open(&scratch);
    let limit = libre_ai_notebook_vault::MAX_NOTE_BYTES;
    let big = fs::File::create(scratch.path().join("big.md")).unwrap();
    big.set_len(limit as u64 + 1).unwrap();
    assert_eq!(
        vault.read_note("big.md").map(|n| n.bytes.len()),
        Err(VaultError::TooLarge)
    );
    let payload = vec![b'a'; limit + 1];
    assert_eq!(
        vault.write_note("other.md", &payload, None),
        Err(VaultError::TooLarge)
    );
    assert!(!scratch.path().join("other.md").exists());
}

#[test]
fn the_refusal_codes_are_a_closed_list_and_carry_no_free_text() {
    let all = [
        VaultError::InvalidVault,
        VaultError::InvalidPath,
        VaultError::NotFound,
        VaultError::RevisionConflict,
        VaultError::InvalidRevision,
        VaultError::TooLarge,
        VaultError::NotUtf8,
        VaultError::InvalidQuery,
        VaultError::IndexMissing,
        VaultError::Io(std::io::ErrorKind::PermissionDenied),
    ];
    let codes: Vec<&str> = all.iter().map(|e| e.code()).collect();
    assert_eq!(
        codes,
        [
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
        ]
    );
    assert_eq!(VaultError::CODES.as_slice(), codes.as_slice());
    for error in all {
        // Display is the code and nothing else: no path, no OS message.
        assert_eq!(error.to_string(), error.code());
        assert!(!format!("{error:?}").contains('/'));
    }
}

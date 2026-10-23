// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2

//! CA-39, second clause: `write_note` writes through a temporary file, `fsync`
//! and a rename, and an interrupted write leaves the original intact. The
//! interruption is an injected error at each step, plus a partial write.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod common;

use std::fs;
use std::io;
use std::sync::{Mutex, mpsc};
use std::thread;
use std::time::Duration;

use libre_ai_notebook_vault::{Faults, Revision, Vault, VaultError, WriteStep};

use common::{Scratch, listing};

const ORIGINAL: &[u8] = b"# Original\r\n\r\nthe bytes that must survive\r\n";

/// Fails the `occurrence`-th time `step` is reached (1-based), records every step.
struct FailAt {
    step: WriteStep,
    occurrence: usize,
    seen: Mutex<Vec<WriteStep>>,
}

impl FailAt {
    fn new(step: WriteStep, occurrence: usize) -> Self {
        Self {
            step,
            occurrence,
            seen: Mutex::new(Vec::new()),
        }
    }
}

impl Faults for FailAt {
    fn before(&self, step: WriteStep) -> io::Result<()> {
        let mut seen = self.seen.lock().unwrap();
        seen.push(step);
        if step == self.step && seen.iter().filter(|s| **s == step).count() == self.occurrence {
            return Err(io::Error::other("injected"));
        }
        Ok(())
    }
}

/// Records the steps and never fails.
struct Recorder(Mutex<Vec<WriteStep>>);

impl Faults for Recorder {
    fn before(&self, step: WriteStep) -> io::Result<()> {
        self.0.lock().unwrap().push(step);
        Ok(())
    }
}

fn vault_with_original() -> (Scratch, Vault, Revision) {
    let scratch = Scratch::new();
    let vault = Vault::open(scratch.path()).unwrap();
    let revision = vault.write_note("notes/a.md", ORIGINAL, None).unwrap();
    (scratch, vault, revision)
}

fn replacement() -> Vec<u8> {
    // Larger than two write chunks, so a partial write is possible.
    vec![b'N'; 200 * 1024]
}

#[test]
fn an_interrupted_write_leaves_the_original_intact_and_no_temporary_file() {
    let before_rename = [
        (WriteStep::CreateTemp, 1),
        (WriteStep::WriteTemp, 1),
        (WriteStep::WriteTemp, 2), // a partial temporary file exists when this one fails
        (WriteStep::SyncTemp, 1),
        (WriteStep::Rename, 1),
    ];
    let mut interrupted = 0;
    for (step, occurrence) in before_rename {
        let (scratch, vault, revision) = vault_with_original();
        let tree = listing(scratch.path());
        let faults = FailAt::new(step, occurrence);

        let result = vault.write_note_with("notes/a.md", &replacement(), Some(&revision), &faults);

        assert_eq!(
            result,
            Err(VaultError::Io(io::ErrorKind::Other)),
            "{step:?} #{occurrence}"
        );
        assert_eq!(
            fs::read(scratch.path().join("notes/a.md")).unwrap(),
            ORIGINAL,
            "{step:?} #{occurrence}"
        );
        assert_eq!(
            listing(scratch.path()),
            tree,
            "temporary file left after {step:?} #{occurrence}"
        );
        // The note is still readable through the vault, at its old revision.
        assert_eq!(vault.read_note("notes/a.md").unwrap().revision, revision);
        interrupted += 1;
    }
    println!(
        "interrupted writes with the original intact: {interrupted} of {}",
        before_rename.len()
    );
}

#[test]
fn an_interrupted_first_write_creates_nothing() {
    let scratch = Scratch::new();
    let vault = Vault::open(scratch.path()).unwrap();
    let faults = FailAt::new(WriteStep::SyncTemp, 1);
    let result = vault.write_note_with("fresh.md", b"x", None, &faults);
    assert_eq!(result, Err(VaultError::Io(io::ErrorKind::Other)));
    assert!(listing(scratch.path()).is_empty());
}

#[test]
fn a_failure_after_the_rename_reports_an_error_but_never_a_torn_file() {
    let (scratch, vault, revision) = vault_with_original();
    let body = replacement();
    let faults = FailAt::new(WriteStep::SyncDirectory, 1);
    let result = vault.write_note_with("notes/a.md", &body, Some(&revision), &faults);
    assert_eq!(result, Err(VaultError::Io(io::ErrorKind::Other)));
    let on_disk = fs::read(scratch.path().join("notes/a.md")).unwrap();
    assert!(
        on_disk == body || on_disk == ORIGINAL,
        "torn file of {} bytes",
        on_disk.len()
    );
    assert_eq!(listing(scratch.path()).len(), 1, "temporary file left");
}

#[test]
fn a_write_goes_through_a_temporary_file_that_is_synced_before_the_rename() {
    let (_scratch, vault, revision) = vault_with_original();
    let recorder = Recorder(Mutex::new(Vec::new()));
    vault
        .write_note_with("notes/a.md", &replacement(), Some(&revision), &recorder)
        .unwrap();
    let steps = recorder.0.lock().unwrap().clone();
    let first = |wanted: WriteStep| steps.iter().position(|s| *s == wanted).unwrap();
    let last = |wanted: WriteStep| steps.iter().rposition(|s| *s == wanted).unwrap();
    assert_eq!(steps.first(), Some(&WriteStep::CreateTemp));
    assert!(
        last(WriteStep::WriteTemp) < first(WriteStep::SyncTemp),
        "{steps:?}"
    );
    assert!(
        first(WriteStep::SyncTemp) < first(WriteStep::Rename),
        "{steps:?}"
    );
    assert!(
        first(WriteStep::Rename) < first(WriteStep::SyncDirectory),
        "{steps:?}"
    );
    assert_eq!(steps.last(), Some(&WriteStep::SyncDirectory));
    assert_eq!(steps.iter().filter(|s| **s == WriteStep::Rename).count(), 1);
    assert!(
        steps.iter().filter(|s| **s == WriteStep::WriteTemp).count() >= 2,
        "{steps:?}"
    );
    println!("write steps: {steps:?}");
}

#[test]
fn a_stale_revision_found_at_the_last_moment_leaves_the_original_and_no_temporary_file() {
    // The conflict is detected after the temporary file is complete: the cleanup
    // path of a refusal, not only of an I/O error.
    let (scratch, vault, _) = vault_with_original();
    let tree = listing(scratch.path());
    let stale = Revision::of(b"not the original");
    let result = vault.write_note("notes/a.md", &replacement(), Some(&stale));
    assert_eq!(result, Err(VaultError::RevisionConflict));
    assert_eq!(
        fs::read(scratch.path().join("notes/a.md")).unwrap(),
        ORIGINAL
    );
    assert_eq!(listing(scratch.path()), tree);
}

#[test]
fn the_permissions_of_the_original_survive_the_rewrite() {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        let (scratch, vault, revision) = vault_with_original();
        let path = scratch.path().join("notes/a.md");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).unwrap();
        vault
            .write_note("notes/a.md", b"new\n", Some(&revision))
            .unwrap();
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o640
        );
    }
}

/// Parks its writer at the rename, which is after the revision check, until
/// released. Without a bound the test would hang on a writer nobody releases.
struct ParkAtRename {
    arrived: Mutex<mpsc::Sender<()>>,
    release: Mutex<mpsc::Receiver<()>>,
}

impl Faults for ParkAtRename {
    fn before(&self, step: WriteStep) -> io::Result<()> {
        if step == WriteStep::Rename {
            self.arrived.lock().unwrap().send(()).unwrap();
            self.release
                .lock()
                .unwrap()
                .recv_timeout(Duration::from_secs(10))
                .map_err(io::Error::other)?;
        }
        Ok(())
    }
}

/// Tells when its writer reaches the rename, and never fails.
struct NotifyAtRename(Mutex<mpsc::Sender<()>>);

impl Faults for NotifyAtRename {
    fn before(&self, step: WriteStep) -> io::Result<()> {
        if step == WriteStep::Rename {
            self.0.lock().unwrap().send(()).unwrap();
        }
        Ok(())
    }
}

#[test]
fn two_writers_holding_the_same_revision_cannot_both_succeed() {
    let (scratch, vault, revision) = vault_with_original();
    let (arrived_tx, arrived_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let (second_tx, second_rx) = mpsc::channel();
    let first = ParkAtRename {
        arrived: Mutex::new(arrived_tx),
        release: Mutex::new(release_rx),
    };
    let second = NotifyAtRename(Mutex::new(second_tx));

    let (first_result, second_result, overlapped) = thread::scope(|scope| {
        let first_writer = scope.spawn(|| {
            vault.write_note_with("notes/a.md", b"first writer\n", Some(&revision), &first)
        });
        // The first writer has passed its revision check and waits to rename.
        arrived_rx.recv_timeout(Duration::from_secs(10)).unwrap();
        let second_writer = scope.spawn(|| {
            vault.write_note_with("notes/a.md", b"second writer\n", Some(&revision), &second)
        });
        // A second writer that gets as far as its own rename while the first is
        // parked has checked the same revision against the same file: the
        // vault does not serialise them. Waiting is only the cost of the
        // correct case, where it never gets there.
        let overlapped = second_rx.recv_timeout(Duration::from_millis(500)).is_ok();
        release_tx.send(()).unwrap();
        (
            first_writer.join().unwrap(),
            second_writer.join().unwrap(),
            overlapped,
        )
    });

    assert_eq!(first_result, Ok(Revision::of(b"first writer\n")));
    assert_eq!(second_result, Err(VaultError::RevisionConflict));
    assert!(
        !overlapped,
        "the second writer reached its rename while the first was parked"
    );
    assert_eq!(
        fs::read(scratch.path().join("notes/a.md")).unwrap(),
        b"first writer\n"
    );
    assert_eq!(listing(scratch.path()).len(), 1, "temporary file left");
}

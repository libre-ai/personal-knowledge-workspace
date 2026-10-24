// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

use super::Vault;
use crate::error::VaultError;
use crate::root::RootPolicy;

static COUNTER: AtomicU32 = AtomicU32::new(0);

/// A scratch vault in a scratch home folder, removed on drop (the integration
/// tests have their own in `tests/common`, out of reach of unit tests).
struct Scratch(PathBuf);

impl Scratch {
    fn new() -> Self {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let base =
            std::env::temp_dir().join(format!("notebook-vault-unit-{}-{n}", std::process::id()));
        fs::create_dir_all(base.join("home/vault")).unwrap();
        Self(base)
    }

    fn open(&self) -> Vault {
        let policy = RootPolicy::new(&self.0.join("home"), &[]).unwrap();
        Vault::open_with(&self.0.join("home/vault"), &policy).unwrap()
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// The index lock poisoned by a panic is not taken again (README, limits): the
/// vault answers `vault.io` to everything that needs the index, instead of
/// serving an index a panic may have left half updated.
#[test]
fn a_poisoned_index_lock_refuses_every_operation_that_needs_it() {
    let scratch = Scratch::new();
    let vault = scratch.open();
    vault.rebuild_index().unwrap();

    let poisoner = thread::scope(|scope| {
        scope
            .spawn(|| {
                let _index = vault.index.write().unwrap();
                panic!("injected panic while the index is held");
            })
            .join()
    });
    poisoner.unwrap_err();

    let refusal = VaultError::Io(std::io::ErrorKind::Other);
    assert_eq!(vault.search("anything").unwrap_err(), refusal);
    assert_eq!(vault.rebuild_index().unwrap_err(), refusal);
    assert_eq!(vault.write_note("a.md", b"x\n", None).unwrap_err(), refusal);
}

/// A write that ends while a rebuild has scanned but not yet replaced the
/// index must not vanish from the index: the scan did not see the note, the
/// write updated the index the rebuild is about to throw away. Excluding the
/// two is what keeps the note searchable (the writer queues behind the rebuild,
/// whose hook therefore waits in vain for it, and gives up after a bound that
/// only the correct case pays).
#[test]
fn a_write_ending_during_a_rebuild_stays_searchable() {
    let scratch = Scratch::new();
    let vault = scratch.open();
    vault.rebuild_index().unwrap();

    let overlapped = AtomicBool::new(false);
    thread::scope(|scope| {
        let vault = &vault;
        let overlapped = &overlapped;
        let rebuild = scope.spawn(move || {
            vault.rebuild_index_after_scan(|| {
                let (done_tx, done_rx) = mpsc::channel();
                // A writer starting now cannot be in the scan, which is over.
                scope.spawn(move || {
                    vault
                        .write_note("late.md", b"zebrawordunique\n", None)
                        .unwrap();
                    // Queued behind the rebuild, the writer ends after the hook,
                    // which no longer listens.
                    let _ = done_tx.send(());
                });
                let done = done_rx.recv_timeout(Duration::from_millis(500)).is_ok();
                overlapped.store(done, Ordering::SeqCst);
            })
        });
        rebuild.join().unwrap().unwrap();
    });

    assert_eq!(
        fs::read(scratch.0.join("home/vault/late.md")).unwrap(),
        b"zebrawordunique\n"
    );
    assert_eq!(
        vault.search("zebrawordunique").unwrap().len(),
        1,
        "the note is on disk and absent from the index"
    );
    assert!(
        !overlapped.load(Ordering::SeqCst),
        "a write completed between the scan and the replacement of the index"
    );
}

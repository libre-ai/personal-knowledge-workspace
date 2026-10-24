// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2

//! The guard on the root `open_vault` accepts (review of WP-3, owner decision
//! of 2026-10-23): a guard rail, not a boundary. The boundary is CA-47 (WP-4).
//! Every refusal is the single code `vault.invalid_vault`; each case below is
//! a root a compromised front could name, or one that must stay open.
//!
//! The home folder is a stand-in created for the test; no case reads the
//! `$HOME` of whoever runs them.

#![cfg(unix)]
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use std::fs;
use std::os::unix::fs::symlink;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

use libre_ai_notebook_vault::{HOME_FORBIDDEN_DIRS, RootPolicy, SYSTEM_DIRS, Vault, VaultError};

static COUNTER: AtomicU32 = AtomicU32::new(0);

/// A stand-in home folder with the folders a user has, and the links a
/// compromised front might have planted, removed on drop.
struct Fixture {
    base: PathBuf,
    home: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let base = std::env::temp_dir().join(format!("vault-guard-{}-{n}", std::process::id()));
        let home = base.join("home");
        for directory in [
            "docs/sub",
            "docs/.git",
            "docs/Library",
            ".ssh/keys",
            "Library/Application Support",
            "My Library",
            "a",
            "b",
        ] {
            fs::create_dir_all(home.join(directory)).unwrap();
        }
        // Beside the home folder, to name it through a `..` that starts outside.
        fs::create_dir_all(base.join("elsewhere")).unwrap();
        symlink("/", home.join("link-to-root")).unwrap();
        symlink("/etc", home.join("link-to-etc")).unwrap();
        symlink(home.join("docs"), home.join(".hidden-link")).unwrap();
        symlink(home.join("docs"), home.join("docs-link")).unwrap();
        Self { base, home }
    }

    /// The policy of this home folder without system directories: the stand-in
    /// lives in the temporary directory, itself a system directory by the list
    /// under test, and the rules on the home folder are judged apart from it.
    fn policy(&self) -> RootPolicy {
        RootPolicy::new(&self.home, &[]).unwrap()
    }

    fn at(&self, relative: &str) -> PathBuf {
        self.home.join(relative)
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.base);
    }
}

fn refusal(directory: &Path, policy: &RootPolicy) -> Option<VaultError> {
    Vault::open_with(directory, policy).err()
}

#[test]
fn hostile_roots_are_refused_with_the_closed_vault_code() {
    let fixture = Fixture::new();
    let policy = fixture.policy();
    let hostile: Vec<(&str, PathBuf)> = vec![
        ("the disk root", PathBuf::from("/")),
        ("/private/etc", PathBuf::from("/private/etc")),
        ("/etc", PathBuf::from("/etc")),
        ("a link to the disk root", fixture.at("link-to-root")),
        ("a link to /etc", fixture.at("link-to-etc")),
        ("the home folder itself", fixture.home.clone()),
        ("~/.ssh", fixture.at(".ssh")),
        ("below ~/.ssh", fixture.at(".ssh/keys")),
        ("a hidden folder deeper down", fixture.at("docs/.git")),
        (
            "a hidden link to an ordinary folder",
            fixture.at(".hidden-link"),
        ),
        ("~/Library", fixture.at("Library")),
        (
            "~/Library/Application Support",
            fixture.at("Library/Application Support"),
        ),
        ("a path with .. into ~/.ssh", fixture.at("docs/../.ssh")),
        ("a path with .. to an ordinary folder", fixture.at("a/../b")),
        (
            "a path with .. entered outside the home folder, resolving to an ordinary folder of it",
            fixture.base.join("elsewhere/../home/docs"),
        ),
        ("a relative path", PathBuf::from("docs/sub")),
        ("a folder that does not exist", fixture.at("absent")),
    ];
    for (label, directory) in &hostile {
        assert_eq!(
            refusal(directory, &policy),
            Some(VaultError::InvalidVault),
            "{label}: {}",
            directory.display()
        );
    }
    println!("root guard: {} hostile roots refused", hostile.len());
}

#[test]
fn a_folder_below_the_home_folder_stays_open() {
    let fixture = Fixture::new();
    let policy = fixture.policy();
    let legitimate: Vec<(&str, PathBuf)> = vec![
        ("a folder of the home folder", fixture.at("docs")),
        ("a folder two levels down", fixture.at("docs/sub")),
        (
            "a link to an ordinary folder of the home folder",
            fixture.at("docs-link"),
        ),
        (
            "a folder whose name only contains Library",
            fixture.at("My Library"),
        ),
        (
            "a folder named Library below the first level",
            fixture.at("docs/Library"),
        ),
    ];
    for (position, (label, directory)) in legitimate.iter().enumerate() {
        let vault = Vault::open_with(directory, &policy)
            .unwrap_or_else(|error| panic!("{label}: refused with {error}"));
        // One name per case: two of them are one folder.
        let note = format!("note-{position}.md");
        let revision = vault.write_note(&note, b"kept\n", None).unwrap();
        assert_eq!(vault.read_note(&note).unwrap().revision, revision);
    }
    println!(
        "root guard: {} legitimate roots opened, written and read",
        legitimate.len()
    );
}

#[test]
fn every_system_directory_is_refused_even_when_the_home_folder_contains_it() {
    // A home folder that is the disk root contains every system directory, so
    // only the system-directory rule can refuse them: the other rules admit
    // anything below such a home folder.
    let policy = RootPolicy::new(Path::new("/"), &SYSTEM_DIRS).unwrap();
    let mut refused = 0;
    for directory in SYSTEM_DIRS {
        let path = Path::new(directory);
        if !path.is_dir() {
            continue;
        }
        assert_eq!(
            refusal(path, &policy),
            Some(VaultError::InvalidVault),
            "{directory}"
        );
        refused += 1;
    }
    // A folder below a system directory is refused too, and a folder the list
    // does not name is not.
    assert_eq!(
        refusal(Path::new("/usr/bin"), &policy),
        Some(VaultError::InvalidVault)
    );
    #[cfg(target_os = "macos")]
    {
        // All 17 exist on macOS 15; `/opt` and `/cores` are not promised by
        // every release, hence the floor.
        assert!(refused >= 15, "{refused} SYSTEM_DIRS entries on this macOS");
        assert_eq!(
            refusal(Path::new("/System/Library"), &policy),
            Some(VaultError::InvalidVault)
        );
    }
    assert!(refused >= 6, "only {refused} system directories exist here");
    println!("root guard: {refused} system directories refused");
}

#[test]
fn the_lists_are_data_and_name_what_the_review_asked_for() {
    for required in [
        "/System",
        "/Library",
        "/usr",
        "/bin",
        "/sbin",
        "/etc",
        "/var",
        "/private",
        "/dev",
        "/Applications",
        "/Volumes",
        // The canonical forms of /etc and /var on macOS.
        "/private/etc",
        "/private/var",
    ] {
        assert!(SYSTEM_DIRS.contains(&required), "{required} is not listed");
    }
    for entry in SYSTEM_DIRS {
        assert!(
            entry.starts_with('/') && entry.len() > 1 && !entry.ends_with('/'),
            "{entry} is not an absolute path without a trailing slash"
        );
    }
    assert_eq!(HOME_FORBIDDEN_DIRS, ["Library"]);
}

#[test]
fn the_entry_point_of_the_application_refuses_the_disk_root_and_the_home_folder() {
    // `Vault::open` judges against the home folder of the process; whatever it
    // is, the disk root is outside it and the home folder itself is refused.
    assert_eq!(
        Vault::open(Path::new("/")).err(),
        Some(VaultError::InvalidVault)
    );
    if let Some(home) = std::env::home_dir() {
        assert_eq!(Vault::open(&home).err(), Some(VaultError::InvalidVault));
    }
}

#[test]
fn a_home_folder_that_is_not_a_directory_builds_no_policy() {
    let fixture = Fixture::new();
    assert_eq!(
        RootPolicy::new(Path::new("relative"), &[]).err(),
        Some(VaultError::InvalidVault)
    );
    assert_eq!(
        RootPolicy::new(&fixture.at("absent"), &[]).err(),
        Some(VaultError::InvalidVault)
    );
    fs::write(fixture.at("file"), b"x").unwrap();
    assert_eq!(
        RootPolicy::new(&fixture.at("file"), &[]).err(),
        Some(VaultError::InvalidVault)
    );
}

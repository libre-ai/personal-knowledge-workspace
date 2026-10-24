// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2

//! The guard on the folder `Vault::open` accepts as a root.
//!
//! This is a guard rail, not a boundary. It keeps a front that asks for `/`, a
//! system directory, the home folder itself, a hidden folder such as `~/.ssh`
//! or `~/Library` from turning every `*.md` of the user into a note it can read
//! and write. It leaves open every other folder below the home folder: a
//! compromised front can still name `~/Documents` and reach what is there. The
//! boundary is CA-47 of `docs/cahier-des-charges.md` (WP-4): the front stops
//! naming the root at all, and a native folder picker, on the Rust side, does.
//!
//! Nor is the root pinned: it is a canonical path resolved once at `open`, not a
//! directory descriptor. If the root is removed and replaced by a symbolic link
//! after the open, later operations resolve below that link and leave the
//! folder (measured: open `home/vault`, remove it, link `home/vault` to a
//! folder outside, `read_note` reads a file there). The threat model excludes
//! it, since a front that can rearrange the disk has no need of the bridge, and
//! CA-47 (WP-4) is where the root stops being the front's to name.
//!
//! The rules apply to two spellings of the root, the one that was entered and
//! the one `canonicalize` returns (symbolic links resolved), so that a link in
//! the home folder to `/etc` is refused by the second and a link named `.x`
//! to an ordinary folder by the first. Every refusal is the same code,
//! `vault.invalid_vault`, as a folder that does not exist: the front learns
//! nothing about which folders exist outside its reach.

use std::fs;
use std::path::{Component, Path, PathBuf};

use crate::error::VaultError;

/// Directories no root may be, or be below, whatever the home folder is. The
/// first eleven are the ones the review of WP-3 named; the following are their
/// canonical forms (`/etc` is `/private/etc` on macOS) and the other system
/// directories of the platform. Compared component by component, ASCII case
/// ignored: macOS volumes are case-insensitive by default.
///
/// shortcut: the directories of macOS; upgrade trigger: a second target
/// platform (the shell is macOS only, ADR-0057), which adds its own.
pub const SYSTEM_DIRS: [&str; 17] = [
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
    "/private/etc",
    "/private/var",
    "/private/tmp",
    "/tmp",
    "/opt",
    "/cores",
];

/// Folders of the home folder no root may be, or be below, in addition to the
/// hidden ones (`.ssh`, `.config`, `.Trash`): the application data of the
/// user, which holds the keychains, the mail and every application's store.
pub const HOME_FORBIDDEN_DIRS: [&str; 1] = ["Library"];

/// Why a root was refused. It stays in Rust: the bridge answers
/// `vault.invalid_vault` whatever the reason (see the module documentation).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RootRefusal {
    SystemDirectory,
    ParentSegment,
    /// Not strictly below the home folder. The root of the disk is this case:
    /// it is below no home folder, and `current_user` refuses a home folder
    /// that is the root of the disk.
    OutsideHome,
    TheHomeItself,
    HiddenComponent,
    ForbiddenHomeDirectory,
}

/// The home folder and the system directories a root is judged against.
///
/// It is built on the Rust side: [`RootPolicy::current_user`] reads the home
/// folder of the process, and [`RootPolicy::new`] takes one for the tests. No
/// command of the bridge receives a home folder, a policy or a list from the
/// front.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RootPolicy {
    /// The home folder, resolved (symbolic links included).
    home: PathBuf,
    /// The home folder as it was given, for judging the entered spelling of a root.
    entered_home: PathBuf,
    system_dirs: Vec<PathBuf>,
}

impl RootPolicy {
    /// The policy of the user running the process: their home folder, read
    /// from the standard library, and [`SYSTEM_DIRS`]. A home folder that
    /// cannot be determined, or is the root of the disk, is refused: the
    /// guard fails closed rather than judging against nothing.
    pub fn current_user() -> Result<Self, VaultError> {
        Self::for_user_home(std::env::home_dir())
    }

    fn for_user_home(home: Option<PathBuf>) -> Result<Self, VaultError> {
        let policy = Self::new(&home.ok_or(VaultError::InvalidVault)?, &SYSTEM_DIRS)?;
        if policy.home.parent().is_none() {
            return Err(VaultError::InvalidVault);
        }
        Ok(policy)
    }

    /// A policy for the given home folder and system directories. The home
    /// folder must be an absolute path to a directory. This exists for the
    /// tests, which must not depend on the home folder of whoever runs them;
    /// the bridge builds its policy with [`RootPolicy::current_user`].
    pub fn new(home: &Path, system_dirs: &[&str]) -> Result<Self, VaultError> {
        if !home.is_absolute() {
            return Err(VaultError::InvalidVault);
        }
        let resolved = fs::canonicalize(home).map_err(|_| VaultError::InvalidVault)?;
        if !resolved.is_dir() {
            return Err(VaultError::InvalidVault);
        }
        Ok(Self {
            home: resolved,
            entered_home: home.components().collect(),
            system_dirs: system_dirs.iter().map(PathBuf::from).collect(),
        })
    }

    /// The rules on the root as it was entered, before any link is resolved: no
    /// `..` (a picker never produces one, and what it would reach is the
    /// canonical form's business), no system directory, and, when it is entered
    /// below the home folder, the rules of [`below_home`].
    pub(crate) fn check_entered(&self, entered: &Path) -> Result<(), RootRefusal> {
        if entered
            .components()
            .any(|component| component == Component::ParentDir)
        {
            return Err(RootRefusal::ParentSegment);
        }
        self.check_system(entered)?;
        for home in [&self.entered_home, &self.home] {
            if let Ok(rest) = entered.strip_prefix(home) {
                below_home(rest)?;
            }
        }
        Ok(())
    }

    /// The rules on the root once its links are resolved: no system directory,
    /// strictly below the home folder, and the rules of [`below_home`].
    pub(crate) fn check_canonical(&self, canonical: &Path) -> Result<(), RootRefusal> {
        self.check_system(canonical)?;
        let rest = canonical
            .strip_prefix(&self.home)
            .map_err(|_| RootRefusal::OutsideHome)?;
        if rest.as_os_str().is_empty() {
            return Err(RootRefusal::TheHomeItself);
        }
        below_home(rest)
    }

    fn check_system(&self, path: &Path) -> Result<(), RootRefusal> {
        if self
            .system_dirs
            .iter()
            .any(|directory| under(path, directory))
        {
            return Err(RootRefusal::SystemDirectory);
        }
        Ok(())
    }
}

/// The rules on the part of a root that is below the home folder: no component
/// that starts with a dot, and not `Library` (see [`HOME_FORBIDDEN_DIRS`]) as
/// the first one. A folder named `Library` deeper down is an ordinary folder.
fn below_home(rest: &Path) -> Result<(), RootRefusal> {
    for (position, component) in rest.components().enumerate() {
        let Component::Normal(name) = component else {
            return Err(RootRefusal::ParentSegment);
        };
        if name.as_encoded_bytes().starts_with(b".") {
            return Err(RootRefusal::HiddenComponent);
        }
        if position == 0
            && HOME_FORBIDDEN_DIRS
                .iter()
                .any(|forbidden| name.eq_ignore_ascii_case(forbidden))
        {
            return Err(RootRefusal::ForbiddenHomeDirectory);
        }
    }
    Ok(())
}

/// Whether `path` is `directory` or below it, by whole components and ignoring
/// ASCII case: `/privateer` is not below `/private`, `/PRIVATE/ETC` is below
/// `/private/etc`.
fn under(path: &Path, directory: &Path) -> bool {
    let mut path = path.components();
    directory.components().all(|expected| {
        path.next().is_some_and(|actual| match (actual, expected) {
            (Component::Normal(a), Component::Normal(e)) => a.eq_ignore_ascii_case(e),
            (a, e) => a == e,
        })
    })
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    /// A home folder that exists, removed on drop.
    struct Home(PathBuf);

    impl Home {
        fn new(tag: &str) -> Self {
            let path = std::env::temp_dir().join(format!("root-unit-{}-{tag}", std::process::id()));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for Home {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn a_directory_is_below_another_by_whole_components_and_ignoring_ascii_case() {
        assert!(under(Path::new("/etc"), Path::new("/etc")));
        assert!(under(
            Path::new("/private/etc/hosts"),
            Path::new("/private/etc")
        ));
        assert!(under(Path::new("/PRIVATE/Etc"), Path::new("/private/etc")));
        assert!(!under(Path::new("/privateer"), Path::new("/private")));
        assert!(!under(Path::new("/home/me/etc"), Path::new("/etc")));
        assert!(!under(Path::new("/"), Path::new("/etc")));
    }

    #[test]
    fn each_rule_names_its_own_refusal() {
        let home = Home::new("rules");
        let policy = RootPolicy::new(&home.0, &["/usr"]).unwrap();
        let resolved = fs::canonicalize(&home.0).unwrap();
        let below = |relative: &str| resolved.join(relative);

        assert_eq!(policy.check_canonical(&below("docs/sub")), Ok(()));
        assert_eq!(policy.check_canonical(&below("My Library")), Ok(()));
        assert_eq!(policy.check_canonical(&below("docs/Library")), Ok(()));
        assert_eq!(
            policy.check_canonical(&resolved),
            Err(RootRefusal::TheHomeItself)
        );
        assert_eq!(
            policy.check_canonical(Path::new("/")),
            Err(RootRefusal::OutsideHome)
        );
        assert_eq!(
            policy.check_canonical(Path::new("/home/someone-else")),
            Err(RootRefusal::OutsideHome)
        );
        assert_eq!(
            policy.check_canonical(Path::new("/usr/local")),
            Err(RootRefusal::SystemDirectory)
        );
        assert_eq!(
            policy.check_canonical(&below(".ssh")),
            Err(RootRefusal::HiddenComponent)
        );
        assert_eq!(
            policy.check_canonical(&below("docs/.git/hooks")),
            Err(RootRefusal::HiddenComponent)
        );
        assert_eq!(
            policy.check_canonical(&below("Library/Mail")),
            Err(RootRefusal::ForbiddenHomeDirectory)
        );
        assert_eq!(
            policy.check_canonical(&below("library")),
            Err(RootRefusal::ForbiddenHomeDirectory)
        );

        assert_eq!(policy.check_entered(&below("docs/sub")), Ok(()));
        assert_eq!(
            policy.check_entered(&below("a/../b")),
            Err(RootRefusal::ParentSegment)
        );
        // Entered outside the home folder, `..` is the first rule's alone.
        assert_eq!(
            policy.check_entered(Path::new("/nowhere/../somewhere")),
            Err(RootRefusal::ParentSegment)
        );
        assert_eq!(
            policy.check_entered(&below(".hidden-link")),
            Err(RootRefusal::HiddenComponent)
        );
        assert_eq!(
            policy.check_entered(&below("Library")),
            Err(RootRefusal::ForbiddenHomeDirectory)
        );
        assert_eq!(
            policy.check_entered(Path::new("/usr/bin")),
            Err(RootRefusal::SystemDirectory)
        );
        // The entered spelling is judged against the home folder as it was
        // given too, not only as it resolves.
        assert_eq!(
            policy.check_entered(&home.0.join(".ssh")),
            Err(RootRefusal::HiddenComponent)
        );
    }

    #[test]
    fn the_policy_of_the_user_fails_closed() {
        let home = Home::new("user");
        assert!(RootPolicy::for_user_home(Some(home.0.clone())).is_ok());
        for (label, unusable) in [
            ("no home folder", None),
            ("the disk root as home folder", Some(PathBuf::from("/"))),
            ("a relative home folder", Some(PathBuf::from("home/me"))),
            ("an absent home folder", Some(home.0.join("absent"))),
        ] {
            assert_eq!(
                RootPolicy::for_user_home(unusable).err(),
                Some(VaultError::InvalidVault),
                "{label}"
            );
        }
    }
}

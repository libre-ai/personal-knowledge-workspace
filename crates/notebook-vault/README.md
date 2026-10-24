# notebook-vault

The Rust core of the P04 vault (EF-P04-9 of `docs/cahier-des-charges.md`): what
the desktop shell's front calls through the Tauri bridge instead of
reimplementing (CA-40). It is distinct from `notebook-core`, the WASM component
without host imports (EF-P04-2), and does the filesystem work that component
may not.

| Function | What it guarantees |
| --- | --- |
| `Vault::read_note` | the exact bytes of the file, with their revision (SHA-256, 64 lowercase hex digits); no decoding, no newline or Unicode normalisation |
| `Vault::write_note` | writes exactly the given bytes through a temporary file, `fsync` and a rename; an expected revision guards the overwrite; a failure before the rename leaves the original intact and no temporary file |
| `render_preview` | an attribute tree: ranges (UTF-16 units) and attributes, no document text and no markup; raw HTML is a range, link destinations pass a whitelist, depth ≤ 64, nodes ≤ 250 000 |
| `Vault::rebuild_index`, `Vault::search` | an in-memory inverted index derived from the folder alone (EF-P04-4), whole words, case, accents and NFC/NFD folded, every word required |

Every refusal is one of the closed `vault.*` codes of `VaultError::CODES`; no
path and no operating-system message is part of a refusal.

## The guard on the root: a guard rail, not a boundary

`Vault::open` (and `open_vault`, which calls it) refuses a root that is the
root of the disk, a system directory (`SYSTEM_DIRS`: `/System`, `/Library`,
`/usr`, `/bin`, `/sbin`, `/etc`, `/var`, `/private`, `/dev`, `/Applications`,
`/Volumes`, their canonical forms and a few more), the home folder itself, not
strictly below the home folder, with a component that starts with a dot
(`~/.ssh`), or `~/Library` and below (`HOME_FORBIDDEN_DIRS`). The rules apply
to the root as entered and as resolved, so a link of the home folder to `/etc`
is refused; a `..` in the entered root is refused outright. The home folder is
read on the Rust side by the standard library, never taken from the front, and
a refusal is `vault.invalid_vault`, the code of a folder that does not exist,
so that the front learns nothing about folders outside its reach.

**What it does not do.** Every folder below the home folder is still open to a
front that names it, `~/Documents` included: a compromised front can read and
write every `*.md` there. The guard removes the cheapest abuse (`/`, `$HOME`,
`~/.ssh`), it does not confine the front. The boundary is CA-47 of
`docs/cahier-des-charges.md` (WP-4): no command of the bridge receives a root
from the front any more, a native folder picker on the Rust side chooses it.
The system-directory list is that of macOS (the shell is macOS only, ADR-0057);
a second platform adds its own.

The tests build their own home folder (`RootPolicy::new`) and never read the
`$HOME` of whoever runs them. `RootPolicy::new` and `Vault::open_with` are for
Rust callers: the bridge builds its policy from the process and no command
carries one.

## Limits stated, not hidden

- Note paths are `/`-separated, relative, `.md` (lowercase), without a
  `.`-prefixed component; a symbolic link is never followed. The check is
  made before the open, not at the open: someone able to swap a path for a
  link between the two already writes in the vault.
- The revision check runs once the temporary file is complete, right before the
  rename, and a lock held by the `Vault` from the check to the index update
  makes the two one step for every writer of that `Vault`: of two writes holding
  the same revision, the second gets `vault.revision_conflict`. The lock is
  one for the whole vault, so writes to different notes queue. A writer other
  than that `Vault` (another process, another `Vault` on the same folder, an
  editor) can still slip in between the check and the rename; merging
  concurrent edits is EF-P04-6.
- A path inside the grammar can still exceed the operating system's limit once
  the vault root is put in front of it (1 024 bytes in all on macOS). The
  system refuses the name and the answer is `vault.invalid_path`, as for a path
  outside the grammar.
- The index is keyed by the lowercase NFC form of a path, so that the spellings
  of a name that APFS as shipped on a Mac treats as one file (`café.md` written
  with the precomposed é, or with `e` and U+0301; `Case.md` and `case.md`) are
  one entry. The target of the product is that case-insensitive volume.
  **The converse limit:** on a file system that keeps those spellings apart
  (Linux, NTFS, APFS formatted case-sensitive), two distinct notes whose names
  differ only by Unicode spelling or by case (`A.md` and `a.md`) share one
  entry, the one indexed last: the other is absent from `search`, and a
  `rebuild_index` does not bring it back (it indexes in sorted path order, so
  the later spelling wins, while `IndexStats::notes` still counts both files).
  The case is lowercased per character, not folded as the file system does
  (`ς`/`σ`, `ß`/`ss` stay distinct keys).
- The root is pinned by a canonical path resolved once at `open`, not by a
  directory descriptor. If the root is removed and replaced by a symbolic link
  after the open, later operations resolve below that link and leave the
  folder: measured, `open` of `home/vault`, `remove_dir`, `symlink(outside,
  home/vault)`, then `read_note` reads a file outside. A front able to
  rearrange the disk is outside the threat model (it has no need of the
  bridge); the boundary is CA-47 (WP-4), not this guard.
- A panic inside `Index::update` poisons the lock of the index, and every
  operation that needs it (`search`, `rebuild_index`, a write once the rename is
  done) then answers `vault.io` for the rest of the session. This is a
  deliberate fail-closed choice: an index half-updated by a panic is not served.
  Restarting the application restores it (the index is derived data, EF-P04-4).
  The write lock is the opposite case: it guards an interval, not data, and a
  poisoned one is taken again.
- Writes queue behind a `rebuild_index`, which holds the write lock for the
  whole scan: a note written while the scan runs would otherwise be absent from
  the index that replaces the old one.
- `fsync` is requested (`File::sync_all`, `F_FULLFSYNC` on macOS) and its
  position in the sequence is tested through the failure hook; that the disk
  really holds the bytes after a power loss is not something these tests measure.
- The index is not persisted. Search is by whole word: no prefix, no stemming.

## Tests

`cargo test --locked -p libre-ai-notebook-vault` (CA-39). The byte traps are the
ones of the corpus generator (`tools/qualification/p04-tauri/cr10k.ts`), written
as literals so the expected bytes do not come from the code under test.

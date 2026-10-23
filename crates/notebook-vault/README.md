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

## Limits stated, not hidden

- Note paths are `/`-separated, relative, `.md` (lowercase), without a
  `.`-prefixed component; a symbolic link is never followed. The check is
  made before the open, not at the open: someone able to swap a path for a
  link between the two already writes in the vault.
- The revision check runs once the temporary file is complete, right before the
  rename. A writer other than this process can still slip in between the two;
  merging concurrent edits is EF-P04-6.
- `fsync` is requested (`File::sync_all`, `F_FULLFSYNC` on macOS) and its
  position in the sequence is tested through the failure hook; that the disk
  really holds the bytes after a power loss is not something these tests measure.
- The index is not persisted. Search is by whole word: no prefix, no stemming.

## Tests

`cargo test --locked -p libre-ai-notebook-vault` (CA-39). The byte traps are the
ones of the corpus generator (`tools/qualification/p04-tauri/cr10k.ts`), written
as literals so the expected bytes do not come from the code under test.

# Dependency qualification — notebook-vault

All versions are exact workspace pins (`Cargo.toml`), each published at least three days before
adoption (ENF-4). Dates are read from the crates.io API (`https://crates.io/api/v1/crates/<name>/versions`)
on 2026-10-24; replay them before relying on them. `cargo deny check bans licenses sources` is the
verdict of `bun run check:dependency-policy`.

| Crate | Scope | Features | Licence | Published | Rationale |
| --- | --- | --- | --- | --- | --- |
| `pulldown-cmark 0.13.4` | runtime | no defaults (drops `html` and `getopts`) | MIT | 2026-05-20 | CommonMark parser with offsets; no HTML renderer is compiled, so no path turns Markdown into HTML. `0.13.5` (2026-10-21) was newer than three days and is not adopted |
| `unicase 2.10.0` | runtime, via `pulldown-cmark` | defaults | MIT OR Apache-2.0 | 2026-10-05 | transitive |
| `unicode-normalization 0.1.25` | runtime | defaults | MIT OR Apache-2.0 | 2025-10-30 | NFD and combining marks for the index (NFC and NFD spellings are one term); already in the lock through the P02 graph |
| `sha2 0.11.0` | runtime | no defaults | MIT OR Apache-2.0 | workspace pin of `notebook-core` | the revision of a note |
| `serde 1.0.229` | runtime | derive | MIT OR Apache-2.0 | workspace pin | serialisation of the preview tree and of search results |
| `serde_json 1.0.151` | development only | workspace | MIT OR Apache-2.0 | workspace pin | tests read the serialised tree |

`bitflags 2.13.1` and `memchr 2.8.3` (transitive of `pulldown-cmark`) were already in the lock.

No runtime dependency supplies a network, a clock or a random source. The crate opens files only below the
folder it was given.

# Advisory waivers

Record cited by the `ref=` of every `[advisories] ignore` entry of `deny.toml`
(`docs/security/ADVISORY-WAIVER-POLICY.md` of `libre-ai/project-governance`: dated,
referenced, bounded). One entry per advisory. Review anchor of the list: 2026-11-24.

## RUSTSEC-2024-0370, `proc-macro-error` 1.0.4 (unmaintained)

- **What it is.** The RustSec entry (dated 2024-09-01) states that the maintainer
  is unreachable and that no release was pushed for four years.
  `[versions] patched = []`: there is no fixed release to move to.
- **Where it enters the graph.** Only on Linux targets, through the GTK stack of
  `tauri`: `tauri` 2.12.4 → `muda` 0.20.0 / `tao` 0.37.1 → `gtk` 0.18.2 → `glib`
  0.18.5 → `glib-macros` 0.18.5 → `proc-macro-error` 1.0.4. It is a build-time
  procedural-macro dependency, not code that handles notes or network data.
  - `cargo tree --locked --offline --workspace --all-features --target x86_64-unknown-linux-gnu -i proc-macro-error` lists the chain above.
  - The same command with `--target aarch64-apple-darwin` prints `nothing to print`:
    the macOS shell (ADR-0057 section 4) does not build it.
- **Why it is not removed here.** The newest stable `tauri` (2.12.7 on crates.io,
  read on 2026-11-24) still requires `gtk ^0.18` and `muda ^0.20`, and `tao` 0.37.3
  still requires `gtk ^0.18`. `gtk` 0.19.0 exists, and nothing in the `tauri` 2
  line depends on it. The dependency is not declared by this repository, so no
  version pin here removes it.
- **Expiry.** 2027-02-24. At that date the entry is removed if a `tauri` release
  no longer reaches `proc-macro-error`, and re-read against the graph otherwise.

## Advisories listed by `cargo audit` and not waived here

`cargo deny check advisories` does not report them on this graph, so an `ignore`
entry would match nothing:

- RUSTSEC-2026-0543, `chrono` 0.4.45 (unmaintained): present in `Cargo.lock` through
  `serde_with`, absent from the resolved graph
  (`cargo tree --workspace --all-features --target all -i chrono` prints `nothing to print`).
- RUSTSEC-2024-0429, `glib` 0.18.5 (unsound): the `unsound` scope of `cargo-deny`
  is `workspace` by default (direct dependencies of workspace crates), and `glib`
  is transitive.

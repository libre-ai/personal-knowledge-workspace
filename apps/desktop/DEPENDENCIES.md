<!--
SPDX-FileCopyrightText: 2026 Libre AI contributors
SPDX-License-Identifier: EUPL-1.2
-->

# Front dependencies of `apps/desktop` (CA-42, EF-P04-10)

Every package of the front is pinned to an exact version, was published at
least three days before it was pinned, and carries a licence admitted by I-11
and ADR-0042 sections 4 and 11 (MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause,
ISC, Zlib, Unicode-3.0, MPL-2.0). The list of packages the front may use at
all is closed in `tests/bridge/front-rules.ts` (CA-40).

How a row is made, so that it can be replayed:

- **Version**: the exact version of `apps/desktop/package.json` and of `bun.lock`.
- **Licence**: the `license` field of the installed `package.json` of that
  version (`apps/desktop/node_modules/<name>/package.json`, or the store of the
  root for a transitive package). It is never copied from the registry page.
- **Published**: `jq -r '.time["<version>"]' <(curl -s https://registry.npmjs.org/<name>)`,
  read on the registry the day the package was pinned.
- **Pinned on**: the day the version entered `package.json`.

`bun test apps/desktop/tests/editor/dependencies.test.ts` replays the rules on
these tables (every `package.json` entry has a row, the version has no range,
the licence is in the list and equals the installed one, the publication is at
least three days before the pinning, the closure of `bun.lock` is exactly the
second table), and `bun install --frozen-lockfile` under `bunfig.toml`
(`minimumReleaseAge = 259200`, no exclusion) refuses a package younger than
three days at install time, transitive ones included.

## Direct dependencies

| Package | Version | Licence | Published (registry) | Pinned on |
| --- | --- | --- | --- | --- |
| `@codemirror/commands` | 6.11.1 | MIT | 2026-09-15T16:54:36.967Z | 2026-10-24 |
| `@codemirror/state` | 6.7.6 | MIT | 2026-09-22T07:21:29.712Z | 2026-10-24 |
| `@codemirror/view` | 6.43.15 | MIT | 2026-10-19T17:37:46.811Z | 2026-10-24 |
| `@tauri-apps/api` | 2.12.4 | Apache-2.0 OR MIT | 2026-10-14T18:47:44.921Z | 2026-10-24 |

`@tauri-apps/api` 2.12.4 is the version of the Rust crate `tauri` 2.12.4 that
the shell links. It is imported from `src/bridge/` only (CA-40).

## Resolved closure

What `bun.lock` resolves from the four packages above. The editor takes no
Markdown parser and no language support: `@codemirror/language` and the `@lezer/*`
packages come with `@codemirror/commands`, and nothing in `src/` imports them.

| Package | Version | Licence | Published (registry) | Pinned on |
| --- | --- | --- | --- | --- |
| `@codemirror/commands` | 6.11.1 | MIT | 2026-09-15T16:54:36.967Z | 2026-10-24 |
| `@codemirror/language` | 6.13.1 | MIT | 2026-10-07T13:20:36.281Z | 2026-10-24 |
| `@codemirror/state` | 6.7.6 | MIT | 2026-09-22T07:21:29.712Z | 2026-10-24 |
| `@codemirror/streamparser` | 6.0.0 | MIT | 2026-10-07T11:22:03.574Z | 2026-10-24 |
| `@codemirror/view` | 6.43.15 | MIT | 2026-10-19T17:37:46.811Z | 2026-10-24 |
| `@lezer/common` | 1.5.3 | MIT | 2026-09-24T15:50:14.097Z | 2026-10-24 |
| `@lezer/highlight` | 1.2.5 | MIT | 2026-09-28T06:38:18.133Z | 2026-10-24 |
| `@lezer/lr` | 1.4.11 | MIT | 2026-10-07T11:40:01.659Z | 2026-10-24 |
| `@marijn/find-cluster-break` | 1.0.4 | MIT | 2026-08-21T10:56:13.060Z | 2026-10-24 |
| `@tauri-apps/api` | 2.12.4 | Apache-2.0 OR MIT | 2026-10-14T18:47:44.921Z | 2026-10-24 |
| `crelt` | 1.0.7 | MIT | 2026-06-27T10:39:54.087Z | 2026-10-24 |
| `style-mod` | 4.1.4 | MIT | 2026-09-18T06:32:42.106Z | 2026-10-24 |
| `w3c-keyname` | 2.2.8 | MIT | 2023-06-07T07:41:28.542Z | 2026-10-24 |

## Rust dependency of the same work package

Not a front package, recorded here because the same change adds it (CA-47):
`rfd` 0.17.2 (MIT, published 2026-01-12 on crates.io), pinned in the root
`Cargo.toml` with its reason; `cargo deny check bans licenses sources` passes.

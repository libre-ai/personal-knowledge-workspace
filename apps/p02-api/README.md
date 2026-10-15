# p02-api

HTTP API of P02 (veille). It authenticates the owner, enqueues `p02-job-v1`
commands for the worker in the session's tenant, and reports job state. It
**never fetches a URL and never evaluates a rule**: both belong to the worker
(PRD 12 §3.7, S0.5). A test enforces this by refusing outbound network
primitives in `src/`.

Every response is either an envelope or a refusal, described below.

## Authentication

`Authorization: Bearer <token>`, where the token matches 32 to 256 characters
of `[A-Za-z0-9_-]`. The API hashes it with SHA-256 and looks up the hash in
`p02.sessions`. Only the hash is stored. A missing, unknown, expired or revoked
session returns `401 p02.unauthenticated`, and the three cases are not
distinguished.

The API cannot create a session. Sessions come from provisioning; the passkey
ceremony that will mint them is task S0.4 and is not implemented.

## Endpoints

| Method | Path | Success | Purpose |
| --- | --- | --- | --- |
| `GET` | `/v1/health` | `200` | Liveness. No authentication. |
| `POST` | `/v1/jobs` | `201` new, `200` replay | Enqueue a `fetch-source` command. |
| `GET` | `/v1/jobs/:jobId` | `200` | Read state, attempts and result of one job. |
| `GET` | `/v1/jobs/:jobId/items` | `200` | Read the parsed items of one job, one page at a time. |
| `POST` | `/v1/sources` | `201` new, `200` replay | Schedule a feed to be fetched every `intervalSeconds`. |
| `GET` | `/v1/sources/:sourceId` | `200` | Read one scheduled source and its next run. |

Any other method on these paths returns `405`; any other path returns `404`.

### `POST /v1/jobs`

Required headers:

- `Authorization: Bearer <token>`
- `Idempotency-Key: <key>`: 1 to 128 characters, starting with a letter or a
  digit, then `[A-Za-z0-9._:-]`.
- `Content-Type: application/json` (the body is parsed as JSON whatever the
  header says).

Body: the operation fields of a `fetch-source` command, all required except
`validators`:

| Field | Type | Constraint |
| --- | --- | --- |
| `sourceId` | string | identifier `[a-z][a-z0-9_-]{2,127}` |
| `url` | string | `http` or `https`, default ports only, at most 2048 characters |
| `bodyKind` | string | `feed` or `page` |
| `validators` | object, optional | `etag` and/or `lastModified` (conditional request) |

The API adds the rest of the command itself: job identifier, tenant (taken
from the session, never from the body), idempotency key, and enqueue time. The
command is validated against the vendored `p02-job-v1` schema before any write.
Any field outside the contract yields `422`, and no row is written.

The body is capped at **16 KiB**. A larger body returns `413`, whether it
declares its size or not.

Idempotency: the same key with the same operation returns the existing job
with `200`. The same key with a different operation returns `409`. The key is
scoped to the tenant.

Response `201` or `200`:

```json
{ "data": { "jobId": "job-…", "state": "queued" }, "meta": {} }
```

### `GET /v1/jobs/:jobId`

```json
{ "data": { "jobId": "job-…", "state": "queued", "attempts": 0, "result": null }, "meta": {} }
```

A job of another tenant returns `404`, exactly like an unknown job: the
database policy hides it, so the API cannot tell the two apart.

`state` is one of `queued`, `running`, `succeeded`, `refused`, `failed`.
`result` is `null` until the worker records a `p02-job-v1` result, which
carries the final hop, the HTTP status, and the BLAKE3 digest of the body. It
never carries the content.

### `POST /v1/sources`

Requires `Idempotency-Key`. Body, closed (no other field is accepted):

```json
{ "url": "https://feeds.example.org/atom.xml", "intervalSeconds": 3600 }
```

- `url` must be a `fetch-source` URL the contract accepts (http or https, no
  credentials, at most 2048 characters). A URL the contract refuses returns
  `422 p02.source_invalid`, so the worker never claims a job it must refuse.
- `intervalSeconds` is an integer from 300 (five minutes) to 86400 (one day).
- The first run is due now. The worker enqueues one job per due instant; a
  schedule that was down for hours produces one job, not one per missed
  interval, and its next run is one interval from the moment it recovers.
- A replay with the same key returns the same source (`200`); another body
  under that key returns `409 p02.idempotency_conflict`.

```json
{
  "data": {
    "scheduleId": "src-…",
    "url": "https://feeds.example.org/atom.xml",
    "intervalSeconds": 3600,
    "nextRunAt": "2026-10-14T08:00:00.000Z",
    "lastJobId": null
  },
  "meta": {}
}
```

The scheduled job of an instant has a deterministic identity, derived from the
schedule and that instant. An interruption between the job's creation and the
advance of the schedule cannot yield two jobs for the same instant, because the
two writes share one transaction.

### `GET /v1/jobs/:jobId/items`

Query: `limit` (integer 1 to 200, default 50) and `cursor` (the `nextCursor`
of the previous page; omit it for the first page).

```json
{
  "data": [
    {
      "itemId": "3f2a…",
      "position": 0,
      "title": "First",
      "link": "https://feeds.example.org/a",
      "summaryHtml": "<p>Lead text</p>",
      "publishedAt": "2026-10-01T08:00:00.000Z",
      "updatedAt": null
    }
  ],
  "meta": {
    "state": "succeeded",
    "parse": { "status": "parsed", "refusal": null },
    "nextCursor": "49"
  }
}
```

- `itemId` is the canonical identity: 64 lowercase hex characters, derived from
  the source URL and the item's link (else its title and publication time).
  It is stable across fetches of the same feed; the same article fetched by
  two jobs is two items until cross-job deduplication lands.
- `parse` is `null` while the job has no parse record yet (queued or running).
  A refused parse has `status: "refused"` and a `refusal` code: `too_large`,
  `too_many_items`, `malformed`, `unsupported`, or `worker_failed` (the parser
  could not answer; no content is recorded).
- `summaryHtml` is sanitised by the worker before storage, with an allowlist of
  tags. Clients must still render it as HTML only through a sanitiser of their
  own, not as trusted markup.
- A job of another tenant, or an unknown job, returns `404`. A malformed
  `limit` or `cursor` returns `400` with `p02.limit_invalid` or
  `p02.cursor_invalid`.

## Refusals

Refusals use a fixed message per code. They never echo the request, so a URL,
a token or a key cannot leak into a log through an error.

```json
{ "error": { "code": "p02.not_found", "message": "No such resource.", "requestId": "req_…" } }
```

| Status | Code | When |
| --- | --- | --- |
| 400 | `p02.body_invalid` | The body is not JSON. |
| 400 | `p02.idempotency_key_required` | No `Idempotency-Key` header. |
| 400 | `p02.idempotency_key_invalid` | The key is malformed. |
| 401 | `p02.unauthenticated` | No live session. |
| 404 | `p02.not_found` | Unknown path, or unknown or foreign job. |
| 405 | `p02.method_not_allowed` | Wrong method for the path. |
| 409 | `p02.idempotency_conflict` | Same key, different operation. |
| 413 | `p02.body_too_large` | Body over 16 KiB. |
| 422 | `p02.command_invalid` | Operation outside the contract. |
| 503 | `p02.store_unavailable` | Database or runtime failure; nothing is echoed. |

## Example

`examples/enqueue-and-read.ts` enqueues one job and reads it back:

```sh
P02_API_URL=https://p02.example.org P02_SESSION_TOKEN=<token> \
  bun apps/p02-api/examples/enqueue-and-read.ts
```

It exits 1 on any refusal and prints the stable error code. The token is read
from the environment and never printed. `test/example.test.ts` runs this exact
script against a live server on a throwaway database, so this example is
executed in CI, not only read.

## Running the server

```sh
bun run --cwd apps/p02-api start
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `P02_API_HOSTNAME` | `127.0.0.1` | Listen address. |
| `P02_API_PORT` | `8402` | Listen port. |
| `P02_API_DATABASE_SOCKET_DIR` | — | Unix socket directory of PostgreSQL. |
| `P02_API_DATABASE_USER` | `p02_api_login` | Login member of `p02_api`. |
| `P02_API_DATABASE_NAME` | `p02` | Database name. |

The build has **no TLS transport to PostgreSQL**: the server connects over a
Unix socket only. Put a TLS proxy in front of the listen port for any remote
exposure.

### Worker

The worker (`p02-worker run`, connecting as `p02_worker_login`) also needs
these variables. It refuses to start without the parser binary.

| Variable | Meaning |
| --- | --- |
| `P02_DATABASE_URL` | libpq connection string, Unix socket host only. |
| `P02_PARSE_WORKER` | **Absolute** path to the `p02-parse-worker` binary, an existing file. Feeds are parsed only in that child process. |

Parsing runs only on Linux: the child process applies kernel limits that other
platforms cannot enforce, so the parser refuses to run there. Run the worker
on Linux, in a container or a VM.

## Tests

```sh
bun test --cwd apps/p02-api
bun run --cwd apps/p02-api typecheck
```

The tests start throwaway PostgreSQL clusters. They refuse to pass without
server binaries (`P02_PG_BINDIR` or a standard installation); a database test
never passes by skipping.

## Known limits

- The idempotency lookup on a replay (`SELECT … WHERE idempotency_key = …`)
  does not filter on the tenant in the SQL. It relies on the row-level policy
  of the tenant context, which the test suite covers (a cross-tenant replay
  returns a distinct job). A defence in depth filter would be a cheap addition.
- The `fetch-source` operation is the only one. The body is merged after the
  `type` field, so the schema is the only guard on the operation's shape.
- Session minting (S0.4) is absent: sessions exist only through provisioning.

/**
 * End-to-end suite of P02: the Bun API served over HTTP, the Rust worker
 * binary running as a separate process, a throwaway PostgreSQL cluster in
 * between, and a fixture feed server on 127.0.0.1.
 *
 * Two worker builds are required, both prebuilt by the caller (the Linux
 * container script, `p02-worker` and `p02-parse-worker` in each directory):
 * - `P02_E2E_LOOPBACK_BIN_DIR`: built with `--features e2e-loopback`, the only
 *   build that fetches the 127.0.0.1 fixtures;
 * - `P02_E2E_BIN_DIR`: the production build, which must refuse them.
 *
 * Missing binaries or a missing PostgreSQL throw: a scenario never passes by
 * skipping. Each scenario starts its own cluster, so none depends on another.
 */

import { describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import type { SQL, Subprocess } from "bun";
import { createApp } from "../../src/app";
import { API_LOGIN, BOOTSTRAP, startCluster, type TestCluster, WORKER_LOGIN } from "../pg";

function requiredDir(name: string): string {
  const value = process.env[name];
  if (!value?.startsWith("/")) {
    throw new Error(`${name} must name an absolute directory with the worker binaries`);
  }
  return value;
}

const LOOPBACK_BIN = requiredDir("P02_E2E_LOOPBACK_BIN_DIR");
const PRODUCTION_BIN = requiredDir("P02_E2E_BIN_DIR");

const RSS_THREE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Fixture</title><link>https://feeds.example.org/</link>
<description>Fixture feed</description>
<item><title>One</title><link>https://feeds.example.org/1</link><description>first</description></item>
<item><title>Two</title><link>https://feeds.example.org/2</link><description>second</description></item>
<item><title>Three</title><link>https://feeds.example.org/3</link><description>third</description></item>
</channel></rss>`;

const RSS_MALFORMED = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>cut`;

/** Latin-1 bytes behind a declaration that names no UTF-8. */
const RSS_LATIN1 = Buffer.from(
  `<?xml version="1.0" encoding="ISO-8859-1"?>\n<rss version="2.0"><channel><title>Café</title>` +
    `<link>https://feeds.example.org/</link><description>d</description></channel></rss>`,
  "latin1",
);

interface SourceView {
  scheduleId: string;
  url: string;
  intervalSeconds: number;
  nextRunAt: string | null;
  lastJobId: string | null;
}

interface JobView {
  jobId: string;
  state: string;
  attempts: number;
  result: { reasonCode?: string; status?: string } | null;
}

interface ItemsPage {
  data: { itemId: string; position: number; title: string }[];
  meta: {
    state: string;
    parse: { status: string; refusal: string | null } | null;
    nextCursor: string | null;
  };
}

interface Problem {
  error: { code: string; requestId: string };
}

interface Reply {
  status: number;
  body: unknown;
}

/** A running stack: API over HTTP, fixture server, cluster, and workers. */
interface Stack {
  cluster: TestCluster;
  owner: SQL;
  api: string;
  fixture: string;
  /** Paths the fixture server answered, in order. */
  hits: string[];
  /** Replace the body served at `path`. */
  serve(path: string, body: string | Buffer, contentType?: string): void;
  workers: Subprocess[];
  worker(binDir: string): Subprocess;
  stop(): Promise<void>;
}

async function startStack(options: {
  limits?: { sources?: number; openJobs?: number };
}): Promise<Stack> {
  const cluster = await startCluster();
  const owner = cluster.connect(BOOTSTRAP);
  const app = createApp({ sql: cluster.connect(API_LOGIN), limits: options.limits });
  const api = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => app.handle(request),
  });
  const replies = new Map<string, { body: string | Buffer; contentType: string }>();
  const hits: string[] = [];
  // The contract accepts default ports only, so the fixture listens on 80 and
  // its URLs carry no port. Binding 80 needs CAP_NET_BIND_SERVICE on bun.
  const fixture = Bun.serve({
    hostname: "127.0.0.1",
    port: 80,
    fetch(request) {
      const { pathname } = new URL(request.url);
      hits.push(pathname);
      const reply = replies.get(pathname);
      if (!reply) return new Response("not here", { status: 404 });
      return new Response(reply.body, { headers: { "content-type": reply.contentType } });
    },
  });
  const workers: Subprocess[] = [];
  const stack: Stack = {
    cluster,
    owner,
    api: `http://127.0.0.1:${api.port}`,
    fixture: "http://127.0.0.1",
    hits,
    serve(path, body, contentType = "application/rss+xml") {
      replies.set(path, { body, contentType });
    },
    workers,
    worker(binDir) {
      const child = Bun.spawn([join(binDir, "p02-worker"), "run"], {
        env: {
          P02_DATABASE_URL: `host=${cluster.socketDir} dbname=p02 user=${WORKER_LOGIN}`,
          P02_PARSE_WORKER: join(binDir, "p02-parse-worker"),
        },
        stdout: "ignore",
        stderr: "pipe",
      });
      workers.push(child);
      return child;
    },
    async stop() {
      for (const child of workers) {
        if (child.exitCode === null) child.kill("SIGKILL");
        await child.exited;
      }
      api.stop(true);
      fixture.stop(true);
      await cluster.stop();
    },
  };
  return stack;
}

/** Run `scenario` on a fresh stack and always tear the stack down. */
async function withStack(
  options: Parameters<typeof startStack>[0],
  scenario: (stack: Stack) => Promise<void>,
): Promise<void> {
  const stack = await startStack(options);
  try {
    await scenario(stack);
  } finally {
    await stack.stop();
  }
}

/** A tenant id of the contract shape, unique per call. */
function newTenant(): string {
  return `ten_${randomBytes(8).toString("hex")}`;
}

/** Mint a live session for `tenant`, as the authentication flow would. */
async function session(stack: Stack, tenant: string): Promise<string> {
  const token = randomBytes(32).toString("hex");
  const hash = createHash("sha256").update(token).digest("hex");
  await stack.owner`INSERT INTO p02.sessions (token_sha256, tenant_id, expires_at)
                    VALUES (${hash}, ${tenant}, now() + interval '1 hour')`;
  return token;
}

async function call(
  stack: Stack,
  method: string,
  path: string,
  options: { token?: string; key?: string; body?: unknown } = {},
): Promise<Reply> {
  const headers: Record<string, string> = {};
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.key) headers["idempotency-key"] = options.key;
  if (options.body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${stack.api}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { status: response.status, body: await response.json() };
}

/** The stderr of a child spawned with `stderr: "pipe"`, read to its end. */
async function stderrText(child: Subprocess): Promise<string> {
  if (!(child.stderr instanceof ReadableStream)) {
    throw new Error("worker stderr was not piped");
  }
  return new Response(child.stderr).text();
}

function data<T>(reply: Reply): T {
  return (reply.body as { data: T }).data;
}

function problem(reply: Reply): string {
  return (reply.body as Problem).error.code;
}

/** Poll `read` until it returns a value, or fail after `timeoutMs`. */
async function eventually<T>(
  what: string,
  read: () => Promise<T | undefined>,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(100);
  }
}

/** The source once the worker has scheduled its first job. */
async function scheduledJob(stack: Stack, token: string, scheduleId: string): Promise<JobView> {
  const source = await eventually("first scheduled job", async () => {
    const reply = await call(stack, "GET", `/v1/sources/${scheduleId}`, { token });
    const view = data<SourceView>(reply);
    return view.lastJobId ?? undefined;
  });
  return eventually(`job ${source} to finish`, async () => {
    const reply = await call(stack, "GET", `/v1/jobs/${source}`, { token });
    const job = data<JobView>(reply);
    return job.state === "queued" || job.state === "running" ? undefined : job;
  });
}

async function createSource(
  stack: Stack,
  token: string,
  key: string,
  url: string,
  intervalSeconds = 300,
): Promise<Reply> {
  return call(stack, "POST", "/v1/sources", {
    token,
    key,
    body: { url, intervalSeconds },
  });
}

async function jobCount(stack: Stack, tenant: string, scheduleId: string): Promise<number> {
  const rows = await stack.owner`
    SELECT count(*)::int AS n FROM p02.jobs
    WHERE tenant_id = ${tenant} AND command->'operation'->>'sourceId' = ${scheduleId}`;
  return Number(rows[0]?.n ?? -1);
}

describe("P02 end to end", () => {
  test("1. nominal: the worker fetches a scheduled source and its items page through", async () => {
    await withStack({}, async (stack) => {
      stack.serve("/feed.xml", RSS_THREE);
      const tenant = newTenant();
      const token = await session(stack, tenant);
      const created = await createSource(stack, token, "src-nominal", `${stack.fixture}/feed.xml`);
      expect(created.status).toBe(201);
      const source = data<SourceView>(created);
      expect(source.scheduleId).toMatch(/^src-[0-9a-f]{24}$/);
      expect(source.lastJobId).toBeNull();

      stack.worker(LOOPBACK_BIN);
      const job = await scheduledJob(stack, token, source.scheduleId);
      expect(job.state).toBe("succeeded");

      const first = await call(stack, "GET", `/v1/jobs/${job.jobId}/items?limit=2`, { token });
      expect(first.status).toBe(200);
      const page1 = first.body as ItemsPage;
      expect(page1.data.map((item) => item.title)).toEqual(["One", "Two"]);
      expect(page1.data.map((item) => item.position)).toEqual([0, 1]);
      expect(page1.meta.parse).toEqual({ status: "parsed", refusal: null });
      expect(page1.meta.nextCursor).toBe("1");

      const second = await call(stack, "GET", `/v1/jobs/${job.jobId}/items?limit=2&cursor=1`, {
        token,
      });
      const page2 = second.body as ItemsPage;
      expect(page2.data.map((item) => item.title)).toEqual(["Three"]);
      expect(page2.meta.nextCursor).toBeNull();
      expect(stack.hits).toContain("/feed.xml");
    });
  });

  test("2. a replayed source returns 200 with the same id, a reused key with another body 409", async () => {
    await withStack({}, async (stack) => {
      const token = await session(stack, newTenant());
      const url = `${stack.fixture}/feed.xml`;
      const first = await createSource(stack, token, "src-replay", url);
      expect(first.status).toBe(201);
      const replay = await createSource(stack, token, "src-replay", url);
      expect(replay.status).toBe(200);
      expect(data<SourceView>(replay).scheduleId).toBe(data<SourceView>(first).scheduleId);

      const conflict = await createSource(stack, token, "src-replay", url, 600);
      expect(conflict.status).toBe(409);
      expect(problem(conflict)).toBe("p02.idempotency_conflict");
    });
  });

  test("3. a malformed feed succeeds as a fetch, is refused as a parse, and stores no item", async () => {
    await withStack({}, async (stack) => {
      stack.serve("/broken.xml", RSS_MALFORMED);
      const token = await session(stack, newTenant());
      const created = await createSource(
        stack,
        token,
        "src-malformed",
        `${stack.fixture}/broken.xml`,
      );
      const source = data<SourceView>(created);
      stack.worker(LOOPBACK_BIN);
      const job = await scheduledJob(stack, token, source.scheduleId);
      expect(job.state).toBe("succeeded");
      const items = (await call(stack, "GET", `/v1/jobs/${job.jobId}/items`, { token }))
        .body as ItemsPage;
      expect(items.meta.parse).toEqual({ status: "refused", refusal: "malformed" });
      expect(items.data).toEqual([]);
    });
  });

  test("4. a non-UTF-8 XML feed is refused as unsupported, without a panic", async () => {
    await withStack({}, async (stack) => {
      stack.serve("/latin1.xml", RSS_LATIN1);
      const token = await session(stack, newTenant());
      const created = await createSource(stack, token, "src-latin1", `${stack.fixture}/latin1.xml`);
      const source = data<SourceView>(created);
      const worker = stack.worker(LOOPBACK_BIN);
      const job = await scheduledJob(stack, token, source.scheduleId);
      expect(job.state).toBe("succeeded");
      const items = (await call(stack, "GET", `/v1/jobs/${job.jobId}/items`, { token }))
        .body as ItemsPage;
      expect(items.meta.parse).toEqual({ status: "refused", refusal: "unsupported" });
      expect(items.data).toEqual([]);
      // A panic aborts the process (panic = "abort"): the worker must still be alive.
      expect(worker.exitCode).toBeNull();
    });
  });

  test("5. the production worker refuses 127.0.0.1 and a name resolving to it: typed refusal, no item", async () => {
    await withStack({}, async (stack) => {
      stack.serve("/feed.xml", RSS_THREE);
      const token = await session(stack, newTenant());
      const literal = data<SourceView>(
        await createSource(stack, token, "src-literal", `${stack.fixture}/feed.xml`),
      );
      const named = data<SourceView>(
        await createSource(stack, token, "src-named", "http://localhost/feed.xml"),
      );
      stack.worker(PRODUCTION_BIN);
      const byLiteral = await scheduledJob(stack, token, literal.scheduleId);
      const byName = await scheduledJob(stack, token, named.scheduleId);
      expect(byLiteral.state).toBe("refused");
      expect(byLiteral.result?.reasonCode).toBe("fetch.destination_forbidden");
      expect(byName.state).toBe("refused");
      expect(byName.result?.reasonCode).toBe("fetch.destination_forbidden");
      const items = (await call(stack, "GET", `/v1/jobs/${byLiteral.jobId}/items`, { token }))
        .body as ItemsPage;
      expect(items.data).toEqual([]);
      // The fixture never saw a connection: the refusal happened before any I/O.
      expect(stack.hits).toEqual([]);
    });
  });

  test("6. quotas: a full tenant gets 429 for new work, and a replay is still served", async () => {
    await withStack({ limits: { sources: 1, openJobs: 1 } }, async (stack) => {
      const token = await session(stack, newTenant());
      const url = `${stack.fixture}/feed.xml`;
      const kept = await createSource(stack, token, "src-kept", url);
      expect(kept.status).toBe(201);
      const refused = await createSource(stack, token, "src-over", url);
      expect(refused.status).toBe(429);
      expect(problem(refused)).toBe("p02.quota_exceeded");
      const replay = await createSource(stack, token, "src-kept", url);
      expect(replay.status).toBe(200);

      const body = { sourceId: "src-quota", url, bodyKind: "feed" };
      const job = await call(stack, "POST", "/v1/jobs", { token, key: "job-kept", body });
      expect(job.status).toBe(201);
      const overJobs = await call(stack, "POST", "/v1/jobs", { token, key: "job-over", body });
      expect(overJobs.status).toBe(429);
      expect(problem(overJobs)).toBe("p02.quota_exceeded");
      const jobReplay = await call(stack, "POST", "/v1/jobs", { token, key: "job-kept", body });
      expect(jobReplay.status).toBe(200);
      expect(data<{ jobId: string }>(jobReplay).jobId).toBe(data<{ jobId: string }>(job).jobId);
    });
  });

  test("7. auth: no token is 401, another tenant sees 404, a forbidden method is 405", async () => {
    await withStack({}, async (stack) => {
      const owner = await session(stack, newTenant());
      const other = await session(stack, newTenant());
      const created = data<SourceView>(
        await createSource(stack, owner, "src-private", `${stack.fixture}/feed.xml`),
      );

      const anonymous = await call(stack, "POST", "/v1/sources", {
        key: "src-anon",
        body: { url: `${stack.fixture}/feed.xml`, intervalSeconds: 300 },
      });
      expect(anonymous.status).toBe(401);
      expect(problem(anonymous)).toBe("p02.unauthenticated");
      const badToken = await call(stack, "GET", `/v1/sources/${created.scheduleId}`, {
        token: "0".repeat(64),
      });
      expect(badToken.status).toBe(401);

      const crossSource = await call(stack, "GET", `/v1/sources/${created.scheduleId}`, {
        token: other,
      });
      expect(crossSource.status).toBe(404);
      expect(problem(crossSource)).toBe("p02.not_found");
      const crossJob = await call(stack, "GET", "/v1/jobs/job-000000000000", { token: other });
      expect(crossJob.status).toBe(404);

      const listSources = await call(stack, "GET", "/v1/sources", { token: owner });
      expect(listSources.status).toBe(405);
      expect(problem(listSources)).toBe("p02.method_not_allowed");
      const putSource = await call(stack, "PUT", `/v1/sources/${created.scheduleId}`, {
        token: owner,
        body: {},
      });
      expect(putSource.status).toBe(405);
      const getJobs = await call(stack, "GET", "/v1/jobs", { token: owner });
      expect(getJobs.status).toBe(405);
    });
  });

  test("8. a source overdue by several intervals gets one job, not a burst", async () => {
    await withStack({}, async (stack) => {
      stack.serve("/feed.xml", RSS_THREE);
      const tenant = newTenant();
      const token = await session(stack, tenant);
      const source = data<SourceView>(
        await createSource(stack, token, "src-outage", `${stack.fixture}/feed.xml`),
      );
      // Simulate an outage: the schedule has been due for 3.5 intervals.
      await stack.owner`UPDATE p02.schedules
                        SET next_run_at = now() - make_interval(secs => ${1050}::float8)
                        WHERE schedule_id = ${source.scheduleId}`;
      stack.worker(LOOPBACK_BIN);
      await scheduledJob(stack, token, source.scheduleId);
      await Bun.sleep(3000);
      expect(await jobCount(stack, tenant, source.scheduleId)).toBe(1);
      const next = await call(stack, "GET", `/v1/sources/${source.scheduleId}`, { token });
      const nextRunAt = Date.parse(data<SourceView>(next).nextRunAt ?? "");
      // Re-anchored on now, not on the missed instants: one full interval ahead.
      expect(nextRunAt - Date.now()).toBeGreaterThan(200_000);
    });
  });

  test("9. two workers racing for one due schedule enqueue exactly one job", async () => {
    await withStack({}, async (stack) => {
      stack.serve("/feed.xml", RSS_THREE);
      const tenant = newTenant();
      const token = await session(stack, tenant);
      const source = data<SourceView>(
        await createSource(stack, token, "src-race", `${stack.fixture}/feed.xml`),
      );
      stack.worker(LOOPBACK_BIN);
      stack.worker(LOOPBACK_BIN);
      await scheduledJob(stack, token, source.scheduleId);
      await Bun.sleep(3000);
      expect(await jobCount(stack, tenant, source.scheduleId)).toBe(1);
    });
  });

  test("10. the worker stops cleanly on SIGINT, and refuses to start without a parser", async () => {
    await withStack({}, async (stack) => {
      const worker = stack.worker(LOOPBACK_BIN);
      await Bun.sleep(1500);
      worker.kill("SIGINT");
      const code = await worker.exited;
      const stderr = await stderrText(worker);
      expect(code).toBe(0);
      expect(stderr).not.toContain("store error");
    });

    const refused = Bun.spawn([join(LOOPBACK_BIN, "p02-worker"), "run"], {
      env: {
        P02_DATABASE_URL: "host=/nonexistent dbname=p02 user=p02_worker_login",
      },
      stdout: "ignore",
      stderr: "pipe",
    });
    expect(await refused.exited).toBe(2);
    expect(await stderrText(refused)).toContain("P02_PARSE_WORKER");
  });
});

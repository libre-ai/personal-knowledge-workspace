import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { resolve } from "node:path";
import type { SQL } from "bun";
import { createApp } from "../src/app";
import { API_LOGIN, BOOTSTRAP, startCluster, type TestCluster } from "./pg";

// The documented example is executed, not only read: it runs as a separate
// process against a live server on a throwaway database, so the README cannot
// drift from the behaviour it describes.
const EXAMPLE = resolve(import.meta.dir, "../examples/enqueue-and-read.ts");
const TENANT = "ten_cccccccccccccccc";

let cluster: TestCluster;
let owner: SQL;
let server: ReturnType<typeof Bun.serve>;
let token: string;

beforeAll(async () => {
  cluster = await startCluster();
  owner = cluster.connect(BOOTSTRAP);
  const app = createApp({ sql: cluster.connect(API_LOGIN) });
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (request) => app.handle(request) });
  token = randomBytes(32).toString("hex");
  const hash = createHash("sha256").update(token).digest("hex");
  await owner`INSERT INTO p02.sessions (token_sha256, tenant_id, expires_at)
              VALUES (${hash}, ${TENANT}, now() + interval '1 hour')`;
});

afterAll(async () => {
  server.stop(true);
  await cluster.stop();
});

// Asynchronous on purpose: the server shares this process, and a blocking
// spawn would starve it of the event loop the example is waiting on.
async function runExample(
  env: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(["bun", "run", EXAMPLE], {
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code: await child.exited, stdout, stderr };
}

test("the example enqueues a job, reads it back and exits 0", async () => {
  const result = await runExample({
    P02_API_URL: `http://127.0.0.1:${server.port}`,
    P02_SESSION_TOKEN: token,
  });

  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toMatch(/^enqueued jobId=job-[0-9a-f]{24} state=queued\n/);
  expect(result.stdout).toMatch(/read jobId=job-[0-9a-f]{24} state=queued attempts=0\n$/);
});

test("the example refuses an unknown token with the stable code and never echoes it", async () => {
  const forged = randomBytes(32).toString("hex");
  const result = await runExample({
    P02_API_URL: `http://127.0.0.1:${server.port}`,
    P02_SESSION_TOKEN: forged,
  });

  expect(result.code).toBe(1);
  expect(result.stderr).toContain("p02.unauthenticated");
  expect(result.stdout + result.stderr).not.toContain(forged);
});

test("the example refuses to start without its environment", async () => {
  const result = await runExample({ P02_API_URL: "", P02_SESSION_TOKEN: "" });

  expect(result.code).toBe(1);
  expect(result.stderr).toContain("P02_API_URL is required");
});

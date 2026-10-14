import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import type { SQL } from "bun";
import { createApp } from "../src/app";
import { API_LOGIN, BOOTSTRAP, startCluster, type TestCluster } from "./pg";

const TENANT = "ten_qqqqqqqqqqqqqqqq";
const FEED = "https://feeds.example.org/atom.xml";

let cluster: TestCluster;
let owner: SQL;
let token: string;

async function session(tenant: string): Promise<string> {
  const value = randomBytes(32).toString("hex");
  const hash = createHash("sha256").update(value).digest("hex");
  await owner`INSERT INTO p02.sessions (token_sha256, tenant_id, expires_at)
              VALUES (${hash}, ${tenant}, now() + interval '1 hour')`;
  return value;
}

function post(path: string, body: unknown, key: string): Request {
  return new Request(`http://api.test${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "idempotency-key": key,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  cluster = await startCluster();
  owner = cluster.connect(BOOTSTRAP);
  token = await session(TENANT);
});

afterAll(async () => {
  await cluster.stop();
});

describe("per-organization limits", () => {
  test("at the source limit, a new source is refused but a replay is still answered", async () => {
    const limited = createApp({ sql: cluster.connect(API_LOGIN), limits: { sources: 1 } });
    const body = { url: FEED, intervalSeconds: 600 };
    const first = await limited.handle(post("/v1/sources", body, "quota-src-1"));
    expect(first.status).toBe(201);

    const refused = await limited.handle(
      post("/v1/sources", { url: "https://feeds.example.org/b.xml", intervalSeconds: 600 }, "quota-src-2"),
    );
    expect(refused.status).toBe(429);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe(
      "p02.quota_exceeded",
    );

    const replay = await limited.handle(post("/v1/sources", body, "quota-src-1"));
    expect(replay.status).toBe(200);
  });

  test("at the open-job limit, a new job is refused but a replay is still answered", async () => {
    const limited = createApp({ sql: cluster.connect(API_LOGIN), limits: { openJobs: 1 } });
    const body = { sourceId: "src-quota", url: FEED, bodyKind: "feed" };
    const first = await limited.handle(post("/v1/jobs", body, "quota-job-1"));
    expect(first.status).toBe(201);

    const refused = await limited.handle(post("/v1/jobs", body, "quota-job-2"));
    expect(refused.status).toBe(429);

    const replay = await limited.handle(post("/v1/jobs", body, "quota-job-1"));
    expect(replay.status).toBe(200);
  });
});

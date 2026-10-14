import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import type { SQL } from "bun";
import { createApp } from "../src/app";
import { API_LOGIN, BOOTSTRAP, startCluster, type TestCluster } from "./pg";

const TENANT_A = "ten_aaaaaaaaaaaaaaaa";
const TENANT_B = "ten_bbbbbbbbbbbbbbbb";
const FEED = "https://feeds.example.org/atom.xml";

let cluster: TestCluster;
let owner: SQL;
let app: ReturnType<typeof createApp>;
let tokenA: string;
let tokenB: string;

async function session(tenant: string): Promise<string> {
  const token = randomBytes(32).toString("hex");
  const hash = createHash("sha256").update(token).digest("hex");
  await owner`INSERT INTO p02.sessions (token_sha256, tenant_id, expires_at)
              VALUES (${hash}, ${tenant}, now() + interval '1 hour')`;
  return token;
}

function create(body: unknown, token: string | null, key: string | null): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  if (key !== null) headers["idempotency-key"] = key;
  return new Request("http://api.test/v1/sources", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function read(path: string, token: string | null): Request {
  const headers: Record<string, string> = token === null ? {} : { authorization: `Bearer ${token}` };
  return new Request(`http://api.test${path}`, { headers });
}

beforeAll(async () => {
  cluster = await startCluster();
  owner = cluster.connect(BOOTSTRAP);
  app = createApp({ sql: cluster.connect(API_LOGIN) });
  tokenA = await session(TENANT_A);
  tokenB = await session(TENANT_B);
});

afterAll(async () => {
  await cluster.stop();
});

describe("sources: scheduled feed fetches", () => {
  test("creating a source schedules its first run now and returns it", async () => {
    const response = await app.handle(
      create({ url: FEED, intervalSeconds: 3600 }, tokenA, "src-create-1"),
    );
    expect(response.status).toBe(201);
    const { data } = (await response.json()) as {
      data: { scheduleId: string; url: string; intervalSeconds: number; nextRunAt: string; lastJobId: null };
    };
    expect(data.scheduleId).toMatch(/^src-[0-9a-f]{24}$/);
    expect(data.url).toBe(FEED);
    expect(data.intervalSeconds).toBe(3600);
    expect(data.lastJobId).toBeNull();
    expect(Math.abs(Date.parse(data.nextRunAt) - Date.now())).toBeLessThan(60_000);
  });

  test("a replay with the same key returns the same source; another body conflicts", async () => {
    const first = await app.handle(create({ url: FEED, intervalSeconds: 600 }, tokenA, "src-replay-1"));
    const created = (await first.json()) as { data: { scheduleId: string } };
    const replay = await app.handle(create({ url: FEED, intervalSeconds: 600 }, tokenA, "src-replay-1"));
    expect(replay.status).toBe(200);
    expect(((await replay.json()) as { data: { scheduleId: string } }).data.scheduleId).toBe(
      created.data.scheduleId,
    );
    const other = await app.handle(
      create({ url: "https://feeds.example.org/other.xml", intervalSeconds: 600 }, tokenA, "src-replay-1"),
    );
    expect(other.status).toBe(409);
  });

  test("the source's URL and interval are bounded by the contract and the schedule rules", async () => {
    const cases: [string, unknown][] = [
      ["interval below five minutes", { url: FEED, intervalSeconds: 299 }],
      ["interval above one day", { url: FEED, intervalSeconds: 86401 }],
      ["interval not an integer", { url: FEED, intervalSeconds: 600.5 }],
      ["non-http scheme", { url: "ftp://feeds.example.org/a.xml", intervalSeconds: 600 }],
      ["credentials in the URL", { url: "https://user:secret@feeds.example.org/a.xml", intervalSeconds: 600 }],
      ["unknown field", { url: FEED, intervalSeconds: 600, extra: true }],
      ["missing field", { url: FEED }],
      ["array body", [FEED]],
    ];
    for (const [name, body] of cases) {
      const response = await app.handle(create(body, tokenA, `bad-${name.replace(/\W/g, "-")}`));
      expect(response.status, name).toBe(422);
      const text = await response.text();
      expect(text, name).not.toContain("secret");
    }
  });

  test("an unparseable body and a missing key are typed refusals", async () => {
    const malformed = await app.handle(create("{not json", tokenA, "src-json-1"));
    expect(malformed.status).toBe(400);
    const noKey = await app.handle(create({ url: FEED, intervalSeconds: 600 }, tokenA, null));
    expect(noKey.status).toBe(400);
    const badKey = await app.handle(create({ url: FEED, intervalSeconds: 600 }, tokenA, "bad key!"));
    expect(badKey.status).toBe(400);
  });

  test("a source is readable by its tenant only; an unknown one is a 404", async () => {
    const created = await app.handle(create({ url: FEED, intervalSeconds: 900 }, tokenA, "src-read-1"));
    const { data } = (await created.json()) as { data: { scheduleId: string } };
    const mine = await app.handle(read(`/v1/sources/${data.scheduleId}`, tokenA));
    expect(mine.status).toBe(200);
    const theirs = await app.handle(read(`/v1/sources/${data.scheduleId}`, tokenB));
    expect(theirs.status).toBe(404);
    const unknown = await app.handle(read("/v1/sources/src-does-not-exist", tokenA));
    expect(unknown.status).toBe(404);
  });

  test("the routes require a live session and the right methods", async () => {
    const anonymous = await app.handle(create({ url: FEED, intervalSeconds: 600 }, null, "src-anon-1"));
    expect(anonymous.status).toBe(401);
    const getCreate = await app.handle(
      new Request("http://api.test/v1/sources", { headers: { authorization: `Bearer ${tokenA}` } }),
    );
    expect(getCreate.status).toBe(405);
    const postRead = await app.handle(
      new Request("http://api.test/v1/sources/src-x", {
        method: "POST",
        headers: { authorization: `Bearer ${tokenA}` },
      }),
    );
    expect(postRead.status).toBe(405);
  });
});

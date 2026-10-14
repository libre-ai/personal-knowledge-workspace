import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import type { SQL } from "bun";
import { createApp } from "../src/app";
import { API_LOGIN, BOOTSTRAP, startCluster, type TestCluster } from "./pg";

const TENANT_A = "ten_aaaaaaaaaaaaaaaa";
const TENANT_B = "ten_bbbbbbbbbbbbbbbb";
const SOURCE = {
  sourceId: "src-example",
  url: "https://feeds.example.org/atom.xml",
  bodyKind: "feed",
};

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

function get(path: string, token?: string): Request {
  const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};
  return new Request(`http://api.test${path}`, { headers });
}

/** A job of `tenant`, as the API enqueues it, then finished by the worker's
 * side of the contract: its parse record and items are written directly. */
async function finishedJob(
  tenant: string,
  token: string,
  key: string,
  parse: { status: "parsed" | "refused"; refusal: string | null },
  titles: string[],
): Promise<string> {
  const created = await app.handle(
    new Request("http://api.test/v1/jobs", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "idempotency-key": key,
        "content-type": "application/json",
      },
      body: JSON.stringify(SOURCE),
    }),
  );
  const { data } = (await created.json()) as { data: { jobId: string } };
  const jobId = data.jobId;
  await owner`UPDATE p02.jobs SET state = 'succeeded' WHERE job_id = ${jobId}`;
  await owner`INSERT INTO p02.feed_parses (tenant_id, job_id, status, refusal, item_count)
              VALUES (${tenant}, ${jobId}, ${parse.status}, ${parse.refusal}, ${titles.length})`;
  for (const [position, title] of titles.entries()) {
    const itemId = createHash("sha256").update(`${jobId}-${position}`).digest("hex");
    await owner`INSERT INTO p02.items (tenant_id, job_id, item_id, position, title, link, published_at)
                VALUES (${tenant}, ${jobId}, ${itemId}, ${position}, ${title},
                        ${`https://feeds.example.org/${position}`},
                        ${new Date(Date.UTC(2026, 9, 1, 8, position))})`;
  }
  return jobId;
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

describe("GET /v1/jobs/:id/items", () => {
  test("pages through the items in feed order with a cursor", async () => {
    const jobId = await finishedJob(
      TENANT_A,
      tokenA,
      "page-1",
      { status: "parsed", refusal: null },
      ["one", "two", "three"],
    );
    const first = await app.handle(get(`/v1/jobs/${jobId}/items?limit=2`, tokenA));
    expect(first.status).toBe(200);
    const page1 = (await first.json()) as {
      data: { position: number; title: string; publishedAt: string }[];
      meta: { state: string; parse: unknown; nextCursor: string | null };
    };
    expect(page1.data.map((item) => item.title)).toEqual(["one", "two"]);
    expect(page1.data[0]?.publishedAt).toBe("2026-10-01T08:00:00.000Z");
    expect(page1.meta).toEqual({
      state: "succeeded",
      parse: { status: "parsed", refusal: null },
      nextCursor: "1",
    });

    const second = await app.handle(
      get(`/v1/jobs/${jobId}/items?limit=2&cursor=${page1.meta.nextCursor}`, tokenA),
    );
    const page2 = (await second.json()) as typeof page1;
    expect(page2.data.map((item) => item.title)).toEqual(["three"]);
    expect(page2.meta.nextCursor).toBeNull();
  });

  test("the default page holds every item of a short feed", async () => {
    const jobId = await finishedJob(
      TENANT_A,
      tokenA,
      "default-1",
      { status: "parsed", refusal: null },
      ["alpha", "beta"],
    );
    const response = await app.handle(get(`/v1/jobs/${jobId}/items`, tokenA));
    const body = (await response.json()) as { data: unknown[]; meta: { nextCursor: unknown } };
    expect(body.data).toHaveLength(2);
    expect(body.meta.nextCursor).toBeNull();
  });

  test("a refused parse is reported with its reason and no items", async () => {
    const jobId = await finishedJob(
      TENANT_A,
      tokenA,
      "refused-1",
      { status: "refused", refusal: "malformed" },
      [],
    );
    const response = await app.handle(get(`/v1/jobs/${jobId}/items`, tokenA));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: [],
      meta: {
        state: "succeeded",
        parse: { status: "refused", refusal: "malformed" },
        nextCursor: null,
      },
    });
  });

  test("a job still queued has no parse record yet", async () => {
    const created = await app.handle(
      new Request("http://api.test/v1/jobs", {
        method: "POST",
        headers: {
          authorization: `Bearer ${tokenA}`,
          "idempotency-key": "queued-1",
          "content-type": "application/json",
        },
        body: JSON.stringify(SOURCE),
      }),
    );
    const { data } = (await created.json()) as { data: { jobId: string } };
    const response = await app.handle(get(`/v1/jobs/${data.jobId}/items`, tokenA));
    expect(await response.json()).toEqual({
      data: [],
      meta: { state: "queued", parse: null, nextCursor: null },
    });
  });

  test("items are readable by their tenant only", async () => {
    const jobId = await finishedJob(
      TENANT_A,
      tokenA,
      "tenant-1",
      { status: "parsed", refusal: null },
      ["private"],
    );
    const theirs = await app.handle(get(`/v1/jobs/${jobId}/items`, tokenB));
    expect(theirs.status).toBe(404);
    const body = await theirs.text();
    expect(body).not.toContain("private");
  });

  test("an unknown job is a 404, and so is a malformed identifier", async () => {
    const unknown = await app.handle(get("/v1/jobs/job-does-not-exist/items", tokenA));
    expect(unknown.status).toBe(404);
    const malformed = await app.handle(get("/v1/jobs/..%2Fetc/items", tokenA));
    expect(malformed.status).toBe(404);
  });

  test("bad paging parameters get typed refusals", async () => {
    const jobId = await finishedJob(
      TENANT_A,
      tokenA,
      "paging-1",
      { status: "parsed", refusal: null },
      ["x"],
    );
    for (const query of ["limit=0", "limit=201", "limit=ten", "cursor=-1", "cursor=abc"]) {
      const response = await app.handle(get(`/v1/jobs/${jobId}/items?${query}`, tokenA));
      expect(response.status, query).toBe(400);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code, query).toMatch(/^p02\.(limit|cursor)_invalid$/);
    }
  });

  test("the route requires a live session and answers GET only", async () => {
    const jobId = await finishedJob(
      TENANT_A,
      tokenA,
      "auth-1",
      { status: "parsed", refusal: null },
      ["y"],
    );
    const anonymous = await app.handle(get(`/v1/jobs/${jobId}/items`));
    expect(anonymous.status).toBe(401);
    const posted = await app.handle(
      new Request(`http://api.test/v1/jobs/${jobId}/items`, {
        method: "POST",
        headers: { authorization: `Bearer ${tokenA}` },
      }),
    );
    expect(posted.status).toBe(405);
  });
});

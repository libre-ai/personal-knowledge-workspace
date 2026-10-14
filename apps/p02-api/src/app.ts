/**
 * P02 API request handling (PRD 12 §3.7). The API authenticates the owner,
 * enqueues p02-job-v1 commands for the worker in the session's tenant and
 * reports job state. It never fetches a URL and never evaluates a rule.
 */
import { createHash, randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { SQL } from "bun";
import { validateJobDocument } from "./contract";
import { sessionTenant, withTenant } from "./db";
import { envelope, problem } from "./http";

/** Largest request body read, in bytes. */
export const MAX_BODY_BYTES = 16 * 1024;
const BEARER = /^Bearer ([A-Za-z0-9_-]{32,256})$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const JOB_ROUTE = /^\/v1\/jobs\/([a-z][a-z0-9_-]{2,127})$/;
const JOB_ITEMS_ROUTE = /^\/v1\/jobs\/([a-z][a-z0-9_-]{2,127})\/items$/;
const DEFAULT_PAGE = 50;
const MAX_PAGE = 200;
const CURSOR = /^(?:0|[1-9][0-9]{0,3})$/;
const SOURCE_ROUTE = /^\/v1\/sources\/([a-z][a-z0-9_-]{2,127})$/;
/** Bounds of a scheduled fetch: five minutes to one day. */
export const MIN_INTERVAL_SECONDS = 300;
export const MAX_INTERVAL_SECONDS = 86400;
const SOURCE_URL_MAX = 2048;

/**
 * Per-organization ceilings. Enforced in the insert statement; under heavy
 * concurrency a tenant can overshoot by the number of requests in flight, so
 * they bound abuse rather than meter exactly.
 */
export interface Limits {
  /** Scheduled sources a tenant may hold. */
  sources: number;
  /** Jobs a tenant may have queued or running at once. */
  openJobs: number;
}

export const DEFAULT_LIMITS: Limits = { sources: 100, openJobs: 1000 };

export interface AppDependencies {
  /** A pool connected as a login member of `p02_api`. */
  sql: SQL;
  now?: () => Date;
  limits?: Partial<Limits>;
}

function limits(deps: AppDependencies): Limits {
  return { ...DEFAULT_LIMITS, ...deps.limits };
}

type Body = { ok: true; value: unknown } | { ok: false; response: Response };

async function readJson(request: Request): Promise<Body> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) {
    return {
      ok: false,
      response: problem(413, "p02.body_too_large", "The request body is too large."),
    };
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (request.body) {
    for await (const chunk of request.body) {
      size += chunk.byteLength;
      if (size > MAX_BODY_BYTES) {
        return {
          ok: false,
          response: problem(413, "p02.body_too_large", "The request body is too large."),
        };
      }
      chunks.push(chunk);
    }
  }
  try {
    return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
  } catch {
    return {
      ok: false,
      response: problem(400, "p02.body_invalid", "The request body is not JSON."),
    };
  }
}

async function authenticate(sql: SQL, request: Request): Promise<string | null> {
  const match = BEARER.exec(request.headers.get("authorization") ?? "");
  const token = match?.[1];
  if (!token) return null;
  const hash = createHash("sha256").update(token).digest("hex");
  return sessionTenant(sql, hash);
}

function unauthenticated(): Response {
  return problem(401, "p02.unauthenticated", "A live session is required.");
}

async function enqueue(deps: AppDependencies, request: Request, tenant: string): Promise<Response> {
  const key = request.headers.get("idempotency-key");
  if (key === null) {
    return problem(400, "p02.idempotency_key_required", "An Idempotency-Key header is required.");
  }
  if (!IDEMPOTENCY_KEY.test(key)) {
    return problem(400, "p02.idempotency_key_invalid", "The Idempotency-Key header is malformed.");
  }
  const body = await readJson(request);
  if (!body.ok) return body.response;
  const operation =
    typeof body.value === "object" && body.value !== null && !Array.isArray(body.value)
      ? { type: "fetch-source", ...body.value }
      : body.value;
  const command = {
    schemaVersion: "libre-ai.p02-job.v1",
    kind: "command",
    jobId: `job-${randomBytes(12).toString("hex")}`,
    tenantId: tenant,
    idempotencyKey: key,
    enqueuedAt: (deps.now?.() ?? new Date()).toISOString(),
    operation,
  };
  if (!validateJobDocument(command).ok) {
    return problem(422, "p02.command_invalid", "The command is outside the p02-job-v1 contract.");
  }
  const openJobs = limits(deps).openJobs;
  return withTenant(deps.sql, tenant, async (tx) => {
    // The insert happens only while the tenant has room for another open job.
    // A replay inserts nothing and is answered from the row it finds.
    const inserted = await tx`
      INSERT INTO p02.jobs (tenant_id, job_id, idempotency_key, operation, command)
      SELECT ${tenant}, ${command.jobId}, ${key}, 'fetch-source', ${command}::jsonb
      WHERE (SELECT count(*) FROM p02.jobs
             WHERE tenant_id = ${tenant} AND state IN ('queued', 'running')) < ${openJobs}
      ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
      RETURNING job_id, state`;
    if (inserted.length === 1) {
      return envelope(201, { jobId: inserted[0].job_id, state: inserted[0].state });
    }
    const existing = await tx`
      SELECT job_id, state, command->'operation' AS operation FROM p02.jobs
      WHERE idempotency_key = ${key}`;
    const row = existing[0];
    if (!row) {
      return problem(429, "p02.quota_exceeded", "The open-job limit of this organization is reached.");
    }
    if (!row || !isDeepStrictEqual(row.operation, operation)) {
      return problem(
        409,
        "p02.idempotency_conflict",
        "This Idempotency-Key was used for another command.",
      );
    }
    return envelope(200, { jobId: row.job_id, state: row.state });
  });
}

async function readJob(deps: AppDependencies, tenant: string, jobId: string): Promise<Response> {
  return withTenant(deps.sql, tenant, async (tx) => {
    const rows =
      await tx`SELECT job_id, state, attempts, result FROM p02.jobs WHERE job_id = ${jobId}`;
    const row = rows[0];
    if (!row) return problem(404, "p02.not_found", "No such resource.");
    return envelope(200, {
      jobId: row.job_id,
      state: row.state,
      attempts: row.attempts,
      result: row.result,
    });
  });
}

/**
 * The parsed items of one job, in feed order, one page at a time. The cursor
 * is the position of the last item returned; it is opaque to clients by
 * contract, though its value is only a number.
 */
async function readItems(
  deps: AppDependencies,
  tenant: string,
  jobId: string,
  query: URLSearchParams,
): Promise<Response> {
  const requested = query.get("limit");
  const limit = requested === null ? DEFAULT_PAGE : Number(requested);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE) {
    return problem(400, "p02.limit_invalid", `limit must be an integer from 1 to ${MAX_PAGE}.`);
  }
  const cursorText = query.get("cursor");
  if (cursorText !== null && !CURSOR.test(cursorText)) {
    return problem(400, "p02.cursor_invalid", "The cursor is malformed.");
  }
  const after = cursorText === null ? -1 : Number(cursorText);
  return withTenant(deps.sql, tenant, async (tx) => {
    const jobs = await tx`SELECT state FROM p02.jobs WHERE job_id = ${jobId}`;
    if (jobs.length === 0) return problem(404, "p02.not_found", "No such resource.");
    const parses = await tx`SELECT status, refusal FROM p02.feed_parses WHERE job_id = ${jobId}`;
    // One row beyond the page tells whether another page exists.
    const rows = await tx`
      SELECT position, item_id, title, link, summary_html, published_at, updated_at
      FROM p02.items
      WHERE job_id = ${jobId} AND position > ${after}
      ORDER BY position
      LIMIT ${limit + 1}`;
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    const parse = parses[0];
    return Response.json(
      {
        data: page.map((row: Record<string, unknown>) => ({
          itemId: row.item_id,
          position: row.position,
          title: row.title,
          link: row.link,
          summaryHtml: row.summary_html,
          publishedAt: isoOrNull(row.published_at),
          updatedAt: isoOrNull(row.updated_at),
        })),
        meta: {
          state: jobs[0].state,
          parse: parse ? { status: parse.status, refusal: parse.refusal } : null,
          nextCursor: rows.length > limit && last ? String(last.position) : null,
        },
      },
      { headers: { "cache-control": "no-store" } },
    );
  });
}

function isoOrNull(value: unknown): string | null {
  return value instanceof Date ? value.toISOString() : null;
}

interface SourceRequest {
  url: string;
  intervalSeconds: number;
}

/** The body of `POST /v1/sources`, closed: unknown fields are refused. */
function sourceRequest(value: unknown): SourceRequest | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.every((key) => key === "url" || key === "intervalSeconds")) {
    return null;
  }
  const { url, intervalSeconds } = value as Record<string, unknown>;
  if (typeof url !== "string" || url.length === 0 || url.length > SOURCE_URL_MAX) return null;
  if (
    typeof intervalSeconds !== "number" ||
    !Number.isInteger(intervalSeconds) ||
    intervalSeconds < MIN_INTERVAL_SECONDS ||
    intervalSeconds > MAX_INTERVAL_SECONDS
  ) {
    return null;
  }
  return { url, intervalSeconds };
}

/** Whether `url` is a `fetch-source` command the contract accepts. The
 * worker would refuse a scheduled job it cannot validate, so the API refuses
 * the source up front, with the same contract the enqueue path uses. */
function isContractUrl(tenant: string, url: string): boolean {
  return validateJobDocument({
    schemaVersion: "libre-ai.p02-job.v1",
    kind: "command",
    jobId: "job-000000000000",
    tenantId: tenant,
    idempotencyKey: "probe",
    enqueuedAt: new Date(0).toISOString(),
    operation: { type: "fetch-source", sourceId: "src-probe", url, bodyKind: "feed" },
  }).ok;
}

function sourceView(row: Record<string, unknown>): Record<string, unknown> {
  return {
    scheduleId: row.schedule_id,
    url: row.url,
    intervalSeconds: row.interval_seconds,
    nextRunAt: isoOrNull(row.next_run_at),
    lastJobId: row.last_job_id ?? null,
  };
}

const SOURCE_REFUSAL =
  "A source needs an http(s) url the contract accepts, of at most 2048 characters, " +
  "and an intervalSeconds from 300 to 86400.";

async function createSource(deps: AppDependencies, request: Request, tenant: string): Promise<Response> {
  const key = request.headers.get("idempotency-key");
  if (key === null) {
    return problem(400, "p02.idempotency_key_required", "An Idempotency-Key header is required.");
  }
  if (!IDEMPOTENCY_KEY.test(key)) {
    return problem(400, "p02.idempotency_key_invalid", "The Idempotency-Key header is malformed.");
  }
  const body = await readJson(request);
  if (!body.ok) return body.response;
  const source = sourceRequest(body.value);
  if (source === null || !isContractUrl(tenant, source.url)) {
    return problem(422, "p02.source_invalid", SOURCE_REFUSAL);
  }
  const scheduleId = `src-${randomBytes(12).toString("hex")}`;
  const maxSources = limits(deps).sources;
  return withTenant(deps.sql, tenant, async (tx) => {
    // Inserted only while the tenant has room for another source.
    const inserted = await tx`
      INSERT INTO p02.schedules (tenant_id, schedule_id, url, interval_seconds, next_run_at, idempotency_key)
      SELECT ${tenant}, ${scheduleId}, ${source.url}, ${source.intervalSeconds}, now(), ${key}
      WHERE (SELECT count(*) FROM p02.schedules WHERE tenant_id = ${tenant}) < ${maxSources}
      ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
      RETURNING schedule_id, url, interval_seconds, next_run_at, last_job_id`;
    if (inserted.length === 1) return envelope(201, sourceView(inserted[0]));
    // A replay returns the source it created; another body under the same key conflicts.
    const existing = await tx`
      SELECT schedule_id, url, interval_seconds, next_run_at, last_job_id FROM p02.schedules
      WHERE tenant_id = ${tenant} AND idempotency_key = ${key}`;
    const row = existing[0];
    if (!row) {
      return problem(429, "p02.quota_exceeded", "The source limit of this organization is reached.");
    }
    if (!row || row.url !== source.url || row.interval_seconds !== source.intervalSeconds) {
      return problem(
        409,
        "p02.idempotency_conflict",
        "This Idempotency-Key was used for another source.",
      );
    }
    return envelope(200, sourceView(row));
  });
}

async function readSource(deps: AppDependencies, tenant: string, scheduleId: string): Promise<Response> {
  return withTenant(deps.sql, tenant, async (tx) => {
    const rows = await tx`
      SELECT schedule_id, url, interval_seconds, next_run_at, last_job_id FROM p02.schedules
      WHERE schedule_id = ${scheduleId}`;
    const row = rows[0];
    if (!row) return problem(404, "p02.not_found", "No such resource.");
    return envelope(200, sourceView(row));
  });
}

export function createApp(deps: AppDependencies): { handle(request: Request): Promise<Response> } {
  async function route(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/v1/health") {
      return request.method === "GET"
        ? envelope(200, { status: "ok" })
        : problem(405, "p02.method_not_allowed", "Method not allowed.");
    }
    if (pathname === "/v1/sources") {
      if (request.method !== "POST") {
        return problem(405, "p02.method_not_allowed", "Method not allowed.");
      }
      const tenant = await authenticate(deps.sql, request);
      if (tenant === null) return unauthenticated();
      return createSource(deps, request, tenant);
    }
    const sourceMatch = SOURCE_ROUTE.exec(pathname);
    if (sourceMatch) {
      if (request.method !== "GET") {
        return problem(405, "p02.method_not_allowed", "Method not allowed.");
      }
      const tenant = await authenticate(deps.sql, request);
      if (tenant === null) return unauthenticated();
      return readSource(deps, tenant, sourceMatch[1] ?? "");
    }
    const itemsMatch = JOB_ITEMS_ROUTE.exec(pathname);
    if (itemsMatch) {
      if (request.method !== "GET") {
        return problem(405, "p02.method_not_allowed", "Method not allowed.");
      }
      const tenant = await authenticate(deps.sql, request);
      if (tenant === null) return unauthenticated();
      return readItems(deps, tenant, itemsMatch[1] ?? "", new URL(request.url).searchParams);
    }
    const jobMatch = JOB_ROUTE.exec(pathname);
    const isJobs = pathname === "/v1/jobs";
    if (!isJobs && !jobMatch) return problem(404, "p02.not_found", "No such resource.");
    const allowed = isJobs ? request.method === "POST" : request.method === "GET";
    if (!allowed) return problem(405, "p02.method_not_allowed", "Method not allowed.");
    const tenant = await authenticate(deps.sql, request);
    if (tenant === null) return unauthenticated();
    if (isJobs) return enqueue(deps, request, tenant);
    return readJob(deps, tenant, jobMatch?.[1] ?? "");
  }

  return {
    async handle(request: Request): Promise<Response> {
      try {
        return await route(request);
      } catch {
        // Database or runtime failure: a fixed refusal, nothing echoed.
        return problem(503, "p02.store_unavailable", "The service is unavailable.");
      }
    },
  };
}

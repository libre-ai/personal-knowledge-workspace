/**
 * Enqueue one `fetch-source` job, then read it back. Run it against a live API:
 *
 *   P02_API_URL=https://p02.example.org P02_SESSION_TOKEN=<token> \
 *     bun run apps/p02-api/examples/enqueue-and-read.ts
 *
 * The session token is the bearer of a live session of the owner's tenant
 * (minted by provisioning; the API never mints one). The token is read from
 * the environment and never printed. Exits 1 on any refusal, with the API's
 * stable error code and no request content.
 */

export {};

const baseUrl = requiredEnv("P02_API_URL");
const token = requiredEnv("P02_SESSION_TOKEN");
const headers = {
  authorization: `Bearer ${token}`,
  "content-type": "application/json",
};

// A fresh key per run: replaying the same key with the same body returns the
// same job (HTTP 200), a different body under the same key returns 409.
const idempotencyKey = `example-${crypto.randomUUID()}`;

const enqueued = await fetch(`${baseUrl}/v1/jobs`, {
  method: "POST",
  headers: { ...headers, "idempotency-key": idempotencyKey },
  body: JSON.stringify({
    sourceId: "example-source",
    url: "https://feeds.example.org/atom.xml",
    bodyKind: "feed",
  }),
});
const created = await unwrap(enqueued, "enqueue");
const jobId = created.data.jobId;
console.log(`enqueued jobId=${jobId} state=${created.data.state}`);

const read = await fetch(`${baseUrl}/v1/jobs/${encodeURIComponent(jobId)}`, { headers });
const job = await unwrap(read, "read");
console.log(`read jobId=${job.data.jobId} state=${job.data.state} attempts=${job.data.attempts}`);

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} is required`);
    process.exit(1);
  }
  return value;
}

interface Envelope {
  data: { jobId: string; state: string; attempts?: number };
  meta: Record<string, unknown>;
}

async function unwrap(response: Response, step: string): Promise<Envelope> {
  const body = (await response.json()) as Envelope | { error: { code: string } };
  if (!response.ok || !("data" in body)) {
    const code = "error" in body ? body.error.code : "unknown";
    console.error(`${step} refused: HTTP ${response.status} ${code}`);
    process.exit(1);
  }
  return body;
}

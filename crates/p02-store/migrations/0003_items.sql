-- Parsed feed items, tenant-private like p02.jobs. One parse record per job
-- says whether the fetched body was parsed or refused and why; the items of a
-- job are keyed by (tenant, job, item): the same article fetched by two jobs
-- is two rows until cross-job deduplication lands with scheduling.
--
-- A refusal is recorded here, not in the job result: the job result is the
-- vendored p02-job-v1 contract, which has no parse outcome.

CREATE TABLE p02.feed_parses (
  tenant_id text NOT NULL
    CONSTRAINT feed_parses_tenant_format CHECK (tenant_id ~ '^ten_[a-z0-9]{16,64}$'),
  job_id text NOT NULL,
  status text NOT NULL
    CONSTRAINT feed_parses_status_known CHECK (status IN ('parsed', 'refused')),
  refusal text
    CONSTRAINT feed_parses_refusal_known CHECK (
      refusal IS NULL OR refusal IN ('too_large', 'too_many_items', 'malformed', 'unsupported', 'worker_failed')
    ),
  item_count integer NOT NULL DEFAULT 0
    CONSTRAINT feed_parses_item_count_bounded CHECK (item_count BETWEEN 0 AND 5000),
  parsed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, job_id),
  FOREIGN KEY (tenant_id, job_id) REFERENCES p02.jobs (tenant_id, job_id) ON DELETE CASCADE,
  CONSTRAINT feed_parses_refusal_matches_status CHECK ((status = 'refused') = (refusal IS NOT NULL))
);

CREATE TABLE p02.items (
  tenant_id text NOT NULL,
  job_id text NOT NULL,
  item_id text NOT NULL
    CONSTRAINT items_id_format CHECK (item_id ~ '^[0-9a-f]{64}$'),
  position integer NOT NULL
    CONSTRAINT items_position_bounded CHECK (position BETWEEN 0 AND 4999),
  title text
    CONSTRAINT items_title_bounded CHECK (title IS NULL OR char_length(title) <= 1024),
  link text
    CONSTRAINT items_link_bounded CHECK (link IS NULL OR char_length(link) <= 2048),
  summary_html text
    CONSTRAINT items_summary_bounded CHECK (summary_html IS NULL OR char_length(summary_html) <= 16384),
  published_at timestamptz,
  updated_at timestamptz,
  PRIMARY KEY (tenant_id, job_id, item_id),
  CONSTRAINT items_position_unique UNIQUE (tenant_id, job_id, position),
  FOREIGN KEY (tenant_id, job_id) REFERENCES p02.feed_parses (tenant_id, job_id) ON DELETE CASCADE
);

ALTER TABLE p02.feed_parses ENABLE ROW LEVEL SECURITY;
ALTER TABLE p02.feed_parses FORCE ROW LEVEL SECURITY;
CREATE POLICY feed_parses_tenant_isolation ON p02.feed_parses
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

ALTER TABLE p02.items ENABLE ROW LEVEL SECURITY;
ALTER TABLE p02.items FORCE ROW LEVEL SECURITY;
CREATE POLICY items_tenant_isolation ON p02.items
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

-- The worker writes parse records and items inside the job's tenant context;
-- the API only reads them.
GRANT INSERT, SELECT ON p02.feed_parses TO p02_worker;
GRANT INSERT, SELECT ON p02.items TO p02_worker;
GRANT SELECT ON p02.feed_parses TO p02_api;
GRANT SELECT ON p02.items TO p02_api;

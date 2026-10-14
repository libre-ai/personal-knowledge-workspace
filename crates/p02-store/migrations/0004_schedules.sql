-- Scheduled fetches of a source, tenant-private like p02.jobs. A schedule
-- creates one fetch-source job each time its next_run_at comes due; the job
-- and the advance of next_run_at are written in one transaction, so an
-- interruption cannot leave a job without its advance (or the reverse).

CREATE TABLE p02.schedules (
  tenant_id text NOT NULL
    CONSTRAINT schedules_tenant_format CHECK (tenant_id ~ '^ten_[a-z0-9]{16,64}$'),
  schedule_id text NOT NULL
    CONSTRAINT schedules_id_format CHECK (schedule_id ~ '^[a-z][a-z0-9_-]{2,127}$'),
  url text NOT NULL
    CONSTRAINT schedules_url_bounded CHECK (char_length(url) BETWEEN 1 AND 2048),
  interval_seconds integer NOT NULL
    CONSTRAINT schedules_interval_bounded CHECK (interval_seconds BETWEEN 300 AND 86400),
  next_run_at timestamptz NOT NULL,
  last_job_id text,
  idempotency_key text NOT NULL
    CONSTRAINT schedules_idempotency_format CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, schedule_id),
  CONSTRAINT schedules_idempotency_unique UNIQUE (tenant_id, idempotency_key)
);

ALTER TABLE p02.schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE p02.schedules FORCE ROW LEVEL SECURITY;
CREATE POLICY schedules_tenant_isolation ON p02.schedules
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

GRANT SELECT, INSERT ON p02.schedules TO p02_api;
GRANT SELECT, UPDATE (next_run_at, last_job_id) ON p02.schedules TO p02_worker;

-- The worker must find due schedules across tenants, before it knows a tenant
-- context. This is a read-only, worker-only policy, the same trust the worker
-- already has over every tenant's commands (see job_dispatch). Writes stay under
-- the tenant policy above. A security-definer function was tried and returns
-- nothing: FORCE ROW LEVEL SECURITY applies to the function's owner too.
CREATE POLICY schedules_worker_due ON p02.schedules
  FOR SELECT TO p02_worker
  USING (true);

-- A scheduled job is a normal job, so the worker also inserts jobs and their
-- dispatch rows, inside the tenant context only.
GRANT INSERT ON p02.jobs TO p02_worker;
GRANT INSERT ON p02.job_dispatch TO p02_worker;

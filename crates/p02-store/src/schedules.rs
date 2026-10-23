//! Scheduled fetches: finding the due schedules and turning each into one job.
//!
//! The job and the advance of the schedule's `next_run_at` are written in one
//! tenant-scoped transaction. The job's identity is derived from the schedule
//! and the due instant, so a repeated attempt for the same due instant writes
//! nothing new; a missed interval is not replayed as a burst of jobs.

use serde_json::Value;
use tokio_postgres::Client;

use crate::error::StoreError;
use crate::queue;
use crate::tenant::TenantId;

/// Most schedules listed per call, so one pass cannot monopolise the worker.
pub const DUE_BATCH: i64 = 16;

/// A schedule the database reports as due: identifiers only.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Due {
    pub tenant: TenantId,
    pub schedule_id: String,
}

/// What a scheduled job is built from, read inside the tenant context.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Scheduled {
    pub tenant: String,
    pub job_id: String,
    pub idempotency_key: String,
    pub schedule_id: String,
    pub url: String,
}

/// Schedules whose `next_run_at` has come, as identifiers only.
pub async fn due(client: &mut Client) -> Result<Vec<Due>, StoreError> {
    // The login role does not inherit `p02_worker` (NOINHERIT), so the worker
    // takes the role for this transaction, as every other worker statement does.
    let transaction = client.transaction().await?;
    transaction
        .batch_execute("SET LOCAL ROLE p02_worker")
        .await?;
    // Identifiers only; the URL is read later, inside the tenant context.
    let rows = transaction
        .query(
            "SELECT tenant_id, schedule_id FROM p02.schedules \
             WHERE next_run_at <= now() \
             ORDER BY next_run_at, tenant_id, schedule_id \
             LIMIT $1",
            &[&DUE_BATCH],
        )
        .await?;
    transaction.commit().await?;
    rows.iter()
        .map(|row| {
            let tenant: String = row.get(0);
            Ok(Due {
                tenant: TenantId::parse(&tenant)?,
                schedule_id: row.get(1),
            })
        })
        .collect()
}

/// Enqueue the job of one due schedule, unless it is no longer due (another
/// worker or an earlier attempt already advanced it). `build` returns the
/// p02-job-v1 command for the scheduled fetch. Returns whether a job was
/// enqueued.
pub async fn enqueue_due(
    client: &mut Client,
    due: &Due,
    build: impl Fn(&Scheduled) -> Value,
) -> Result<bool, StoreError> {
    let transaction = queue::tenant_transaction(client, &due.tenant).await?;
    // SKIP LOCKED: a schedule another worker holds is left to that worker.
    let row = transaction
        .query_opt(
            "SELECT url, extract(epoch FROM next_run_at)::bigint \
             FROM p02.schedules \
             WHERE tenant_id = $1 AND schedule_id = $2 AND next_run_at <= now() \
             FOR UPDATE SKIP LOCKED",
            &[&due.tenant.as_str(), &due.schedule_id],
        )
        .await?;
    let Some(row) = row else {
        transaction.commit().await?;
        return Ok(false);
    };
    let url: String = row.get(0);
    let due_epoch: i64 = row.get(1);
    let identity = blake3::Hasher::new()
        .update(due.tenant.as_str().as_bytes())
        .update(b"\n")
        .update(due.schedule_id.as_bytes())
        .update(b"\n")
        .update(due_epoch.to_string().as_bytes())
        .finalize()
        .to_hex();
    let scheduled = Scheduled {
        tenant: due.tenant.as_str().to_owned(),
        job_id: format!("job-{}", &identity[..32]),
        idempotency_key: format!("sched-{}", &identity[..32]),
        schedule_id: due.schedule_id.clone(),
        url,
    };
    let command = build(&scheduled);
    let inserted = transaction
        .execute(
            "INSERT INTO p02.jobs (tenant_id, job_id, idempotency_key, operation, command) \
             VALUES ($1, $2, $3, 'fetch-source', $4) ON CONFLICT DO NOTHING",
            &[
                &due.tenant.as_str(),
                &scheduled.job_id,
                &scheduled.idempotency_key,
                &command,
            ],
        )
        .await?;
    // Advance from the due instant, or from now when the schedule is far
    // behind: a missed interval is not replayed as a burst.
    transaction
        .execute(
            "UPDATE p02.schedules SET \
               next_run_at = CASE \
                 WHEN next_run_at + make_interval(secs => interval_seconds) > now() \
                   THEN next_run_at + make_interval(secs => interval_seconds) \
                 ELSE now() + make_interval(secs => interval_seconds) END, \
               last_job_id = $3 \
             WHERE tenant_id = $1 AND schedule_id = $2 AND next_run_at <= now()",
            &[&due.tenant.as_str(), &due.schedule_id, &scheduled.job_id],
        )
        .await?;
    transaction.commit().await?;
    Ok(inserted == 1)
}

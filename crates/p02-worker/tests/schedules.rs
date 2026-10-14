//! Scheduled fetches: due schedules become jobs once, and the items arrive.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use p02_domain::job::{self, JobDocument};
use p02_fetch::{FetchError, FetchOutcome, FetchRequest, ResponseMeta};
use p02_parse::{ParsedFeed, parse_feed};
use p02_store::testing::{API_LOGIN, TestDatabase, WORKER_LOGIN};
use p02_worker::parse::{Parse, ParseFailure};
use p02_worker::{Fetch, FetchFuture, Processed, WorkerSettings, process_one, run_due};
use url::Url;

const TENANT: &str = "ten_cccccccccccccccc";
const FEED_URL: &str = "https://feeds.example.org/rss.xml";

const RSS: &str = r#"<?xml version="1.0"?>
<rss version="2.0"><channel><title>Example</title><link>https://feeds.example.org/</link>
<description>Example feed</description>
<item><title>Scheduled</title><link>https://feeds.example.org/s</link>
<description>Fetched on schedule</description></item>
</channel></rss>"#;

/// Replies with the feed body for every request.
struct Feed;

impl Fetch for Feed {
    fn fetch<'a>(&'a self, _request: &'a FetchRequest) -> FetchFuture<'a> {
        Box::pin(async move {
            Ok::<_, FetchError>(FetchOutcome::Body {
                meta: ResponseMeta {
                    final_url: Url::parse(FEED_URL).unwrap(),
                    status: 200,
                    redirects: 0,
                    etag: None,
                    last_modified: None,
                    content_type: Some("application/rss+xml".to_owned()),
                    retry_after: None,
                },
                body: RSS.as_bytes().to_vec().into(),
            })
        })
    }
}

/// Parses in this test process; production uses the isolated worker.
struct InProcess;

impl Parse for InProcess {
    fn parse(&self, body: &[u8]) -> Result<ParsedFeed, ParseFailure> {
        parse_feed(body).map_err(ParseFailure::Refused)
    }
}

fn settings() -> WorkerSettings {
    WorkerSettings {
        worker_id: "w-schedule".to_owned(),
        lease: std::time::Duration::from_secs(60),
        max_claims: 3,
        retry_base: std::time::Duration::ZERO,
    }
}

/// A schedule of TENANT whose first run is `first_run` (a SQL interval
/// relative to now, such as `-1 second`), every `interval` seconds.
async fn schedule(database: &TestDatabase, id: &str, first_run: &str, interval: i32) {
    let mut api = database.connect(API_LOGIN).await;
    let transaction = api.transaction().await.unwrap();
    transaction
        .batch_execute("SET LOCAL ROLE p02_api")
        .await
        .unwrap();
    transaction
        .execute("SELECT set_config('app.tenant_id', $1, true)", &[&TENANT])
        .await
        .unwrap();
    transaction
        .execute(
            "INSERT INTO p02.schedules (tenant_id, schedule_id, url, interval_seconds, next_run_at, idempotency_key) \
             VALUES ($1, $2, $3, $4, now() + $5::text::interval, $6)",
            &[&TENANT, &id, &FEED_URL, &interval, &first_run, &format!("key-{id}")],
        )
        .await
        .unwrap();
    transaction.commit().await.unwrap();
}

/// Jobs of TENANT, read as the API role inside the tenant context.
async fn jobs(database: &TestDatabase) -> Vec<(String, serde_json::Value)> {
    let mut api = database.connect(API_LOGIN).await;
    let transaction = api.transaction().await.unwrap();
    transaction
        .batch_execute("SET LOCAL ROLE p02_api")
        .await
        .unwrap();
    transaction
        .execute("SELECT set_config('app.tenant_id', $1, true)", &[&TENANT])
        .await
        .unwrap();
    let rows = transaction
        .query("SELECT job_id, command FROM p02.jobs ORDER BY job_id", &[])
        .await
        .unwrap();
    transaction.commit().await.unwrap();
    rows.iter().map(|row| (row.get(0), row.get(1))).collect()
}

/// Seconds from now until the schedule's next run, read as the API role.
async fn seconds_until_next_run(database: &TestDatabase, id: &str) -> f64 {
    let mut api = database.connect(API_LOGIN).await;
    let transaction = api.transaction().await.unwrap();
    transaction
        .batch_execute("SET LOCAL ROLE p02_api")
        .await
        .unwrap();
    transaction
        .execute("SELECT set_config('app.tenant_id', $1, true)", &[&TENANT])
        .await
        .unwrap();
    let row = transaction
        .query_one(
            "SELECT extract(epoch FROM next_run_at - now())::float8 FROM p02.schedules WHERE schedule_id = $1",
            &[&id],
        )
        .await
        .unwrap();
    transaction.commit().await.unwrap();
    row.get(0)
}

#[tokio::test]
async fn a_due_schedule_enqueues_one_valid_job_and_advances() {
    let database = TestDatabase::start().await;
    schedule(&database, "feed-daily", "-1 second", 300).await;
    let mut worker = database.connect(WORKER_LOGIN).await;

    assert_eq!(run_due(&mut worker).await.unwrap(), 1);
    assert_eq!(run_due(&mut worker).await.unwrap(), 0, "not due any more");

    let found = jobs(&database).await;
    assert_eq!(found.len(), 1);
    let parsed = job::parse_document(&serde_json::to_vec(&found[0].1).unwrap());
    match parsed {
        Ok(JobDocument::Command(command)) => {
            assert_eq!(command.operation.url, FEED_URL);
            assert_eq!(command.tenant_id, TENANT);
        }
        other => panic!("the scheduled command must be a valid p02-job-v1 command: {other:?}"),
    }
    let until = seconds_until_next_run(&database, "feed-daily").await;
    assert!(
        until > 290.0 && until <= 300.0,
        "advanced by one interval: {until}"
    );
}

#[tokio::test]
async fn a_long_outage_yields_one_job_not_a_burst() {
    let database = TestDatabase::start().await;
    schedule(&database, "feed-outage", "-3 hours", 300).await;
    let mut worker = database.connect(WORKER_LOGIN).await;

    assert_eq!(run_due(&mut worker).await.unwrap(), 1);
    assert_eq!(run_due(&mut worker).await.unwrap(), 0);
    assert_eq!(
        jobs(&database).await.len(),
        1,
        "missed intervals are not replayed"
    );
    let until = seconds_until_next_run(&database, "feed-outage").await;
    assert!(
        until > 290.0 && until <= 300.0,
        "next run one interval from now: {until}"
    );
}

#[tokio::test]
async fn a_schedule_not_yet_due_enqueues_nothing() {
    let database = TestDatabase::start().await;
    schedule(&database, "feed-later", "1 hour", 3600).await;
    let mut worker = database.connect(WORKER_LOGIN).await;

    assert_eq!(run_due(&mut worker).await.unwrap(), 0);
    assert!(jobs(&database).await.is_empty());
}

#[tokio::test]
async fn an_interval_outside_the_bounds_is_refused_by_the_database() {
    let database = TestDatabase::start().await;
    let mut api = database.connect(API_LOGIN).await;
    let transaction = api.transaction().await.unwrap();
    transaction
        .batch_execute("SET LOCAL ROLE p02_api")
        .await
        .unwrap();
    transaction
        .execute("SELECT set_config('app.tenant_id', $1, true)", &[&TENANT])
        .await
        .unwrap();
    let too_frequent = transaction
        .execute(
            "INSERT INTO p02.schedules (tenant_id, schedule_id, url, interval_seconds, next_run_at, idempotency_key) \
             VALUES ($1, 'feed-fast', $2, 299, now(), 'key-fast')",
            &[&TENANT, &FEED_URL],
        )
        .await;
    assert!(
        too_frequent.is_err(),
        "an interval under five minutes is refused"
    );
}

#[tokio::test]
async fn a_scheduled_fetch_ends_with_its_items_stored() {
    let database = TestDatabase::start().await;
    schedule(&database, "feed-items", "-1 second", 300).await;
    let mut worker = database.connect(WORKER_LOGIN).await;
    assert_eq!(run_due(&mut worker).await.unwrap(), 1);

    let outcome = process_one(&mut worker, &Feed, &InProcess, &settings())
        .await
        .unwrap();
    assert_eq!(outcome, Processed::Completed);

    let mut api = database.connect(API_LOGIN).await;
    let transaction = api.transaction().await.unwrap();
    transaction
        .batch_execute("SET LOCAL ROLE p02_api")
        .await
        .unwrap();
    transaction
        .execute("SELECT set_config('app.tenant_id', $1, true)", &[&TENANT])
        .await
        .unwrap();
    let items: i64 = transaction
        .query_one("SELECT count(*) FROM p02.items", &[])
        .await
        .unwrap()
        .get(0);
    transaction.commit().await.unwrap();
    assert_eq!(items, 1);
}

/// Runs `sql` as the worker role inside `tenant`, returning the statement's result.
async fn as_worker(
    database: &TestDatabase,
    tenant: &str,
    sql: &str,
) -> Result<u64, tokio_postgres::Error> {
    let mut worker = database.connect(WORKER_LOGIN).await;
    let transaction = worker.transaction().await.unwrap();
    transaction
        .batch_execute("SET LOCAL ROLE p02_worker")
        .await
        .unwrap();
    transaction
        .execute("SELECT set_config('app.tenant_id', $1, true)", &[&tenant])
        .await
        .unwrap();
    let result = transaction.execute(sql, &[]).await;
    transaction.commit().await.ok();
    result
}

// The worker may read every tenant's schedule to find the due ones, but it may
// only change them inside the tenant context, and only the two columns it needs.
#[tokio::test]
async fn the_worker_reads_all_schedules_but_writes_only_its_own_tenant() {
    let database = TestDatabase::start().await;
    schedule(&database, "feed-policy", "-1 second", 300).await;
    let other = "ten_dddddddddddddddd";

    // Visible to the worker across tenants (the due-scan needs this).
    let mut worker = database.connect(WORKER_LOGIN).await;
    let transaction = worker.transaction().await.unwrap();
    transaction
        .batch_execute("SET LOCAL ROLE p02_worker")
        .await
        .unwrap();
    let visible: i64 = transaction
        .query_one("SELECT count(*) FROM p02.schedules", &[])
        .await
        .unwrap()
        .get(0);
    transaction.commit().await.unwrap();
    assert_eq!(visible, 1);

    // A tenant other than the owner cannot change it: no row matches the UPDATE.
    let changed = as_worker(
        &database,
        other,
        "UPDATE p02.schedules SET next_run_at = now() WHERE schedule_id = 'feed-policy'",
    )
    .await
    .unwrap();
    assert_eq!(changed, 0, "another tenant's schedule must not be updated");

    // The worker has no insert, no delete, and no grant on the URL column.
    let inserted = as_worker(
        &database,
        TENANT,
        &format!(
            "INSERT INTO p02.schedules (tenant_id, schedule_id, url, interval_seconds, next_run_at, idempotency_key) \
             VALUES ('{TENANT}', 'feed-forged', 'https://x.example.org/', 300, now(), 'forged')"
        ),
    )
    .await;
    assert!(inserted.is_err(), "the worker must not create schedules");

    let deleted = as_worker(&database, TENANT, "DELETE FROM p02.schedules").await;
    assert!(deleted.is_err(), "the worker must not delete schedules");

    let url = as_worker(
        &database,
        TENANT,
        "UPDATE p02.schedules SET url = 'https://x.example.org/' WHERE schedule_id = 'feed-policy'",
    )
    .await;
    assert!(url.is_err(), "the worker must not rewrite a schedule's URL");
}

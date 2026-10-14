//! Parsed items stored by the worker, against a throwaway P02 database.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use std::time::Duration;

use p02_fetch::{FetchError, FetchOutcome, FetchRequest, ResponseMeta};
use p02_parse::{ParsedFeed, parse_feed};
use p02_store::testing::{API_LOGIN, BOOTSTRAP, TestDatabase, WORKER_LOGIN};
use p02_worker::parse::{Parse, ParseFailure};
use p02_worker::{Fetch, FetchFuture, Processed, WorkerSettings, process_one};
use serde_json::json;
use url::Url;

const TENANT: &str = "ten_bbbbbbbbbbbbbbbb";
const SOURCE: &str = "https://feeds.example.org/rss.xml";

const RSS: &str = r#"<?xml version="1.0"?>
<rss version="2.0"><channel><title>Example</title><link>https://feeds.example.org/</link>
<description>Example feed</description>
<item><title>First</title><link>https://feeds.example.org/a</link>
<description>Lead &lt;script&gt;alert(1)&lt;/script&gt;text</description>
<pubDate>Thu, 01 Oct 2026 08:00:00 GMT</pubDate></item>
<item><title>Second</title><link>https://feeds.example.org/b</link>
<description>Second summary</description></item>
</channel></rss>"#;

/// Replies with the same body for every request.
struct Always(Vec<u8>);

impl Fetch for Always {
    fn fetch<'a>(&'a self, _request: &'a FetchRequest) -> FetchFuture<'a> {
        let body = self.0.clone();
        Box::pin(async move {
            Ok::<_, FetchError>(FetchOutcome::Body {
                meta: ResponseMeta {
                    final_url: Url::parse(SOURCE).unwrap(),
                    status: 200,
                    redirects: 0,
                    etag: None,
                    last_modified: None,
                    content_type: Some("application/rss+xml".to_owned()),
                    retry_after: None,
                },
                body: body.into(),
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
        worker_id: "w-items".to_owned(),
        lease: Duration::from_secs(60),
        max_claims: 3,
        retry_base: Duration::ZERO,
    }
}

async fn enqueue(database: &TestDatabase, job: &str, url: &str, body_kind: &str) {
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
    let command = json!({
        "schemaVersion": "libre-ai.p02-job.v1",
        "kind": "command",
        "jobId": job,
        "tenantId": TENANT,
        "idempotencyKey": format!("key-{job}"),
        "enqueuedAt": "2026-10-14T08:00:00Z",
        "operation": {"type": "fetch-source", "sourceId": "src-example", "url": url, "bodyKind": body_kind}
    });
    transaction
        .execute(
            "INSERT INTO p02.jobs (tenant_id, job_id, idempotency_key, operation, command) VALUES ($1, $2, $3, 'fetch-source', $4)",
            &[&TENANT, &job, &format!("key-{job}"), &command],
        )
        .await
        .unwrap();
    transaction.commit().await.unwrap();
}

/// Run one job to completion with the given body.
async fn run(database: &TestDatabase, body: &[u8]) {
    let mut worker = database.connect(WORKER_LOGIN).await;
    let fetcher = Always(body.to_vec());
    assert_eq!(
        process_one(&mut worker, &fetcher, &InProcess, &settings())
            .await
            .unwrap(),
        Processed::Completed
    );
}

/// Read as the API role, inside the tenant, the rows of one job.
async fn read(database: &TestDatabase, sql: &str, job: &str) -> Vec<tokio_postgres::Row> {
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
    let rows = transaction.query(sql, &[&job]).await.unwrap();
    transaction.commit().await.unwrap();
    rows
}

async fn job_state(database: &TestDatabase, job: &str) -> String {
    read(
        database,
        "SELECT state FROM p02.jobs WHERE job_id = $1",
        job,
    )
    .await[0]
        .get(0)
}

async fn item_ids(database: &TestDatabase, job: &str) -> Vec<String> {
    read(
        database,
        "SELECT item_id FROM p02.items WHERE job_id = $1 ORDER BY position",
        job,
    )
    .await
    .iter()
    .map(|row| row.get(0))
    .collect()
}

#[tokio::test]
async fn a_parsed_feed_stores_its_items_and_a_parse_record() {
    let database = TestDatabase::start().await;
    enqueue(&database, "job-feed", SOURCE, "feed").await;
    run(&database, RSS.as_bytes()).await;

    assert_eq!(job_state(&database, "job-feed").await, "succeeded");
    let parse = read(
        &database,
        "SELECT status, refusal, item_count FROM p02.feed_parses WHERE job_id = $1",
        "job-feed",
    )
    .await;
    assert_eq!(parse.len(), 1);
    assert_eq!(parse[0].get::<_, String>(0), "parsed");
    assert_eq!(parse[0].get::<_, Option<String>>(1), None);
    assert_eq!(parse[0].get::<_, i32>(2), 2);

    let items = read(
        &database,
        "SELECT position, title, link, summary_html FROM p02.items WHERE job_id = $1 ORDER BY position",
        "job-feed",
    )
    .await;
    assert_eq!(items.len(), 2);
    assert_eq!(
        items[0].get::<_, Option<String>>(1).as_deref(),
        Some("First")
    );
    assert_eq!(
        items[0].get::<_, Option<String>>(2).as_deref(),
        Some("https://feeds.example.org/a")
    );
    let summary = items[0].get::<_, Option<String>>(3).unwrap();
    assert!(
        !summary.contains("<script"),
        "the stored summary is sanitised: {summary}"
    );
}

#[tokio::test]
async fn the_same_feed_fetched_by_two_jobs_yields_the_same_item_identities() {
    let database = TestDatabase::start().await;
    enqueue(&database, "job-first", SOURCE, "feed").await;
    enqueue(&database, "job-second", SOURCE, "feed").await;
    run(&database, RSS.as_bytes()).await;
    run(&database, RSS.as_bytes()).await;

    let first = item_ids(&database, "job-first").await;
    let second = item_ids(&database, "job-second").await;
    assert_eq!(first.len(), 2);
    assert_eq!(first, second);
}

#[tokio::test]
async fn a_malformed_body_is_recorded_as_a_refused_parse_with_no_items() {
    let database = TestDatabase::start().await;
    enqueue(&database, "job-bad", SOURCE, "feed").await;
    run(&database, b"this is not a feed").await;

    // The fetch succeeded; the parse is what was refused.
    assert_eq!(job_state(&database, "job-bad").await, "succeeded");
    let parse = read(
        &database,
        "SELECT status, refusal, item_count FROM p02.feed_parses WHERE job_id = $1",
        "job-bad",
    )
    .await;
    assert_eq!(parse[0].get::<_, String>(0), "refused");
    assert_eq!(
        parse[0].get::<_, Option<String>>(1).as_deref(),
        Some("malformed")
    );
    assert_eq!(parse[0].get::<_, i32>(2), 0);
    assert!(item_ids(&database, "job-bad").await.is_empty());
}

#[tokio::test]
async fn a_page_body_is_not_parsed() {
    let database = TestDatabase::start().await;
    enqueue(&database, "job-page", SOURCE, "page").await;
    run(&database, RSS.as_bytes()).await;

    assert_eq!(job_state(&database, "job-page").await, "succeeded");
    let parse = read(
        &database,
        "SELECT job_id FROM p02.feed_parses WHERE job_id = $1",
        "job-page",
    )
    .await;
    assert!(parse.is_empty(), "a page body carries no parse record");
}

/// A failed write of the parse record rolls the whole completion back: the job
/// stays unfinished and no item survives, so a retry cannot double them.
#[tokio::test]
async fn a_failed_parse_record_leaves_no_items_and_no_finished_job() {
    let database = TestDatabase::start().await;
    enqueue(&database, "job-atomic", SOURCE, "feed").await;
    // A parse record already present makes the worker's insert fail.
    let bootstrap = database.connect(BOOTSTRAP).await;
    bootstrap
        .execute(
            "INSERT INTO p02.feed_parses (tenant_id, job_id, status, refusal, item_count) VALUES ($1, 'job-atomic', 'parsed', NULL, 0)",
            &[&TENANT],
        )
        .await
        .unwrap();

    let mut worker = database.connect(WORKER_LOGIN).await;
    let fetcher = Always(RSS.as_bytes().to_vec());
    let outcome = process_one(&mut worker, &fetcher, &InProcess, &settings()).await;
    assert!(
        outcome.is_err(),
        "the duplicate parse record must fail the write"
    );

    assert_ne!(job_state(&database, "job-atomic").await, "succeeded");
    assert!(item_ids(&database, "job-atomic").await.is_empty());
}

//! Parsed feed items, written in the same transaction as the job that produced
//! them: a job is never `succeeded` with a parse record missing, and a parse
//! record never outlives a job that did not finish.

use serde_json::Value;
use tokio_postgres::Client;

use crate::error::StoreError;
use crate::queue::{self, Claim, Terminal};

/// Most items one job may store. Matches the parser's ceiling; the column
/// check in the migration enforces the same bound.
pub const MAX_ITEMS_PER_JOB: usize = 5_000;

/// Why a fetched body yielded no items. Stable codes, stored in
/// `p02.feed_parses.refusal`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    TooLarge,
    TooManyItems,
    Malformed,
    Unsupported,
    WorkerFailed,
}

impl Refusal {
    pub const fn code(self) -> &'static str {
        match self {
            Self::TooLarge => "too_large",
            Self::TooManyItems => "too_many_items",
            Self::Malformed => "malformed",
            Self::Unsupported => "unsupported",
            Self::WorkerFailed => "worker_failed",
        }
    }
}

/// One stored item. Timestamps are RFC 3339 text, cast by the database.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ItemRow {
    pub item_id: String,
    pub position: i32,
    pub title: Option<String>,
    pub link: Option<String>,
    pub summary_html: Option<String>,
    pub published_at: Option<String>,
    pub updated_at: Option<String>,
}

/// What the parse step produced for a job.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParseRecord {
    Parsed(Vec<ItemRow>),
    Refused(Refusal),
}

/// Record the parse outcome and its items, then the terminal state, in one
/// tenant-scoped transaction.
pub async fn complete_with_parse(
    client: &mut Client,
    claim: &Claim,
    state: Terminal,
    result: &Value,
    record: &ParseRecord,
) -> Result<(), StoreError> {
    let transaction = queue::tenant_transaction(client, &claim.tenant).await?;
    let (status, refusal, items): (&str, Option<&str>, &[ItemRow]) = match record {
        ParseRecord::Parsed(items) => {
            if items.len() > MAX_ITEMS_PER_JOB {
                return Err(StoreError::TooManyItems);
            }
            ("parsed", None, items.as_slice())
        }
        ParseRecord::Refused(refusal) => ("refused", Some(refusal.code()), &[]),
    };
    let item_count = i32::try_from(items.len()).map_err(|_| StoreError::TooManyItems)?;
    transaction
        .execute(
            "INSERT INTO p02.feed_parses (tenant_id, job_id, status, refusal, item_count) \
             VALUES ($1, $2, $3, $4, $5)",
            &[
                &claim.tenant.as_str(),
                &claim.job_id,
                &status,
                &refusal,
                &item_count,
            ],
        )
        .await?;
    for item in items {
        transaction
            .execute(
                "INSERT INTO p02.items \
                 (tenant_id, job_id, item_id, position, title, link, summary_html, published_at, updated_at) \
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8::text::timestamptz, $9::text::timestamptz)",
                &[
                    &claim.tenant.as_str(),
                    &claim.job_id,
                    &item.item_id,
                    &item.position,
                    &item.title,
                    &item.link,
                    &item.summary_html,
                    &item.published_at,
                    &item.updated_at,
                ],
            )
            .await?;
    }
    queue::complete_in(&transaction, claim, state, result).await?;
    transaction.commit().await?;
    Ok(())
}

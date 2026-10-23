//! P02 feed parsing (PRD 12 §3.8 E2, AT-01, AT-38, G1, G6).
//!
//! [`parse_feed`] turns the bytes of an RSS 2.0, Atom 1.0 or JSON Feed body
//! into typed items. It never panics, never resolves a name, never fetches,
//! and it refuses rather than guesses:
//!
//! - a body over [`FEED_BYTES_CEILING`] or a feed over [`MAX_ITEMS`] is refused
//!   whole, never truncated silently;
//! - a publication date that is missing or malformed is `None`, which is the
//!   "absent" marking of G1, never an invented date;
//! - every title and summary is cleaned by [`sanitize`] before it is returned.
//!
//! Known limit, carried to S2.3: when an item carries neither a GUID nor a
//! link, the feed library generates its identifier (a hash of the link or a
//! random UUID). The identifier of such an item is therefore not stable across
//! parses, and identity must be derived by the canonicalisation step, not
//! taken from [`ParsedItem::id`] alone.

pub mod isolation;
mod sanitize;
mod xml_encoding;

use std::io;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// Largest feed body accepted, in bytes (PRD G5, feed ceiling).
pub const FEED_BYTES_CEILING: usize = 5 * 1024 * 1024;

/// Largest number of items accepted from one feed. A larger feed is refused.
pub const MAX_ITEMS: usize = 5_000;

/// One parsed item. Text fields are plain text; `summary_html` is an
/// allowlisted HTML fragment or escaped text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ParsedItem {
    /// Identifier as the feed library reports it. See the module note.
    pub id: String,
    pub title: Option<String>,
    /// The first link, kept only when it is an absolute `http` or `https` URL.
    pub link: Option<String>,
    pub summary_html: Option<String>,
    /// Publication date as declared; `None` when absent or malformed.
    pub published: Option<DateTime<Utc>>,
    pub updated: Option<DateTime<Utc>>,
}

/// A parsed feed: its items in document order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ParsedFeed {
    pub items: Vec<ParsedItem>,
}

/// Why a body was refused. Carries no content, so it can be logged (G8).
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error, Serialize, Deserialize)]
pub enum ParseRefusal {
    #[error("the feed body is over the size ceiling")]
    TooLarge,
    #[error("the feed holds more items than the ceiling")]
    TooManyItems,
    #[error("the feed is malformed")]
    Malformed,
    #[error("the feed format or version is not supported")]
    Unsupported,
}

/// Parse one feed body.
pub fn parse_feed(body: &[u8]) -> Result<ParsedFeed, ParseRefusal> {
    if body.len() > FEED_BYTES_CEILING {
        return Err(ParseRefusal::TooLarge);
    }
    // Before feed-rs: its XML reader panics on an encoding switch (see the module).
    if !xml_encoding::is_supported(body) {
        return Err(ParseRefusal::Unsupported);
    }
    let feed = feed_rs::parser::parse(io::Cursor::new(body)).map_err(refusal_of)?;
    if feed.entries.len() > MAX_ITEMS {
        return Err(ParseRefusal::TooManyItems);
    }
    let items = feed.entries.into_iter().map(item_of).collect();
    Ok(ParsedFeed { items })
}

fn refusal_of(error: feed_rs::parser::ParseFeedError) -> ParseRefusal {
    match error {
        feed_rs::parser::ParseFeedError::JsonUnsupportedVersion(_) => ParseRefusal::Unsupported,
        _ => ParseRefusal::Malformed,
    }
}

fn item_of(entry: feed_rs::model::Entry) -> ParsedItem {
    let title = entry
        .title
        .map(|text| sanitize::plain_text(&text.content, is_html(&text.content_type)));
    let summary_html = entry
        .summary
        .map(|text| sanitize::html_fragment(&text.content, is_html(&text.content_type)));
    let link = entry
        .links
        .into_iter()
        .map(|link| link.href)
        .find(|href| is_web_url(href));
    ParsedItem {
        id: entry.id,
        title,
        link,
        summary_html,
        published: entry.published,
        updated: entry.updated,
    }
}

fn is_html(content_type: &mediatype::MediaTypeBuf) -> bool {
    content_type
        .essence()
        .to_string()
        .eq_ignore_ascii_case("text/html")
}

fn is_web_url(href: &str) -> bool {
    let lowered = href.to_ascii_lowercase();
    (lowered.starts_with("http://") || lowered.starts_with("https://"))
        && !href.contains(char::is_whitespace)
}

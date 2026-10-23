//! Stable item identity.
//!
//! The feed library's own identifier is not stable across parses (its module
//! note in `p02-parse`), so it is never stored as identity. An item's id is a
//! digest of the source URL and the item's most stable available field: its
//! link, else its title and publication time, else the library identifier as
//! a last resort. The source URL is part of the digest, so the same article
//! in two different sources is two items.

use std::collections::HashSet;

use p02_parse::ParsedItem;
use p02_store::items::ItemRow;

/// Stored items for one parsed feed, in feed order. Items whose identity
/// repeats an earlier item of the same feed are dropped, keeping the first.
pub fn item_rows(source_url: &str, items: &[ParsedItem]) -> Vec<ItemRow> {
    let mut seen = HashSet::new();
    let mut rows = Vec::with_capacity(items.len());
    for item in items {
        let item_id = item_id(source_url, item);
        if !seen.insert(item_id.clone()) {
            continue;
        }
        let Ok(position) = i32::try_from(rows.len()) else {
            break;
        };
        rows.push(ItemRow {
            item_id,
            position,
            title: item.title.clone(),
            link: item.link.clone(),
            summary_html: item.summary_html.clone(),
            published_at: item.published.map(|at| at.to_rfc3339()),
            updated_at: item.updated.map(|at| at.to_rfc3339()),
        });
    }
    rows
}

/// The identity of one item of one source: 64 lowercase hex characters.
pub fn item_id(source_url: &str, item: &ParsedItem) -> String {
    let key = match (&item.link, &item.title, &item.published) {
        (Some(link), _, _) => format!("link\n{link}"),
        (None, None, None) => format!("feed-id\n{}", item.id),
        (None, title, published) => format!(
            "title\n{}\n{}",
            title.as_deref().unwrap_or(""),
            published.map(|at| at.to_rfc3339()).unwrap_or_default()
        ),
    };
    let mut hasher = blake3::Hasher::new();
    hasher.update(source_url.as_bytes());
    hasher.update(b"\n");
    hasher.update(key.as_bytes());
    hasher.finalize().to_hex().to_string()
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]
mod tests {
    use chrono::{TimeZone, Utc};

    use super::*;

    const SOURCE: &str = "https://feeds.example.org/atom.xml";

    fn item(id: &str, title: Option<&str>, link: Option<&str>) -> ParsedItem {
        ParsedItem {
            id: id.to_owned(),
            title: title.map(str::to_owned),
            link: link.map(str::to_owned),
            summary_html: None,
            published: Some(Utc.with_ymd_and_hms(2026, 10, 1, 8, 0, 0).unwrap()),
            updated: None,
        }
    }

    #[test]
    fn the_link_is_the_identity_when_present() {
        let before = item("tag:a-1", Some("First"), Some("https://example.org/a"));
        // The library identifier and the title change; the link does not.
        let after = item(
            "tag:b-9",
            Some("First, edited"),
            Some("https://example.org/a"),
        );
        assert_eq!(item_id(SOURCE, &before), item_id(SOURCE, &after));
    }

    #[test]
    fn a_different_link_is_a_different_item() {
        let first = item("x", Some("T"), Some("https://example.org/a"));
        let second = item("x", Some("T"), Some("https://example.org/b"));
        assert_ne!(item_id(SOURCE, &first), item_id(SOURCE, &second));
    }

    #[test]
    fn the_same_article_in_another_source_is_another_item() {
        let article = item("x", Some("T"), Some("https://example.org/a"));
        assert_ne!(
            item_id(SOURCE, &article),
            item_id("https://other.example.org/feed", &article)
        );
    }

    #[test]
    fn an_item_without_link_is_identified_by_title_and_time() {
        let article = item("tag:z", Some("No link"), None);
        let same = item("tag:other", Some("No link"), None);
        assert_eq!(item_id(SOURCE, &article), item_id(SOURCE, &same));
    }

    #[test]
    fn ids_are_64_lowercase_hex_characters() {
        let id = item_id(SOURCE, &item("x", Some("T"), Some("https://example.org/a")));
        assert_eq!(id.len(), 64);
        assert!(
            id.bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        );
    }

    #[test]
    fn a_repeated_identity_is_stored_once_and_positions_are_dense() {
        let feed = [
            item("x", Some("A"), Some("https://example.org/a")),
            item("y", Some("A again"), Some("https://example.org/a")),
            item("z", Some("B"), Some("https://example.org/b")),
        ];
        let rows = item_rows(SOURCE, &feed);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].position, 0);
        assert_eq!(rows[1].position, 1);
        assert_eq!(rows[0].title.as_deref(), Some("A"));
    }
}

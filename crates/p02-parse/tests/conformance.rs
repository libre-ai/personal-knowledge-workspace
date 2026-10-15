//! Conformance of the feed parser on synthetic fixtures (AT-01 subset) and on
//! hostile inputs (AT-38 subset). The fixtures are synthetic: no real feed,
//! no personal data (PRD 12 §3.6, NFR-13).
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use p02_parse::{FEED_BYTES_CEILING, MAX_ITEMS, ParseRefusal, parse_feed};

fn fixture(name: &str) -> Vec<u8> {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(name);
    std::fs::read(&path).unwrap_or_else(|error| panic!("fixture {name}: {error}"))
}

#[test]
fn rss_2_0_items_are_parsed_cleaned_and_their_links_kept_only_when_web() {
    let feed = parse_feed(&fixture("rss2-valid.xml")).unwrap();

    assert_eq!(feed.items.len(), 2);
    let first = &feed.items[0];
    assert_eq!(first.title.as_deref(), Some("First & foremost"));
    assert_eq!(
        first.link.as_deref(),
        Some("https://feeds.example.org/posts/1")
    );
    assert!(first.published.is_some(), "RFC 822 pubDate is read");
    let summary = first.summary_html.as_deref().unwrap();
    assert!(summary.contains("Summary"));
    assert!(!summary.contains("script"), "{summary}");
    assert!(!summary.contains("onclick"), "{summary}");

    let second = &feed.items[1];
    assert_eq!(second.link, None, "a javascript: link is never kept");
    // Known limit, pinned here so it cannot change unnoticed: RSS descriptions
    // are HTML by convention, so the escaped `<text>` becomes an unknown tag
    // that the sanitiser removes together with the text after it. The output is
    // safe (no markup) but the trailing words are lost. Raw `<` in plain-text
    // summaries needs a per-format rule, tracked for E2.3.
    let summary = second.summary_html.as_deref().unwrap();
    assert_eq!(summary, "Plain ");
    assert!(!summary.contains('<'), "{summary}");
}

#[test]
fn atom_1_0_entry_fields_are_read_and_html_title_is_plain_text() {
    let feed = parse_feed(&fixture("atom1-valid.xml")).unwrap();

    let entry = &feed.items[0];
    assert_eq!(entry.id, "urn:example:entry:1");
    assert_eq!(entry.title.as_deref(), Some("Emphasis title"));
    assert_eq!(
        entry.link.as_deref(),
        Some("https://feeds.example.org/entries/1")
    );
    assert!(entry.published.is_some());
    assert!(entry.updated.is_some());
    let summary = entry.summary_html.as_deref().unwrap();
    assert!(summary.contains("Atom summary"));
    assert!(!summary.contains("onerror"), "{summary}");
}

#[test]
fn json_feed_1_1_items_are_parsed() {
    let feed = parse_feed(&fixture("json-feed-valid.json")).unwrap();

    assert_eq!(feed.items.len(), 1);
    let item = &feed.items[0];
    assert_eq!(item.title.as_deref(), Some("JSON item"));
    assert_eq!(
        item.link.as_deref(),
        Some("https://feeds.example.org/json/1")
    );
    assert!(item.published.is_some());
}

#[test]
fn a_malformed_date_is_absent_not_invented_and_the_item_is_kept() {
    let feed = parse_feed(&fixture("rss2-bad-date.xml")).unwrap();

    assert_eq!(feed.items.len(), 1);
    assert_eq!(feed.items[0].published, None, "G1: absent, never invented");
    assert_eq!(feed.items[0].title.as_deref(), Some("Undated item"));
}

#[test]
fn an_external_entity_is_never_resolved() {
    // A refusal is acceptable; a returned item carrying file content is not.
    match parse_feed(&fixture("xxe-external-entity.xml")) {
        Err(_) => {}
        Ok(feed) => {
            for item in &feed.items {
                let text = format!("{:?} {:?}", item.title, item.summary_html);
                assert!(
                    !text.contains("root:"),
                    "external entity was resolved: {text}"
                );
            }
        }
    }
}

#[test]
fn a_truncated_document_is_refused_as_malformed_without_panic() {
    assert_eq!(
        parse_feed(b"<rss version=\"2.0\"><channel><title>cut"),
        Err(ParseRefusal::Malformed)
    );
}

#[test]
fn binary_noise_is_refused_without_panic() {
    let noise: Vec<u8> = (0_u8..=255).cycle().take(4096).collect();
    assert!(parse_feed(&noise).is_err());
}

#[test]
fn a_body_over_the_size_ceiling_is_refused_before_parsing() {
    let body = vec![b' '; FEED_BYTES_CEILING + 1];
    assert_eq!(parse_feed(&body), Err(ParseRefusal::TooLarge));
}

#[test]
fn a_feed_over_the_item_ceiling_is_refused_whole() {
    let mut body =
        String::from("<?xml version=\"1.0\"?><rss version=\"2.0\"><channel><title>t</title>");
    for index in 0..=MAX_ITEMS {
        body.push_str(&format!("<item><title>{index}</title></item>"));
    }
    body.push_str("</channel></rss>");

    assert_eq!(parse_feed(body.as_bytes()), Err(ParseRefusal::TooManyItems));
}

#[test]
fn an_unsupported_json_feed_version_is_refused_as_unsupported() {
    let body = br#"{"version":"https://jsonfeed.org/version/9","title":"x","items":[]}"#;
    assert_eq!(parse_feed(body), Err(ParseRefusal::Unsupported));
}

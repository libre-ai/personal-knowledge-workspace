//! Text and HTML handling of feed content. Every string a feed carries is
//! untrusted (PRD 12 G6, G9): it is cleaned before it is stored, and what
//! reaches the store is either plain text or an allowlisted HTML fragment.

use std::collections::HashSet;

use ammonia::Builder;

/// Plain text of a title or any short field: markup removed, the script and
/// style bodies dropped with their tags, the five basic entities decoded so
/// that the stored text reads as written. The result is text, never markup,
/// and must be rendered as text by every consumer.
pub(crate) fn plain_text(content: &str, is_html: bool) -> String {
    if !is_html {
        return content.trim().to_owned();
    }
    let cleaned = Builder::new()
        .tags(HashSet::new())
        .clean(content)
        .to_string();
    decode_basic_entities(cleaned.trim())
}

/// An HTML fragment safe to store: the ammonia default allowlist, which keeps
/// no script, no event handler and no `javascript:` URL. Plain text is escaped
/// so that it cannot be read as markup later.
pub(crate) fn html_fragment(content: &str, is_html: bool) -> String {
    if is_html {
        ammonia::clean(content)
    } else {
        escape_text(content)
    }
}

fn escape_text(content: &str) -> String {
    let mut escaped = String::with_capacity(content.len());
    for character in content.chars() {
        match character {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            '"' => escaped.push_str("&quot;"),
            '\'' => escaped.push_str("&#39;"),
            other => escaped.push(other),
        }
    }
    escaped
}

/// Decode the five entities ammonia escapes. `&amp;` is decoded last so that
/// `&amp;lt;` becomes `&lt;` and not `<`.
fn decode_basic_entities(text: &str) -> String {
    text.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&amp;", "&")
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::{html_fragment, plain_text};

    #[test]
    fn title_markup_is_removed_and_entities_read_as_written() {
        assert_eq!(plain_text("<b>Hello</b> &amp; bye", true), "Hello & bye");
    }

    #[test]
    fn script_bodies_are_dropped_with_their_tags() {
        assert_eq!(plain_text("safe<script>alert(1)</script>", true), "safe");
    }

    #[test]
    fn double_encoded_entities_are_not_decoded_twice() {
        assert_eq!(plain_text("&amp;lt;b&amp;gt;", true), "&lt;b&gt;");
    }

    #[test]
    fn plain_text_is_kept_as_text_and_trimmed() {
        assert_eq!(plain_text("  a <b> c  ", false), "a <b> c");
    }

    #[test]
    fn summary_html_drops_scripts_and_event_handlers() {
        let cleaned = html_fragment(
            r#"<p onclick="x()">kept</p><script>bad()</script><a href="javascript:bad()">l</a>"#,
            true,
        );
        assert!(cleaned.contains("kept"));
        assert!(!cleaned.contains("script"));
        assert!(!cleaned.contains("onclick"));
        assert!(!cleaned.contains("javascript:"));
    }

    #[test]
    fn plain_summary_is_escaped_not_read_as_markup() {
        assert_eq!(html_fragment("<img src=x>", false), "&lt;img src=x&gt;");
    }
}

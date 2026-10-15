//! Refusal of XML bodies whose encoding would switch the decoder mid-stream.
//!
//! quick-xml 0.42 (a dependency of feed-rs, with its `encoding` feature that
//! feed-rs requires) panics in `set_encoding` when an XML declaration changes
//! the decoder after its prefix buffer is drained. Found by fuzzing
//! `parse_feed`: a second `<?xml … encoding="utf-16"?>` after a first
//! declaration. A panic aborts the process here (`panic = "abort"`), so the
//! parser must refuse these bodies before feed-rs sees them.
//!
//! The rule is conservative: every XML declaration must name UTF-8 (or name no
//! encoding), and a UTF-16 or UTF-32 byte-order mark is refused. Declarations
//! that name UTF-8 later in the body are a no-op in quick-xml and are allowed.

/// How far into a declaration the encoding attribute is looked for. A real
/// declaration is far shorter; a longer one is refused as unreadable.
const DECLARATION_WINDOW: usize = 512;

/// Byte-order marks of encodings other than UTF-8: UTF-16 LE and BE, and
/// UTF-32 BE. UTF-32 LE (`FF FE 00 00`) starts with the UTF-16 LE mark.
const REFUSED_MARKS: [&[u8]; 3] = [&[0xFF, 0xFE], &[0xFE, 0xFF], &[0x00, 0x00, 0xFE, 0xFF]];

/// Whether every XML declaration in `body` names UTF-8, or names no encoding,
/// and no UTF-16 or UTF-32 mark starts the body. JSON bodies carry no XML
/// declaration and pass.
pub fn is_supported(body: &[u8]) -> bool {
    if REFUSED_MARKS.iter().any(|mark| body.starts_with(mark)) {
        return false;
    }
    let mut rest = body;
    while let Some(start) = find(rest, b"<?xml") {
        let after = rest.get(start + 5..).unwrap_or_default();
        let window = after
            .get(..DECLARATION_WINDOW.min(after.len()))
            .unwrap_or_default();
        let declaration = match find(window, b"?>") {
            Some(end) => window.get(..end).unwrap_or_default(),
            None => window,
        };
        if let Some(value) = encoding_value(declaration) {
            if !value.eq_ignore_ascii_case(b"utf-8") {
                return false;
            }
        } else if find(declaration, b"encoding").is_some() {
            // The attribute is there but not a quoted value we can read.
            return false;
        }
        rest = after;
    }
    true
}

/// The quoted value of an `encoding` pseudo-attribute, if the declaration has one.
fn encoding_value(declaration: &[u8]) -> Option<&[u8]> {
    let at = find(declaration, b"encoding")?;
    let mut tail = declaration.get(at + "encoding".len()..)?;
    tail = skip_spaces(tail);
    tail = tail.strip_prefix(b"=")?;
    tail = skip_spaces(tail);
    let quote = *tail.first()?;
    if quote != b'"' && quote != b'\'' {
        return None;
    }
    let inner = tail.get(1..)?;
    let close = inner.iter().position(|&byte| byte == quote)?;
    inner.get(..close)
}

fn skip_spaces(bytes: &[u8]) -> &[u8] {
    let spaces = bytes
        .iter()
        .take_while(|byte| byte.is_ascii_whitespace())
        .count();
    bytes.get(spaces..).unwrap_or_default()
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    #[test]
    fn a_utf8_declaration_or_none_is_supported() {
        assert!(is_supported(
            br#"<?xml version="1.0" encoding="UTF-8"?><rss/>"#
        ));
        assert!(is_supported(
            br#"<?xml version="1.0" encoding='utf-8'?><rss/>"#
        ));
        assert!(is_supported(b"<?xml version=\"1.0\"?><rss/>"));
        assert!(is_supported(
            b"{\"version\":\"https://jsonfeed.org/version/1.1\"}"
        ));
    }

    #[test]
    fn a_utf16_declaration_is_refused() {
        assert!(!is_supported(
            br#"<?xml version="1.0" encoding="utf-16"?><rss/>"#
        ));
    }

    #[test]
    fn a_later_switch_is_refused_as_in_the_fuzzing_crash() {
        // First declaration garbled, second one switching to UTF-16.
        let body = b"<?xml version=\"1.0\" encoding=\"utf-\0{8\"?>\n<feed/>\n<?xml version=\"1.0\" encoding=\"utf-16\"?>";
        assert!(!is_supported(body));
    }

    #[test]
    fn a_repeated_utf8_declaration_is_allowed() {
        let body = br#"<?xml version="1.0" encoding="utf-8"?><feed/><?xml version="1.0" encoding="UTF-8"?>"#;
        assert!(is_supported(body));
    }

    #[test]
    fn a_utf16_or_utf32_byte_order_mark_is_refused() {
        assert!(!is_supported(&[0xFF, 0xFE, b'<', 0]));
        assert!(!is_supported(&[0xFE, 0xFF, 0, b'<']));
        assert!(!is_supported(&[0, 0, 0xFE, 0xFF, 0, 0, 0, b'<']));
    }

    #[test]
    fn an_unreadable_encoding_attribute_is_refused() {
        assert!(!is_supported(
            br#"<?xml version="1.0" encoding=utf-8?><rss/>"#
        ));
        assert!(!is_supported(
            br#"<?xml version="1.0" encoding="utf-8><rss/>"#
        ));
    }
}

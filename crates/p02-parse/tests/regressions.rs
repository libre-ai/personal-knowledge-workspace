//! Inputs that once crashed the parser, kept so that they cannot return.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use p02_parse::{ParseRefusal, parse_feed};

/// Found by fuzzing `parse_feed` (libFuzzer, 2026-10-14): a second XML
/// declaration naming UTF-16 made quick-xml 0.42 panic in `set_encoding`,
/// which aborts the process under `panic = "abort"`.
#[test]
fn a_utf16_switch_inside_xml_is_refused_and_does_not_panic() {
    let body = include_bytes!("fixtures/fuzz-quick-xml-encoding-switch.bin");
    assert_eq!(parse_feed(body).err(), Some(ParseRefusal::Unsupported));
}

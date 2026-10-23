// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2

//! CA-39, third clause: `render_preview` returns an attribute tree and never
//! interpreted HTML. The tree carries ranges and attributes, no document text.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use libre_ai_notebook_vault::{
    MAX_PREVIEW_DEPTH, MAX_PREVIEW_NODES, NodeKind, PreviewNode, VaultError, render_preview,
};
use serde_json::{Value, json};

fn preview(text: &str) -> PreviewNode {
    render_preview(text.as_bytes()).unwrap()
}

fn json_of(text: &str) -> Value {
    serde_json::to_value(preview(text)).unwrap()
}

fn depth(node: &PreviewNode) -> usize {
    1 + node.children.iter().map(depth).max().unwrap_or(0)
}

fn kinds(node: &PreviewNode, found: &mut Vec<NodeKind>) {
    found.push(node.kind);
    for child in &node.children {
        kinds(child, found);
    }
}

#[test]
fn a_small_document_becomes_ranges_and_attributes() {
    // `😀` is two UTF-16 units: the offsets below count code units, the unit of the editor.
    let document = "# Title\n\n😀 **bold** and [[note-00001|alias]]\n\n- [x] done\n- [ ] todo\n";
    let tree = json_of(document);
    let expected = json!({
        "kind": "document", "from": 0, "to": 69,
        "children": [
            { "kind": "heading", "from": 0, "to": 8, "level": 1, "children": [] },
            { "kind": "paragraph", "from": 9, "to": 46, "children": [
                { "kind": "strong", "from": 12, "to": 20, "children": [] },
                { "kind": "wiki_link", "from": 25, "to": 45, "target": "note-00001", "children": [] }
            ] },
            { "kind": "list", "from": 47, "to": 69, "ordered": false, "children": [
                { "kind": "list_item", "from": 47, "to": 58, "checked": true, "children": [] },
                { "kind": "list_item", "from": 58, "to": 69, "checked": false, "children": [] }
            ] }
        ]
    });
    assert_eq!(tree, expected);
}

#[test]
fn offsets_are_utf16_units_of_the_input_text_for_every_trap() {
    // Each document ends with a heading; the heading range must index that exact text.
    for (name, prefix) in [
        ("crlf", "line\r\n\r\n"),
        ("lone-cr", "line\r\r"),
        ("bom", "\u{feff}"),
        ("nfd", "cafe\u{301} e\u{301}te\u{301}\n\n"),
        ("non-bmp", "\u{1F600}\u{10348}\u{1D11E}\n\n"),
        ("tabs", "\ttext\n\n"),
    ] {
        let document = format!("{prefix}# Head\n");
        let tree = preview(&document);
        let heading = tree
            .children
            .iter()
            .find(|c| c.kind == NodeKind::Heading)
            .unwrap();
        let units: Vec<u16> = document.encode_utf16().collect();
        let slice = String::from_utf16(&units[heading.from as usize..heading.to as usize]).unwrap();
        assert_eq!(slice.trim_end(), "# Head", "{name}");
    }
}

#[test]
fn raw_html_is_a_range_never_markup() {
    let hostile = [
        "<script>alert(1)</script>\n",
        "<img src=x onerror=alert(1)>\n",
        "text <b>bold</b> <iframe src=//evil></iframe> text\n",
        "<!-- comment --> <style>*{}</style>\n",
        "a < b > c <3\n",
        "```\n<script>alert(1)</script>\n```\n",
        "    <script>alert(1)</script>\n",
        "[<img src=x onerror=alert(1)>](https://ok.example/p \"<b>title</b>\")\n",
        "![<svg onload=alert(1)>](https://ok.example/i.png)\n",
        "[[<img src=x>]]\n",
        "```<script>\ncode\n```\n",
        "<https://ok.example/auto>\n",
        "&lt;script&gt; &#60;b&#62;\n",
    ];
    let mut checked = 0;
    for document in hostile {
        let serialized = serde_json::to_string(&preview(document)).unwrap();
        assert!(
            !serialized.contains('<'),
            "tag in {document:?}: {serialized}"
        );
        assert!(
            !serialized.contains('>'),
            "tag in {document:?}: {serialized}"
        );
        for fragment in [
            "alert", "onerror", "onload", "script", "iframe", "style", "title",
        ] {
            assert!(
                !serialized.contains(fragment),
                "{fragment} echoed for {document:?}: {serialized}"
            );
        }
        checked += 1;
    }
    println!(
        "hostile notes rendered without a tag or an echoed fragment: {checked} of {}",
        hostile.len()
    );

    let mut found = Vec::new();
    kinds(&preview("<script>alert(1)</script>\n"), &mut found);
    assert!(found.contains(&NodeKind::Html), "{found:?}");
}

#[test]
fn the_tree_never_carries_document_text() {
    let tree =
        json_of("A paragraph with SENTINELTEXT and `inline SENTINELCODE`.\n\n## SENTINELHEAD\n");
    let serialized = tree.to_string();
    assert!(!serialized.contains("SENTINEL"), "{serialized}");
}

#[test]
fn link_destinations_are_a_whitelist() {
    let link = |destination: &str| -> Value {
        let tree = json_of(&format!("[x]({destination})\n"));
        tree["children"][0]["children"][0].clone()
    };
    for ok in [
        "https://ok.example/p?q=1",
        "http://ok.example",
        "mailto:a@ok.example",
        "relative/path.md",
        "/root/relative.md",
        "#anchor",
    ] {
        let node = link(ok);
        assert_eq!(node["kind"], "link", "{ok}");
        assert_eq!(node["url"], ok, "{ok}");
        assert!(node.get("blocked").is_none(), "{ok}");
    }
    for blocked in [
        "javascript:alert(1)",
        "JaVaScRiPt:alert(1)",
        "java&#x73;cript:alert(1)",
        "java&Tab;script:alert(1)",
        "data:text/html;base64,PHNjcmlwdD4=",
        "vbscript:x",
        "file:///etc/passwd",
        "tauri://localhost/",
        "ipc://x",
        "%6Aavascript:alert(1)",
        // A protocol-relative reference names a host and inherits the scheme of the page.
        "//evil.example/x",
        "//evil.example",
    ] {
        let node = link(blocked);
        assert_eq!(node["kind"], "link", "{blocked}");
        assert_eq!(node["blocked"], true, "{blocked}");
        assert!(node.get("url").is_none(), "{blocked}: {node}");
    }
}

#[test]
fn a_code_fence_language_is_kept_only_when_it_is_plain() {
    let fence = |info: &str| -> Value {
        let tree = json_of(&format!("```{info}\ncode\n```\n"));
        tree["children"][0].clone()
    };
    assert_eq!(fence("rust")["language"], "rust");
    assert_eq!(fence("c++ extra words")["language"], "c++");
    assert!(fence("<script>").get("language").is_none());
    assert!(fence("a\"b").get("language").is_none());
    assert!(fence(&"x".repeat(33)).get("language").is_none());
    assert_eq!(fence("rust")["kind"], "code_block");
}

#[test]
fn frontmatter_tables_strikethrough_and_rules_have_a_kind() {
    let mut found = Vec::new();
    kinds(
        &preview(
            "---\ntitle: x\n---\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n~~gone~~\n\n---\n\n> quote\n\n1. one\n",
        ),
        &mut found,
    );
    for wanted in [
        NodeKind::Frontmatter,
        NodeKind::Table,
        NodeKind::TableRow,
        NodeKind::TableCell,
        NodeKind::Strikethrough,
        NodeKind::Rule,
        NodeKind::BlockQuote,
        NodeKind::List,
    ] {
        assert!(found.contains(&wanted), "{wanted:?} missing from {found:?}");
    }
}

#[test]
fn nesting_is_bounded_so_that_serialization_cannot_overflow() {
    for hostile in [
        format!("{}x\n", "> ".repeat(10_000)),
        format!("{}x\n", "- ".repeat(10_000)),
        format!("{}x{}\n", "*a ".repeat(5_000), "*".repeat(5_000)),
    ] {
        let tree = render_preview(hostile.as_bytes()).unwrap();
        assert!(depth(&tree) <= MAX_PREVIEW_DEPTH, "depth {}", depth(&tree));
        serde_json::to_string(&tree).unwrap();
    }
}

#[test]
fn a_preview_with_too_many_nodes_is_refused() {
    let within = "*a* ".repeat(1_000);
    assert!(render_preview(within.as_bytes()).is_ok());
    let beyond = "*a* ".repeat(MAX_PREVIEW_NODES + 1);
    assert_eq!(
        render_preview(beyond.as_bytes()).map(|_| ()),
        Err(VaultError::TooLarge)
    );
}

#[test]
fn input_that_is_not_utf8_or_too_large_is_refused() {
    assert_eq!(
        render_preview(&[0xFF, 0xFE, b'#']).map(|_| ()),
        Err(VaultError::NotUtf8)
    );
    let too_large = vec![b'a'; libre_ai_notebook_vault::MAX_NOTE_BYTES + 1];
    assert_eq!(
        render_preview(&too_large).map(|_| ()),
        Err(VaultError::TooLarge)
    );
    // The empty note is a document with no child.
    assert!(render_preview(b"").unwrap().children.is_empty());
}

#[test]
fn rendering_leaves_the_input_untouched_and_is_deterministic() {
    let document = "# Same\n\n*input* [[twice]]\n".as_bytes().to_vec();
    let copy = document.clone();
    let first = serde_json::to_string(&render_preview(&document).unwrap()).unwrap();
    let second = serde_json::to_string(&render_preview(&document).unwrap()).unwrap();
    assert_eq!(first, second);
    assert_eq!(document, copy);
}

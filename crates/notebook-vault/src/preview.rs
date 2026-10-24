// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2

//! The live preview as an attribute tree (ADR-0044 decision 3, kept by
//! ADR-0057 section 2). The tree holds ranges of the document and attributes
//! (a heading level, a link target, a task state): it holds none of the
//! document's text and no markup, so the front applies it as decorations over
//! text it already has and there is no HTML to interpret, sanitise or escape.
//! Raw HTML in a note is a `html` range, never rendered.
//!
//! Every string that does reach the tree (a link destination, a wiki target, a
//! code-fence language) passed a whitelist; a value that fails it is left out
//! and the node says `blocked`.

use pulldown_cmark::{CodeBlockKind, Event, HeadingLevel, LinkType, Options, Parser, Tag};
use serde::Serialize;

use crate::error::VaultError;
use crate::vault::MAX_NOTE_BYTES;

/// Deepest nesting of the tree, the root included. A deeper element is left
/// out of the tree, so serialising it cannot exhaust the stack.
pub const MAX_PREVIEW_DEPTH: usize = 64;
/// Most nodes of a tree. A note that needs more is refused (`vault.too_large`),
/// not truncated: a partial preview is a wrong preview.
pub const MAX_PREVIEW_NODES: usize = 250_000;
const MAX_ATTRIBUTE_BYTES: usize = 1024;
const MAX_LANGUAGE_BYTES: usize = 32;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NodeKind {
    Document,
    Paragraph,
    Heading,
    BlockQuote,
    CodeBlock,
    List,
    ListItem,
    Emphasis,
    Strong,
    Strikethrough,
    /// Inline code.
    Code,
    Link,
    WikiLink,
    Image,
    Rule,
    /// Raw HTML, block or inline: a range, nothing else.
    Html,
    Frontmatter,
    Table,
    TableHead,
    TableRow,
    TableCell,
    Other,
}

/// A range of the document with its attributes. `from` and `to` are UTF-16
/// code-unit offsets into the text exactly as the front holds it (a leading
/// U+FEFF counts as one unit), the unit of CodeMirror positions.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PreviewNode {
    pub kind: NodeKind,
    pub from: u32,
    pub to: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub level: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ordered: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checked: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    /// The destination of a link or image failed the whitelist and was dropped.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blocked: Option<bool>,
    pub children: Vec<PreviewNode>,
}

impl PreviewNode {
    fn new(kind: NodeKind, from: u32, to: u32) -> Self {
        Self {
            kind,
            from,
            to,
            level: None,
            language: None,
            ordered: None,
            start: None,
            checked: None,
            url: None,
            target: None,
            blocked: None,
            children: Vec::new(),
        }
    }
}

/// Byte offsets of the parsed text to UTF-16 offsets of the input text.
struct OffsetMap {
    units: Vec<u32>,
}

impl OffsetMap {
    fn new(body: &str, leading_units: u32) -> Self {
        let mut units = vec![0u32; body.len() + 1];
        let mut position = leading_units;
        for (index, character) in body.char_indices() {
            if let Some(slot) = units.get_mut(index) {
                *slot = position;
            }
            position = position.saturating_add(character.len_utf16() as u32);
        }
        if let Some(slot) = units.get_mut(body.len()) {
            *slot = position;
        }
        Self { units }
    }

    fn at(&self, byte: usize) -> u32 {
        self.units
            .get(byte)
            .or(self.units.last())
            .copied()
            .unwrap_or(0)
    }
}

fn has_forbidden_character(value: &str) -> bool {
    value
        .chars()
        .any(|c| c.is_control() || matches!(c, '<' | '>' | '"' | '`' | '\\'))
}

/// A link or image destination: no markup character, no whitespace, and when it
/// names a scheme (anything before the first `:` that precedes `/`, `?` or `#`)
/// that scheme is `http`, `https` or `mailto`. A relative reference and an
/// anchor have no scheme and pass; a protocol-relative one (`//host/path`) has
/// none either but names a host and takes the scheme of the page, so it does not.
fn safe_url(raw: &str) -> Option<String> {
    if raw.len() > MAX_ATTRIBUTE_BYTES
        || has_forbidden_character(raw)
        || raw.chars().any(char::is_whitespace)
        || raw.starts_with("//")
    {
        return None;
    }
    if let Some(end) = raw.find([':', '/', '?', '#'])
        && raw.get(end..=end) == Some(":")
    {
        let scheme = raw.get(..end)?.to_ascii_lowercase();
        if !matches!(scheme.as_str(), "http" | "https" | "mailto") {
            return None;
        }
    }
    Some(raw.to_owned())
}

/// The target of a wiki link is a note name: spaces are allowed, markup is not.
fn safe_target(raw: &str) -> Option<String> {
    (raw.len() <= MAX_ATTRIBUTE_BYTES && !has_forbidden_character(raw)).then(|| raw.to_owned())
}

/// The first word of a fence's info string, when it looks like a language name.
fn safe_language(info: &str) -> Option<String> {
    let word = info.split_whitespace().next()?;
    let plain = word.len() <= MAX_LANGUAGE_BYTES
        && word
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '+' | '#' | '.' | '-'));
    plain.then(|| word.to_owned())
}

fn open_node(tag: &Tag<'_>, from: u32, to: u32) -> PreviewNode {
    let node = |kind| PreviewNode::new(kind, from, to);
    match tag {
        Tag::Paragraph => node(NodeKind::Paragraph),
        Tag::Heading { level, .. } => {
            let mut heading = node(NodeKind::Heading);
            heading.level = Some(match level {
                HeadingLevel::H1 => 1,
                HeadingLevel::H2 => 2,
                HeadingLevel::H3 => 3,
                HeadingLevel::H4 => 4,
                HeadingLevel::H5 => 5,
                HeadingLevel::H6 => 6,
            });
            heading
        }
        Tag::BlockQuote(_) => node(NodeKind::BlockQuote),
        Tag::CodeBlock(kind) => {
            let mut block = node(NodeKind::CodeBlock);
            if let CodeBlockKind::Fenced(info) = kind {
                block.language = safe_language(info);
            }
            block
        }
        Tag::HtmlBlock => node(NodeKind::Html),
        Tag::List(first) => {
            let mut list = node(NodeKind::List);
            list.ordered = Some(first.is_some());
            list.start = first.and_then(|n| u32::try_from(n).ok());
            list
        }
        Tag::Item => node(NodeKind::ListItem),
        Tag::Emphasis => node(NodeKind::Emphasis),
        Tag::Strong => node(NodeKind::Strong),
        Tag::Strikethrough => node(NodeKind::Strikethrough),
        Tag::Link {
            link_type: LinkType::WikiLink { .. },
            dest_url,
            ..
        } => {
            let mut link = node(NodeKind::WikiLink);
            link.target = safe_target(dest_url);
            link.blocked = link.target.is_none().then_some(true);
            link
        }
        Tag::Link { dest_url, .. } => destination(node(NodeKind::Link), dest_url),
        Tag::Image { dest_url, .. } => destination(node(NodeKind::Image), dest_url),
        Tag::MetadataBlock(_) => node(NodeKind::Frontmatter),
        Tag::Table(_) => node(NodeKind::Table),
        Tag::TableHead => node(NodeKind::TableHead),
        Tag::TableRow => node(NodeKind::TableRow),
        Tag::TableCell => node(NodeKind::TableCell),
        _ => node(NodeKind::Other),
    }
}

fn destination(mut node: PreviewNode, raw: &str) -> PreviewNode {
    if !raw.is_empty() {
        node.url = safe_url(raw);
        node.blocked = node.url.is_none().then_some(true);
    }
    node
}

struct Builder {
    /// Open nodes, the document at the bottom.
    stack: Vec<PreviewNode>,
    /// Open elements left out for depth; their end events are matched here.
    hidden: usize,
    nodes: usize,
}

impl Builder {
    fn can_add(&self) -> bool {
        self.hidden == 0 && self.stack.len() < MAX_PREVIEW_DEPTH
    }

    fn count(&mut self) -> Result<(), VaultError> {
        self.nodes += 1;
        if self.nodes > MAX_PREVIEW_NODES {
            Err(VaultError::TooLarge)
        } else {
            Ok(())
        }
    }

    fn open(&mut self, node: PreviewNode) -> Result<(), VaultError> {
        if self.can_add() {
            self.count()?;
            self.stack.push(node);
        } else {
            self.hidden += 1;
        }
        Ok(())
    }

    fn close(&mut self) {
        if self.hidden > 0 {
            self.hidden -= 1;
        } else if self.stack.len() > 1
            && let Some(node) = self.stack.pop()
            && let Some(parent) = self.stack.last_mut()
        {
            parent.children.push(node);
        }
    }

    fn leaf(&mut self, node: PreviewNode) -> Result<(), VaultError> {
        if self.can_add() {
            self.count()?;
            if let Some(parent) = self.stack.last_mut() {
                parent.children.push(node);
            }
        }
        Ok(())
    }
}

/// Renders the Markdown `bytes` of a note as an attribute tree. The input must
/// be UTF-8 and at most [`MAX_NOTE_BYTES`]; the result has at most
/// [`MAX_PREVIEW_NODES`] nodes and [`MAX_PREVIEW_DEPTH`] levels.
pub fn render_preview(bytes: &[u8]) -> Result<PreviewNode, VaultError> {
    if bytes.len() > MAX_NOTE_BYTES {
        return Err(VaultError::TooLarge);
    }
    let text = std::str::from_utf8(bytes).map_err(|_| VaultError::NotUtf8)?;
    // A BOM is not content: CommonMark would read it as text and the first
    // heading of a note saved with one would stop being a heading. It still
    // counts as one UTF-16 unit of the input.
    let (body, leading_units) = match text.strip_prefix('\u{feff}') {
        Some(rest) => (rest, 1),
        None => (text, 0),
    };
    let map = OffsetMap::new(body, leading_units);

    // Smart punctuation stays off: the parser never rewrites what the person typed.
    let options = Options::ENABLE_TABLES
        | Options::ENABLE_STRIKETHROUGH
        | Options::ENABLE_TASKLISTS
        | Options::ENABLE_WIKILINKS
        | Options::ENABLE_YAML_STYLE_METADATA_BLOCKS;
    let end = map.at(body.len());
    let mut builder = Builder {
        stack: vec![PreviewNode::new(NodeKind::Document, 0, end)],
        hidden: 0,
        nodes: 1,
    };
    for (event, range) in Parser::new_ext(body, options).into_offset_iter() {
        let (from, to) = (map.at(range.start), map.at(range.end));
        match event {
            Event::Start(tag) => builder.open(open_node(&tag, from, to))?,
            Event::End(_) => builder.close(),
            Event::Code(_) => builder.leaf(PreviewNode::new(NodeKind::Code, from, to))?,
            Event::Html(_) | Event::InlineHtml(_) => {
                builder.leaf(PreviewNode::new(NodeKind::Html, from, to))?;
            }
            Event::Rule => builder.leaf(PreviewNode::new(NodeKind::Rule, from, to))?,
            Event::TaskListMarker(done) => {
                if builder.hidden == 0
                    && let Some(item) = builder.stack.last_mut()
                    && item.kind == NodeKind::ListItem
                {
                    item.checked = Some(done);
                }
            }
            _ => {}
        }
    }
    // Every element is closed by now; the document is the bottom of the stack.
    builder
        .stack
        .into_iter()
        .next()
        .ok_or(VaultError::Io(std::io::ErrorKind::Other))
}

//! The parse step of a fetched feed body.
//!
//! Production parses only through [`IsolatedParser`], which runs the
//! `p02-parse-worker` binary under the kernel limits of `p02-parse` (G6). The
//! worker never parses in its own process.

use std::path::PathBuf;

use p02_parse::isolation::{self, IsolationError};
use p02_parse::{ParseRefusal, ParsedFeed};

/// Why a body produced no feed. Carries no content, so it can be logged (G8).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ParseFailure {
    /// The parser judged the body refused.
    Refused(ParseRefusal),
    /// The parser could not run to an answer: spawn failure, timeout, crash,
    /// missing kernel limits, or a protocol violation.
    WorkerFailed,
}

/// Turns a fetched body into typed items.
pub trait Parse: Send + Sync {
    fn parse(&self, body: &[u8]) -> Result<ParsedFeed, ParseFailure>;
}

/// Parses in the `p02-parse-worker` child process.
pub struct IsolatedParser {
    worker: PathBuf,
}

impl IsolatedParser {
    pub fn new(worker: PathBuf) -> Self {
        Self { worker }
    }
}

impl Parse for IsolatedParser {
    fn parse(&self, body: &[u8]) -> Result<ParsedFeed, ParseFailure> {
        isolation::parse_isolated(&self.worker, body).map_err(|error| match error {
            IsolationError::Refused(refusal) => ParseFailure::Refused(refusal),
            _ => ParseFailure::WorkerFailed,
        })
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_parser_binary_is_a_worker_failure_not_a_refusal() {
        let parser = IsolatedParser::new(PathBuf::from("/nonexistent/p02-parse-worker"));
        assert_eq!(
            parser.parse(b"<rss/>").err(),
            Some(ParseFailure::WorkerFailed)
        );
    }

    #[test]
    fn an_oversized_body_is_refused_before_any_process_starts() {
        // The size check runs in the parent, so a missing binary cannot mask it.
        let parser = IsolatedParser::new(PathBuf::from("/nonexistent/p02-parse-worker"));
        let oversized = vec![b'a'; p02_parse::FEED_BYTES_CEILING + 1];
        assert_eq!(
            parser.parse(&oversized).err(),
            Some(ParseFailure::Refused(ParseRefusal::TooLarge))
        );
    }
}

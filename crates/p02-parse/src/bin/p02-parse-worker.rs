//! The isolated feed parser (PRD 12 S2.1). It applies its resource limits,
//! reads one feed body from stdin, and writes one typed JSON answer to stdout.
//! It opens no network connection and reads no file other than stdin.

use std::io::{self, Read};
use std::process::ExitCode;

use p02_parse::FEED_BYTES_CEILING;
use p02_parse::isolation::{
    Answer, EXIT_LIMITS_UNAVAILABLE, answer_for, apply_worker_limits, write_answer,
};

fn main() -> ExitCode {
    // Limits first: the body read below is bounded, but the parse that follows
    // must already run under the kernel ceilings.
    if apply_worker_limits().is_err() {
        return ExitCode::from(EXIT_LIMITS_UNAVAILABLE);
    }

    let mut body = Vec::new();
    // One byte past the ceiling tells an oversized body apart from a short one.
    let read = io::stdin()
        .take(FEED_BYTES_CEILING as u64 + 1)
        .read_to_end(&mut body);
    let answer = match read {
        Ok(_) if body.len() > FEED_BYTES_CEILING => Answer::Refused {
            refusal: p02_parse::ParseRefusal::TooLarge,
        },
        Ok(_) => answer_for(&body),
        Err(_) => Answer::Refused {
            refusal: p02_parse::ParseRefusal::Malformed,
        },
    };

    match write_answer(&answer, io::stdout().lock()) {
        Ok(()) => ExitCode::SUCCESS,
        Err(_) => ExitCode::FAILURE,
    }
}

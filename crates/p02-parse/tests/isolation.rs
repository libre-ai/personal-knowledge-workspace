//! The isolated parser: the worker process, its limits, and the parent's
//! budget, output ceiling and failure mapping (PRD 12 S2.1, G6).
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use std::path::Path;
use std::time::Duration;

use p02_parse::ParseRefusal;
use p02_parse::isolation::{IsolationError, parse_isolated, parse_isolated_within};

const WORKER: &str = env!("CARGO_BIN_EXE_p02-parse-worker");

fn fixture(name: &str) -> Vec<u8> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(name);
    std::fs::read(&path).unwrap_or_else(|error| panic!("fixture {name}: {error}"))
}

#[cfg(target_os = "linux")]
#[test]
fn a_valid_feed_is_parsed_by_the_worker_under_its_limits() {
    let feed = parse_isolated(Path::new(WORKER), &fixture("rss2-valid.xml")).unwrap();

    assert_eq!(feed.items.len(), 2);
    assert_eq!(feed.items[0].title.as_deref(), Some("First & foremost"));
}

// Without enforced limits the worker must refuse rather than parse unbounded.
#[cfg(not(target_os = "linux"))]
#[test]
fn off_linux_the_worker_refuses_because_its_limits_cannot_be_enforced() {
    assert_eq!(
        parse_isolated(Path::new(WORKER), &fixture("rss2-valid.xml")),
        Err(IsolationError::LimitsUnavailable)
    );
}

#[test]
fn a_hostile_feed_is_refused_by_the_worker_with_its_typed_reason() {
    let outcome = parse_isolated(Path::new(WORKER), b"<rss version=\"2.0\"><channel>");

    if cfg!(target_os = "linux") {
        assert_eq!(
            outcome,
            Err(IsolationError::Refused(ParseRefusal::Malformed))
        );
    } else {
        assert_eq!(outcome, Err(IsolationError::LimitsUnavailable));
    }
}

#[test]
fn a_worker_that_exits_non_zero_is_a_crash_not_a_protocol_error() {
    // `false` ignores its input and exits 1 with no output.
    assert_eq!(
        parse_isolated(Path::new("/usr/bin/false"), b"x"),
        Err(IsolationError::Crashed)
    );
}

#[test]
fn a_worker_that_answers_outside_the_protocol_is_refused() {
    // `cat` echoes the body back, which is not a typed answer.
    assert_eq!(
        parse_isolated(Path::new("/bin/cat"), b"not json"),
        Err(IsolationError::Protocol)
    );
}

#[test]
fn an_output_flood_past_the_ceiling_is_a_protocol_error() {
    // `yes` writes forever. The parent stops reading at the ceiling, `yes`
    // receives SIGPIPE and exits, and the oversized output is refused.
    assert_eq!(
        parse_isolated_within(Path::new("/usr/bin/yes"), b"x", Duration::from_secs(10)),
        Err(IsolationError::Protocol)
    );
}

#[cfg(unix)]
#[test]
fn a_silent_worker_past_its_budget_is_killed_and_reported_as_timeout() {
    use std::os::unix::fs::PermissionsExt;

    // `exec` replaces the shell, so the budget kills the sleeping process
    // itself and no orphan keeps the output pipe open.
    let script = std::env::temp_dir().join(format!("p02-silent-worker-{}", std::process::id()));
    std::fs::write(&script, "#!/bin/sh\nexec sleep 30\n").unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();

    let started = std::time::Instant::now();
    let outcome = parse_isolated_within(&script, b"x", Duration::from_millis(300));
    let elapsed = started.elapsed();
    let _ = std::fs::remove_file(&script);

    assert_eq!(outcome, Err(IsolationError::Timeout));
    assert!(
        elapsed < Duration::from_secs(5),
        "the worker was not stopped promptly: {elapsed:?}"
    );
}

#[test]
fn a_missing_worker_is_a_spawn_error() {
    assert_eq!(
        parse_isolated(Path::new("/nonexistent/p02-parse-worker"), b"x"),
        Err(IsolationError::Spawn)
    );
}

#[test]
fn a_body_over_the_ceiling_is_refused_before_any_process_starts() {
    let body = vec![b' '; p02_parse::FEED_BYTES_CEILING + 1];
    assert_eq!(
        parse_isolated(Path::new("/nonexistent/never-started"), &body),
        Err(IsolationError::Refused(ParseRefusal::TooLarge))
    );
}

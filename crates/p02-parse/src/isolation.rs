//! Isolated feed parsing (PRD 12 S2.1, G6). The feed body is parsed by a child
//! process, `p02-parse-worker`, which applies resource limits before it reads
//! the body. The parent accepts only the typed answer the child writes back,
//! within a wall-clock budget and an output ceiling, and kills the child when
//! either is exceeded.
//!
//! Limits are enforced by the kernel on Linux only (`setrlimit`). On any other
//! platform the worker refuses to parse and the parent reports
//! [`IsolationError::LimitsUnavailable`]: an unenforced limit is never
//! presented as enforced. Production is meant to run on Linux: this is a
//! recommendation of the 2026-10-14 review, not yet an owner decision.

use std::io::{self, Read, Write};
use std::path::Path;
use std::process::{Command, ExitStatus, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::{FEED_BYTES_CEILING, ParseRefusal, ParsedFeed, ParsedItem};

/// Address-space ceiling of the worker (PRD 12 NFR-08, 256 MiB).
pub const WORKER_ADDRESS_SPACE_BYTES: u64 = 256 * 1024 * 1024;

/// CPU-time ceiling of the worker, in seconds (PRD 12 G6, 2 s per document).
pub const WORKER_CPU_SECONDS: u64 = 2;

/// Wall-clock budget of one parse, the guard against a worker that blocks.
pub const WORKER_WALL_TIMEOUT: Duration = Duration::from_secs(10);

/// Largest answer the parent reads from the worker, in bytes. An answer holds
/// at most `MAX_ITEMS` items, each bounded by the sanitiser, so this is a
/// generous ceiling that still stops a runaway writer.
pub const WORKER_OUTPUT_CEILING: usize = 32 * 1024 * 1024;

/// Exit status of a worker that could not apply its limits.
pub const EXIT_LIMITS_UNAVAILABLE: u8 = 3;

/// The typed answer of the worker. Its JSON form is the only protocol.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum Answer {
    Ok { items: Vec<ParsedItem> },
    Refused { refusal: ParseRefusal },
}

/// Why an isolated parse produced no feed. Carries no content (G8).
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum IsolationError {
    #[error("the parser worker could not be started")]
    Spawn,
    #[error("the parser worker exceeded its time budget and was stopped")]
    Timeout,
    #[error("the parser worker ended abnormally")]
    Crashed,
    #[error("resource limits cannot be enforced on this platform")]
    LimitsUnavailable,
    #[error("the parser worker answered outside the protocol")]
    Protocol,
    #[error("the feed was refused: {0}")]
    Refused(ParseRefusal),
}

/// Apply the worker's resource limits to the current process.
#[cfg(target_os = "linux")]
pub fn apply_worker_limits() -> Result<(), IsolationError> {
    use rustix::process::{Resource, Rlimit, setrlimit};

    let address_space = Rlimit {
        current: Some(WORKER_ADDRESS_SPACE_BYTES),
        maximum: Some(WORKER_ADDRESS_SPACE_BYTES),
    };
    let cpu = Rlimit {
        current: Some(WORKER_CPU_SECONDS),
        maximum: Some(WORKER_CPU_SECONDS),
    };
    setrlimit(Resource::As, address_space).map_err(|_| IsolationError::LimitsUnavailable)?;
    setrlimit(Resource::Cpu, cpu).map_err(|_| IsolationError::LimitsUnavailable)
}

/// Apply the worker's resource limits to the current process.
#[cfg(not(target_os = "linux"))]
pub fn apply_worker_limits() -> Result<(), IsolationError> {
    Err(IsolationError::LimitsUnavailable)
}

/// Parse one body in a worker process with the default budget.
pub fn parse_isolated(worker: &Path, body: &[u8]) -> Result<ParsedFeed, IsolationError> {
    parse_isolated_within(worker, body, WORKER_WALL_TIMEOUT)
}

/// Parse one body in a worker process within `budget` of wall-clock time.
pub fn parse_isolated_within(
    worker: &Path,
    body: &[u8],
    budget: Duration,
) -> Result<ParsedFeed, IsolationError> {
    if body.len() > FEED_BYTES_CEILING {
        return Err(IsolationError::Refused(ParseRefusal::TooLarge));
    }
    let mut child = Command::new(worker)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| IsolationError::Spawn)?;

    // Writing and reading run on their own threads so that a worker which
    // fills one pipe while the parent writes the other cannot deadlock.
    let stdin = child.stdin.take().ok_or(IsolationError::Spawn)?;
    let stdout = child.stdout.take().ok_or(IsolationError::Spawn)?;
    let input = body.to_vec();
    let writer = thread::spawn(move || {
        let mut stdin = stdin;
        // A worker that exits early closes its end: the write fails, which is
        // reported through the exit status, not here.
        let _ = stdin.write_all(&input);
    });
    let reader = thread::spawn(move || {
        let mut output = Vec::new();
        let _ = stdout
            .take(WORKER_OUTPUT_CEILING as u64 + 1)
            .read_to_end(&mut output);
        output
    });

    let status = wait_or_kill(&mut child, budget)?;
    let _ = writer.join();
    let output = reader.join().map_err(|_| IsolationError::Protocol)?;

    if output.len() > WORKER_OUTPUT_CEILING {
        return Err(IsolationError::Protocol);
    }
    if status.code() == Some(i32::from(EXIT_LIMITS_UNAVAILABLE)) {
        return Err(IsolationError::LimitsUnavailable);
    }
    if !status.success() {
        return Err(IsolationError::Crashed);
    }
    match serde_json::from_slice::<Answer>(&output).map_err(|_| IsolationError::Protocol)? {
        Answer::Ok { items } => Ok(ParsedFeed { items }),
        Answer::Refused { refusal } => Err(IsolationError::Refused(refusal)),
    }
}

/// Wait for the child until `budget` elapses; kill it and report
/// [`IsolationError::Timeout`] if it has not finished by then.
fn wait_or_kill(
    child: &mut std::process::Child,
    budget: Duration,
) -> Result<ExitStatus, IsolationError> {
    let deadline = Instant::now() + budget;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Ok(status),
            Ok(None) => {}
            Err(_) => return Err(IsolationError::Crashed),
        }
        if Instant::now() >= deadline {
            // The child may already have exited between the check and the
            // kill; either way it is reaped before we return.
            let _ = child.kill();
            let _ = child.wait();
            return Err(IsolationError::Timeout);
        }
        thread::sleep(Duration::from_millis(5));
    }
}

/// Produce the worker's answer for one body. The worker binary calls this
/// after applying its limits; tests call it directly to check the mapping.
pub fn answer_for(body: &[u8]) -> Answer {
    match crate::parse_feed(body) {
        Ok(feed) => Answer::Ok { items: feed.items },
        Err(refusal) => Answer::Refused { refusal },
    }
}

/// Write one answer as its JSON protocol form.
pub fn write_answer(answer: &Answer, mut out: impl Write) -> io::Result<()> {
    serde_json::to_writer(&mut out, answer).map_err(io::Error::other)?;
    out.flush()
}

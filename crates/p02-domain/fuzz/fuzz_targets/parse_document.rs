#![no_main]

// Every byte string must decode to a document or to a typed contract error.
// Panics or hangs here would reach the worker's claim path, so they are bugs.

use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    let _ = p02_domain::job::parse_document(data);
});

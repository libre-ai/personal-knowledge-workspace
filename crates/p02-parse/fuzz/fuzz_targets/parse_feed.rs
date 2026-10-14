#![no_main]

// The parser must answer every byte string with a feed or a typed refusal.
// A panic, an abort or an unbounded loop here is a bug: the isolated worker
// would turn it into a `worker_failed` refusal, but the parser must not rely on
// that containment for correctness.

use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    let _ = p02_parse::parse_feed(data);
});

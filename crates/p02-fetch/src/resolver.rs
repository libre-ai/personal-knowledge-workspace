//! DNS resolution, performed once per hop by the fetcher itself.
//!
//! The fetcher never hands a host name to a library that could resolve it
//! again: it asks a [`Resolver`] once, validates the whole answer with the
//! destination policy, and dials the validated addresses. This closes the
//! validate-then-resolve-again window of the historical `feed-radar` fetcher
//! (DNS rebinding, PRD 12 risk R1).

use std::future::Future;
use std::io;
use std::net::IpAddr;
use std::pin::Pin;

/// Most addresses kept from one answer. A larger answer is truncated after
/// validation of every address it carried.
pub const MAX_ADDRESSES_PER_ANSWER: usize = 16;

/// Future returned by [`Resolver::resolve`].
pub type ResolveFuture<'a> = Pin<Box<dyn Future<Output = io::Result<Vec<IpAddr>>> + Send + 'a>>;

/// A source of DNS answers.
pub trait Resolver: Send + Sync + 'static {
    /// Resolve `host` (a DNS name, never an IP literal) to its addresses.
    fn resolve<'a>(&'a self, host: &'a str) -> ResolveFuture<'a>;
}

/// The operating system resolver (`getaddrinfo` on the blocking pool).
#[derive(Debug, Clone, Copy, Default)]
pub struct SystemResolver;

impl Resolver for SystemResolver {
    fn resolve<'a>(&'a self, host: &'a str) -> ResolveFuture<'a> {
        Box::pin(async move {
            let answer = tokio::net::lookup_host((host, 0_u16)).await?;
            Ok(answer.map(|socket| socket.ip()).collect())
        })
    }
}

/// Deduplicate an answer while keeping its order.
pub(crate) fn dedupe(addresses: Vec<IpAddr>) -> Vec<IpAddr> {
    let mut unique: Vec<IpAddr> = Vec::with_capacity(addresses.len());
    for address in addresses {
        if !unique.contains(&address) {
            unique.push(address);
        }
    }
    unique
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use std::net::{IpAddr, Ipv4Addr};

    use super::{Resolver, SystemResolver, dedupe};

    // The operating system resolves `localhost` without network access, so the
    // test stays deterministic in CI and in a sandbox.
    #[tokio::test]
    async fn system_resolver_answers_localhost_with_loopback() {
        let answer = SystemResolver
            .resolve("localhost")
            .await
            .expect("localhost resolves");

        assert!(
            !answer.is_empty(),
            "localhost must have at least one address"
        );
        assert!(
            answer.iter().all(IpAddr::is_loopback),
            "localhost must resolve to loopback only, got {answer:?}"
        );
    }

    #[test]
    fn dedupe_keeps_first_occurrence_order() {
        let a = IpAddr::V4(Ipv4Addr::new(192, 0, 2, 1));
        let b = IpAddr::V4(Ipv4Addr::new(192, 0, 2, 2));
        let c = IpAddr::V4(Ipv4Addr::new(192, 0, 2, 3));

        assert_eq!(dedupe(vec![b, a, b, c, a]), vec![b, a, c]);
    }

    #[test]
    fn dedupe_of_empty_answer_is_empty() {
        assert!(dedupe(Vec::new()).is_empty());
    }
}

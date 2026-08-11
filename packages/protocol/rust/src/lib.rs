//! Rust binding for the FiveProtect wire protocol.
//!
//! The module below is generated from `packages/protocol/src/schemas` and is included
//! rather than copied, so there is one file on disk and the drift check has one thing to
//! compare. Editing it by hand is pointless — the next `npm run protocol:generate` reverts
//! the change, and CI fails in the meantime.
//!
//! See ADR 0001 and ADR 0008 for why the schemas, not this file, are the source of truth.

#![doc(html_no_source)]

#[path = "../../generated/rust/protocol.rs"]
mod generated;

pub use generated::*;

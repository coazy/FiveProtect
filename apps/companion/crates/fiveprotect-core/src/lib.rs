//! The companion's decision-free core.
//!
//! Everything here is a sensor or a transport. Nothing decides whether a player may
//! connect — that is the backend's job and only the backend's (ADR 0004). If a type in this
//! crate ever grows a field named `clean`, `passed` or `verdict`, something has gone wrong.
//!
//! The modules are split by what they are allowed to know:
//!
//! | Module      | Knows                                  | Does not know          |
//! | ----------- | -------------------------------------- | ---------------------- |
//! | [`local`]   | the localhost endpoint and its contract | the backend, the scan  |
//! | [`updater`] | signatures and file replacement         | anything about policy  |
//! | [`state`]   | which of four states the window shows   | why                    |

pub mod local;
pub mod state;
pub mod updater;

/// Version of the companion, from the crate manifest.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// First port the localhost endpoint tries (design document 5.3).
pub const PORT_RANGE_START: u16 = fiveprotect_protocol::LOCAL_PORT_RANGE_START as u16;

/// Last port of the range, inclusive.
pub const PORT_RANGE_END: u16 = fiveprotect_protocol::LOCAL_PORT_RANGE_END as u16;

/// The range as a value.
///
/// A function rather than a `const`: building a `RangeInclusive` is not a const operation on
/// stable Rust, and the two bounds above are what callers usually want anyway.
#[must_use]
pub fn port_range() -> std::ops::RangeInclusive<u16> {
    PORT_RANGE_START..=PORT_RANGE_END
}

/// Registry path where the chosen port is published for the NUI to find.
///
/// A hint, not a trust anchor: the NUI probes the range anyway, because the value can be
/// stale or missing and a player waiting in a deferral cannot be asked to fix that.
pub const PORT_REGISTRY_KEY: &str = r"HKCU\Software\FiveProtect";
pub const PORT_REGISTRY_VALUE: &str = "Port";

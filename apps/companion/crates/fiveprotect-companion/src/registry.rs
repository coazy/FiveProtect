//! Publishes the chosen port under `HKCU\Software\FiveProtect`.
//!
//! A hint, not a trust anchor. The NUI probes the whole range regardless, because this value
//! can be stale, missing or written by something else entirely, and a player waiting in a
//! deferral cannot be asked to fix that. It exists so the common case is one request instead
//! of a hundred.
//!
//! `HKCU` rather than `HKLM`: no elevation, and two accounts on one machine each get their
//! own companion without fighting over one value.

#[cfg(windows)]
mod windows {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;

    use windows_sys::Win32::Foundation::ERROR_SUCCESS;
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegCreateKeyExW, RegDeleteValueW, RegSetValueExW, HKEY, HKEY_CURRENT_USER,
        KEY_SET_VALUE, REG_DWORD, REG_OPTION_NON_VOLATILE,
    };

    const SUBKEY: &str = r"Software\FiveProtect";
    const VALUE: &str = "Port";

    fn wide(text: &str) -> Vec<u16> {
        OsStr::new(text).encode_wide().chain(Some(0)).collect()
    }

    /// Opens (creating if needed) the companion's key for writing.
    fn open() -> Option<HKEY> {
        let subkey = wide(SUBKEY);
        let mut key: HKEY = std::ptr::null_mut();

        // SAFETY: `subkey` is NUL terminated and outlives the call; `key` is a live handle
        // slot. Every other pointer argument is explicitly optional and passed as null.
        #[allow(unsafe_code)]
        let status = unsafe {
            RegCreateKeyExW(
                HKEY_CURRENT_USER,
                subkey.as_ptr(),
                0,
                std::ptr::null_mut(),
                REG_OPTION_NON_VOLATILE,
                KEY_SET_VALUE,
                std::ptr::null(),
                &mut key,
                std::ptr::null_mut(),
            )
        };

        (status == ERROR_SUCCESS).then_some(key)
    }

    #[allow(unsafe_code)]
    fn close(key: HKEY) {
        // SAFETY: `key` came from RegCreateKeyExW and is closed exactly once.
        unsafe { RegCloseKey(key) };
    }

    pub fn publish(port: u16) -> bool {
        let Some(key) = open() else { return false };
        let value = wide(VALUE);
        let data = u32::from(port);

        // SAFETY: `data` is a live u32 and `REG_DWORD` declares exactly four bytes, which is
        // what `size_of` reports. `value` is NUL terminated and outlives the call.
        #[allow(unsafe_code)]
        let status = unsafe {
            RegSetValueExW(
                key,
                value.as_ptr(),
                0,
                REG_DWORD,
                std::ptr::from_ref(&data).cast::<u8>(),
                u32::try_from(std::mem::size_of::<u32>()).unwrap_or(4),
            )
        };

        close(key);
        status == ERROR_SUCCESS
    }

    /// Removes the value on a clean shutdown, so a stale port does not outlive the process.
    pub fn withdraw() {
        let Some(key) = open() else { return };
        let value = wide(VALUE);

        // SAFETY: as above; the value name is NUL terminated and the key is valid.
        #[allow(unsafe_code)]
        unsafe {
            RegDeleteValueW(key, value.as_ptr())
        };

        close(key);
    }
}

#[cfg(not(windows))]
mod windows {
    /// The companion only ships for Windows. These keep the crate buildable elsewhere so
    /// that the parts which are not Windows-specific can still be tested on a build machine.
    pub fn publish(_port: u16) -> bool {
        false
    }

    pub fn withdraw() {}
}

pub use windows::{publish, withdraw};

#[cfg(all(test, windows))]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    #[test]
    fn a_port_can_be_published_and_withdrawn() {
        // Touches the real registry under HKCU, which needs no elevation and affects only
        // the account running the test.
        assert!(super::publish(52800), "publishing the port must succeed");
        super::withdraw();
        // Withdrawing twice is what a second shutdown would do. It must not fail.
        super::withdraw();
    }
}

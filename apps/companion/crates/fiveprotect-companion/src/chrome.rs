//! The last piece of the window Windows still draws itself.
//!
//! Turning decorations off removes the title bar but not the frame: the desktop window
//! manager keeps painting a one pixel border, and on a focused window it paints it in the
//! user's accent colour. On a machine whose accent is orange that leaves a bright ring
//! around a dark grey window, which is what it looked like — and no amount of CSS reaches
//! it, because it is outside the page.
//!
//! So the border is set explicitly, to the same grey the page uses for its own dividers.

#[cfg(windows)]
mod windows {
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::Graphics::Dwm::{
        DwmSetWindowAttribute, DWMWA_BORDER_COLOR, DWMWA_USE_IMMERSIVE_DARK_MODE,
    };

    /// `--border` from the stylesheet, as a COLORREF — which is 0x00BBGGRR, not RGB.
    const BORDER: u32 = 0x0037_302b;

    /// Tells Windows this is a dark window, so the shadow and any system-drawn edge match.
    fn set_dark_mode(handle: HWND) {
        let enabled: u32 = 1;
        // SAFETY: `handle` is a live window handle owned by the caller, and the attribute
        // takes exactly the four bytes `enabled` occupies.
        #[allow(unsafe_code)]
        unsafe {
            DwmSetWindowAttribute(
                handle,
                DWMWA_USE_IMMERSIVE_DARK_MODE as u32,
                std::ptr::from_ref(&enabled).cast(),
                u32::try_from(std::mem::size_of::<u32>()).unwrap_or(4),
            )
        };
    }

    fn set_border(handle: HWND) {
        // SAFETY: as above.
        #[allow(unsafe_code)]
        unsafe {
            DwmSetWindowAttribute(
                handle,
                DWMWA_BORDER_COLOR as u32,
                std::ptr::from_ref(&BORDER).cast(),
                u32::try_from(std::mem::size_of::<u32>()).unwrap_or(4),
            )
        };
    }

    /// Applies both. Silently does nothing on a Windows old enough not to know them, which
    /// is the correct outcome — the window still works, it just keeps the system border.
    pub fn apply(handle: isize) {
        if handle == 0 {
            return;
        }
        let handle = handle as HWND;
        set_dark_mode(handle);
        set_border(handle);
    }
}

#[cfg(not(windows))]
mod windows {
    pub fn apply(_handle: isize) {}
}

pub use windows::apply;

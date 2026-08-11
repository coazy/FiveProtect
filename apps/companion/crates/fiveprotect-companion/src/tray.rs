//! The tray icon.
//!
//! Minimising sends the window here rather than to the taskbar. The companion has to keep
//! running for the whole session — the backend ends a session whose heartbeat stops — and a
//! program that must not be closed is better represented by a tray icon than by a window the
//! player is tempted to tidy away.
//!
//! The menu is a window of ours, not a system menu. A Win32 popup cannot be styled, and a
//! grey system menu hanging off this window would look like two different programs.

use std::io::Cursor;

/// Decodes the embedded icon into the raw RGBA `tray-icon` wants.
///
/// Returns the pixels and the square edge length. `None` on anything unexpected, which costs
/// the tray icon and nothing else — the window still works without it.
pub fn icon_rgba(png_bytes: &[u8]) -> Option<(Vec<u8>, u32)> {
    let decoder = png::Decoder::new(Cursor::new(png_bytes));
    let mut reader = decoder.read_info().ok()?;
    let mut buffer = vec![0u8; reader.output_buffer_size()];
    let info = reader.next_frame(&mut buffer).ok()?;

    if info.width != info.height {
        return None;
    }

    buffer.truncate(info.buffer_size());

    let rgba = match info.color_type {
        png::ColorType::Rgba => buffer,
        // The icon is authored with an alpha channel; anything else means the asset was
        // replaced with something this code has not been told about.
        _ => return None,
    };

    Some((rgba, info.width))
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn the_embedded_icon_decodes_to_square_rgba() {
        let (pixels, edge) = icon_rgba(crate::shell::TRAY_ICON).expect("the icon decodes");
        assert_eq!(pixels.len(), (edge as usize) * (edge as usize) * 4);
        assert!(edge >= 16, "an icon smaller than 16px will look wrong: {edge}");
    }

    #[test]
    fn the_icon_is_not_a_solid_block() {
        // Catches an asset that was regenerated into an opaque square, which on a dark
        // taskbar reads as a missing icon rather than as a shield.
        let (pixels, _) = icon_rgba(crate::shell::TRAY_ICON).expect("the icon decodes");
        let transparent = pixels.chunks_exact(4).filter(|px| px[3] == 0).count();
        assert!(transparent > 0, "the icon has no transparent pixels at all");
    }

    #[test]
    fn something_that_is_not_a_png_is_refused_rather_than_guessed_at() {
        assert!(icon_rgba(b"not a png").is_none());
        assert!(icon_rgba(&[]).is_none());
    }
}

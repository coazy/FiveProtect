//! The window.
//!
//! One page, assembled at build time from the files in `apps/companion/ui` and handed to the
//! webview as a single string. Inlined rather than served over a local URL on purpose: the
//! page must not be reachable by anything other than this process, and a second listening
//! socket carrying the window's state would be exactly the local oracle the localhost
//! endpoint is built to avoid (ADR 0004).
//!
//! Traffic goes one way. The shell pushes a view; the page renders it. The only thing the
//! page can send back is the request to check again, which is a nudge, not a decision.

use fiveprotect_core::state::WindowView;

const INDEX: &str = include_str!("../../../ui/index.html");
const STYLES: &str = include_str!("../../../ui/styles.css");
const APP_JS: &str = include_str!("../../../ui/app.js");
const FONT: &[u8] = include_bytes!("../../../ui/assets/manrope-variable-latin.woff2");

const MENU_HTML: &str = include_str!("../../../ui/menu.html");
const MENU_CSS: &str = include_str!("../../../ui/menu.css");
const MENU_JS: &str = include_str!("../../../ui/menu.js");

/// The tray icon, as PNG. Decoded once at start-up.
pub const TRAY_ICON: &[u8] = include_bytes!("../../../ui/assets/tray-icon.png");

/// The tray menu's window size, in logical pixels. Matched to the rows the page draws — a
/// window larger than its content would show as a dark margin around the menu.
pub const MENU_WIDTH: f64 = 208.0;
pub const MENU_HEIGHT: f64 = 132.0;

/// Builds the single page the window loads.
#[must_use]
pub fn page() -> String {
    let styles = STYLES.replace(
        "url('assets/manrope-variable-latin.woff2')",
        &format!("url('data:font/woff2;base64,{}')", base64(FONT)),
    );

    INDEX
        // The webview loads this as a string, so the document has no origin and relative
        // URLs resolve to nothing. Everything the page needs has to already be in it.
        .replace(
            r#"<link rel="stylesheet" href="styles.css" />"#,
            &format!("<style>\n{styles}\n</style>"),
        )
        .replace(
            r#"<script type="module" src="app.js"></script>"#,
            &format!("<script>\n{}\n</script>", classic(APP_JS)),
        )
        // The shipped page is loaded from a file and can name its own sources. This one is
        // a string with no origin, where `'self'` matches nothing at all — including the
        // style and script that were just inlined into it.
        .replace(
            r#"content="default-src 'none'; style-src 'self'; script-src 'self'; font-src 'self'; img-src 'self' data:; connect-src ipc: http://ipc.localhost""#,
            r#"content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; font-src data:; img-src data:; connect-src ipc: http://ipc.localhost""#,
        )
}

/// Builds the tray menu page, assembled the same way as the window.
#[must_use]
pub fn menu_page() -> String {
    let styles = MENU_CSS.replace(
        "url('assets/manrope-variable-latin.woff2')",
        &format!("url('data:font/woff2;base64,{}')", base64(FONT)),
    );

    MENU_HTML
        .replace(
            r#"<link rel="stylesheet" href="menu.css" />"#,
            &format!("<style>\n{styles}\n</style>"),
        )
        .replace(
            r#"<script type="module" src="menu.js"></script>"#,
            &format!("<script>\n{}\n</script>", classic(MENU_JS)),
        )
        .replace(
            r#"content="default-src 'none'; style-src 'self'; script-src 'self'; font-src 'self'""#,
            r#"content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; font-src data:""#,
        )
}

/// Turns the module into a classic script.
///
/// The page has no origin, and a module script needs one. The transform is limited to the
/// two keywords the file actually uses at the top level, and `page_has_no_module_syntax_left`
/// fails if anything else creeps in.
fn classic(source: &str) -> String {
    source
        .replace("\nexport function ", "\nfunction ")
        .replace("\nexport const ", "\nconst ")
}

/// The script that hands one view to the page.
#[must_use]
pub fn push_script(model: &WindowView) -> String {
    let json = serde_json::to_string(model).unwrap_or_else(|_| "null".to_owned());
    // Guarded because a view can arrive before the page has finished parsing.
    format!("window.__fiveprotect && window.__fiveprotect.push({json});")
}

/// Minimal base64 for the font. A dependency for eleven lines would be a poor trade.
fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = u32::from(chunk[0]);
        let b1 = chunk.get(1).copied().map_or(0, u32::from);
        let b2 = chunk.get(2).copied().map_or(0, u32::from);
        let triple = (b0 << 16) | (b1 << 8) | b2;

        out.push(char::from(ALPHABET[(triple >> 18) as usize & 0x3f]));
        out.push(char::from(ALPHABET[(triple >> 12) as usize & 0x3f]));
        out.push(if chunk.len() > 1 {
            char::from(ALPHABET[(triple >> 6) as usize & 0x3f])
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            char::from(ALPHABET[triple as usize & 0x3f])
        } else {
            '='
        });
    }
    out
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use fiveprotect_core::state::{view, WindowState};

    #[test]
    fn base64_matches_the_reference_vectors() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foob"), "Zm9vYg==");
        assert_eq!(base64(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn the_page_carries_no_external_reference() {
        // A reference that cannot resolve is a silent fallback: the window would render in
        // whatever font the system picks and nobody would find out until a screenshot.
        let html = page();
        assert!(!html.contains(r#"href="styles.css""#), "stylesheet not inlined");
        assert!(!html.contains(r#"src="app.js""#), "script not inlined");
        assert!(
            !html.contains("url('assets/"),
            "the font is still a relative URL"
        );
        assert!(html.contains("data:font/woff2;base64,"), "font not inlined");
    }

    #[test]
    fn the_page_has_no_module_syntax_left() {
        // If it does, the browser refuses the whole script and the window renders as a
        // blank frame — which looks exactly like a crash and is not one.
        let html = page();
        assert!(!html.contains("\nexport "), "an export survived the transform");
        assert!(!html.contains("\nimport "), "the page must not import anything");
    }

    #[test]
    fn the_font_is_actually_embedded() {
        // Catches an empty or missing asset, which would otherwise show up as a page that
        // renders but in the wrong typeface.
        assert!(FONT.len() > 1024, "font asset looks empty: {} bytes", FONT.len());
        assert_eq!(&FONT[0..4], b"wOF2", "asset is not a woff2 file");
    }

    #[test]
    fn the_menu_page_is_self_contained_too() {
        let html = menu_page();
        assert!(!html.contains(r#"href="menu.css""#), "stylesheet not inlined");
        assert!(!html.contains(r#"src="menu.js""#), "script not inlined");
        assert!(!html.contains("\nexport "), "an export survived the transform");
        assert!(html.contains("data:font/woff2;base64,"), "font not inlined");
    }

    #[test]
    fn the_menu_uses_the_same_tokens_as_the_window() {
        // The two stylesheets duplicate the palette rather than share it. If one drifts, the
        // tray menu stops looking like the program it belongs to.
        for token in ["--surface: #1b1e23", "--border: #2b3037", "--mint: #4ade9f"] {
            assert!(STYLES.contains(token), "window is missing {token}");
            assert!(MENU_CSS.contains(token), "menu is missing {token}");
        }
    }

    #[test]
    fn the_tray_icon_is_a_png() {
        assert!(TRAY_ICON.len() > 256, "icon looks empty");
        assert_eq!(&TRAY_ICON[1..4], b"PNG", "asset is not a PNG");
    }

    #[test]
    fn a_view_is_pushed_as_one_statement() {
        let model = view(WindowState::Checking, None, None, "0.1.0", 1);
        let script = push_script(&model);
        assert!(script.starts_with("window.__fiveprotect &&"), "{script}");
        assert!(script.contains("\"state\":\"checking\""), "{script}");
    }
}

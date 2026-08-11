//! FiveProtect, the program the player runs.
//!
//! It does four things: it listens on 127.0.0.1 so the game client can reach it, it collects
//! the nonce meant for this machine, it measures the machine and reports what it found, and
//! it shows the player where they stand. It decides nothing — every allow and every deny is
//! the backend's (ADR 0004), and there is no code path here that could produce one.
//!
//! Threads:
//!
//! | Thread     | Does                                              |
//! | ---------- | ------------------------------------------------- |
//! | main       | owns the window and renders whatever it is handed  |
//! | collector  | long-polls the backend for a nonce                 |
//! | endpoint   | serves 127.0.0.1 for the game client               |
//! | worker     | scans, reports, keeps the session alive            |

// A console window behind the UI would look like a crashed installer. The console is still
// there when the binary is started from one, which is where the diagnostics are read.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod backend;
mod chrome;
mod diagnostics;
mod engine;
mod identity;
mod log;
mod registry;
mod server;
mod settings;
mod shell;
mod tray;
mod worker;

use std::rc::Rc;
use std::sync::mpsc::{self, Sender};

use fiveprotect_core::state::WindowView;
use tao::dpi::LogicalSize;
use tao::event::{Event as TaoEvent, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoopBuilder};
use tao::window::WindowBuilder;
use wry::{WebContext, WebViewBuilder};

use worker::Job;

/// How long the exit waits for the backend to be told the session is over.
const SHUTDOWN_GRACE: std::time::Duration = std::time::Duration::from_secs(3);

/// The window is fixed at the size the layout was drawn for. There is nothing to resize into.
const WINDOW_WIDTH: f64 = 420.0;
const WINDOW_HEIGHT: f64 = 640.0;

/// What the event loop is woken up with.
///
/// Everything that happens off the main thread — a new view, a click on the tray icon, a
/// choice in the menu — arrives here, because the windows may only be touched from the
/// thread that owns the event loop.
#[derive(Debug)]
enum Wake {
    /// A new view to render.
    View(Box<WindowView>),
    /// Bring the window back from the tray.
    ShowWindow,
    /// Put the window away without ending the session.
    HideWindow,
    /// Open the tray menu at this screen position, or close it if it is already open.
    ToggleMenu { x: f64, y: f64 },
    /// Close the tray menu.
    HideMenu,
    /// Run another check.
    Recheck,
    /// End the program.
    Quit,
}

fn main() {
    let version = fiveprotect_core::VERSION;

    let build_hash = match identity::build_hash() {
        Ok(hash) => hash,
        Err(error) => {
            // Without a build hash the backend cannot pin the binary, so there is nothing
            // honest to report. Refusing to start beats attesting under a made-up identity.
            crate::log::logline!("Der eigene Programm-Hash konnte nicht gelesen werden: {error}");
            std::process::exit(1);
        }
    };

    let settings = settings::Settings::load();
    log::logline!("Version {version}, Scan-Engine {}", engine::version());
    log::logline!("Build-Hash {build_hash}");
    log::logline!(
        "Vertraute Backends: {}{}",
        settings.allowed_backends.join(", "),
        settings
            .source
            .as_ref()
            .map(|path| format!(" (erweitert durch {})", path.display()))
            .unwrap_or_default()
    );

    // The backend the collector reports to is the first trusted entry. The localhost
    // endpoint still checks every command against the whole list, so a game client naming a
    // different trusted backend is honoured; this is only where the collector points.
    let Some(primary) = settings.allowed_backends.first().cloned() else {
        crate::log::logline!("Kein Backend konfiguriert.");
        std::process::exit(1);
    };

    let endpoint = match server::Endpoint::bind() {
        Ok(endpoint) => endpoint,
        Err(error) => {
            crate::log::logline!("Kein freier Port im Bereich 52800-52899: {error}");
            std::process::exit(1);
        }
    };
    let port = endpoint.port;
    crate::log::logline!("Lauscht auf 127.0.0.1:{port}");

    if !registry::publish(port) {
        // Only a hint for the NUI, which probes the range anyway. Worth a line, not an exit.
        crate::log::logline!("Der Port konnte nicht in die Registry geschrieben werden.");
    }

    let (jobs_tx, jobs_rx) = mpsc::channel::<Job>();
    let (views_tx, views_rx) = mpsc::channel::<WindowView>();

    spawn("fiveprotect-endpoint", {
        let allowed = settings.allowed_backends.clone();
        let commands = local_bridge(jobs_tx.clone());
        let version = version.to_owned();
        move || endpoint.serve(allowed, commands, version)
    });

    spawn("fiveprotect-collector", {
        let jobs = jobs_tx.clone();
        let primary = primary.clone();
        let version = version.to_owned();
        move || {
            let client = backend::Client::new(&primary, &version);
            worker::collect_nonces(&client, &jobs);
        }
    });

    spawn("fiveprotect-worker", {
        let primary = primary.clone();
        let version = version.to_owned();
        let build_hash = build_hash.clone();
        move || {
            let client = backend::Client::new(&primary, &version);
            let worker = worker::Worker::new(client, &version, &build_hash);
            worker.run(&jobs_rx, &views_tx);
        }
    });

    run_window(views_rx, jobs_tx);
}

/// Adapts the endpoint's command channel to the worker's job channel.
///
/// The endpoint knows nothing about jobs and the worker knows nothing about sockets. This is
/// the one place that knows both.
fn local_bridge(jobs: Sender<Job>) -> Sender<server::LocalCommand> {
    let (tx, rx) = mpsc::channel::<server::LocalCommand>();
    spawn("fiveprotect-bridge", move || {
        while let Ok(command) = rx.recv() {
            if jobs.send(Job::Local(command)).is_err() {
                return;
            }
        }
    });
    tx
}

/// Builds the tray menu: an undecorated, always-on-top window holding one small page.
///
/// `None` if it cannot be created. The tray icon still works then; only the menu is missing,
/// which is a smaller loss than refusing to start.
fn menu_window(
    event_loop: &tao::event_loop::EventLoop<Wake>,
    context: &mut WebContext,
) -> Option<(tao::window::Window, wry::WebView)> {
    #[cfg(windows)]
    use tao::platform::windows::WindowBuilderExtWindows;

    let window = WindowBuilder::new()
        .with_title("FiveProtect")
        .with_inner_size(LogicalSize::new(shell::MENU_WIDTH, shell::MENU_HEIGHT))
        .with_decorations(false)
        .with_resizable(false)
        .with_always_on_top(true)
        // Not a window in its own right: it must not appear in the taskbar, in Alt+Tab, or
        // on screen before something asks for it.
        .with_skip_taskbar(true)
        .with_visible(false)
        .build(event_loop)
        .ok()?;

    let proxy = event_loop.create_proxy();
    let webview = WebViewBuilder::new(&window)
        .with_web_context(context)
        .with_html(shell::menu_page())
        .with_ipc_handler(move |request| {
            let wake = match command_of(request.body()) {
                Some("show") => Wake::ShowWindow,
                Some("recheck") => Wake::Recheck,
                Some("quit") => Wake::Quit,
                Some("dismiss") => Wake::HideMenu,
                _ => return,
            };
            proxy.send_event(wake).ok();
        })
        .build()
        .ok()?;

    Some((window, webview))
}

/// Puts the icon in the notification area and wires its clicks into the event loop.
#[cfg(windows)]
fn tray_icon(event_loop: &tao::event_loop::EventLoop<Wake>) -> Option<tray_icon::TrayIcon> {
    let (rgba, edge) = tray::icon_rgba(shell::TRAY_ICON)?;
    let icon = tray_icon::Icon::from_rgba(rgba, edge, edge).ok()?;

    let tray = tray_icon::TrayIconBuilder::new()
        .with_tooltip("FiveProtect — Systemprüfung läuft im Hintergrund")
        .with_icon(icon)
        .build()
        .ok()?;

    let proxy = event_loop.create_proxy();
    tray_icon::TrayIconEvent::set_event_handler(Some(move |event| {
        // Runs on the thread that pumps the tray's messages, so nothing is touched here
        // except the channel into the event loop.
        if let tray_icon::TrayIconEvent::Click {
            button, position, ..
        } = event
        {
            let wake = match button {
                tray_icon::MouseButton::Left => Wake::ShowWindow,
                tray_icon::MouseButton::Right => Wake::ToggleMenu {
                    x: position.x,
                    y: position.y,
                },
                tray_icon::MouseButton::Middle => return,
            };
            proxy.send_event(wake).ok();
        }
    }));

    Some(tray)
}

#[cfg(not(windows))]
fn tray_icon(_event_loop: &tao::event_loop::EventLoop<Wake>) -> Option<()> {
    None
}

/// Where WebView2 may keep its profile. `None` leaves it to the default, next to the binary.
fn web_context_dir() -> Option<std::path::PathBuf> {
    let base = std::env::var_os("LOCALAPPDATA").map(std::path::PathBuf::from)?;
    let dir = base.join("FiveProtect").join("WebView2");
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

/// The command name out of `{"command":"…"}`, if the page sent one this build knows.
///
/// A parse rather than a substring search: `body.contains("recheck")` would also fire on a
/// message that merely mentions the word, and the page is not the place to be lenient.
fn command_of(body: &str) -> Option<&'static str> {
    const KNOWN: &[&str] = &[
        "recheck",
        "export_diagnostics",
        "drag",
        "minimize",
        "close",
        "show",
        "quit",
        "dismiss",
    ];

    let parsed: serde_json::Value = serde_json::from_str(body).ok()?;
    let command = parsed.get("command")?.as_str()?;
    KNOWN.iter().copied().find(|known| *known == command)
}

fn spawn<F: FnOnce() + Send + 'static>(name: &str, body: F) {
    if let Err(error) = std::thread::Builder::new().name(name.to_owned()).spawn(body) {
        crate::log::logline!("Thread {name} konnte nicht gestartet werden: {error}");
        std::process::exit(1);
    }
}

/// Owns the window until it is closed.
fn run_window(views: mpsc::Receiver<WindowView>, jobs: Sender<Job>) {
    let event_loop = EventLoopBuilder::<Wake>::with_user_event().build();

    let window = match WindowBuilder::new()
        .with_title("FiveProtect")
        .with_inner_size(LogicalSize::new(WINDOW_WIDTH, WINDOW_HEIGHT))
        .with_resizable(false)
        // Windows paints its title bar in the user's accent colour and offers no way to
        // restyle it. Next to a dark utility window that reads as an unfinished port, so the
        // page draws the strip instead and this side answers `drag`, `minimize` and `close`.
        .with_decorations(false)
        .build(&event_loop)
    {
        Ok(window) => window,
        Err(error) => {
            crate::log::logline!("Fenster konnte nicht geoeffnet werden: {error}");
            std::process::exit(1);
        }
    };
    // Windows keeps drawing a one pixel frame around an undecorated window, in the user's
    // accent colour while it has focus. This replaces it with the page's own border grey.
    #[cfg(windows)]
    {
        use tao::platform::windows::WindowExtWindows;
        chrome::apply(window.hwnd() as isize);
    }

    let window = Rc::new(window);

    // WebView2 keeps a cache and a profile next to the executable unless told otherwise,
    // which turns a one-file download into a folder the player has to keep together with it.
    // Sending it to the profile directory means the distribution is the binary and nothing
    // else — and it survives the executable being moved.
    let mut web_context = WebContext::new(web_context_dir());

    let window_proxy = event_loop.create_proxy();

    let webview = match WebViewBuilder::new(window.as_ref())
        .with_web_context(&mut web_context)
        .with_html(shell::page())
        .with_ipc_handler({
            let window = Rc::clone(&window);
            let jobs = jobs.clone();
            move |request| {
                // A fixed list of commands, matched exactly. The page is the least trusted
                // part of this program, and none of these does anything the player could not
                // do with the mouse — there is deliberately no command that reaches the
                // scan, the backend or a verdict.
                match command_of(request.body()) {
                    Some("recheck") => {
                        jobs.send(Job::Recheck).ok();
                    }
                    Some("export_diagnostics") => match diagnostics::export() {
                        Ok(path) => {
                            crate::log::logline!("Diagnose gespeichert: {}", path.display());
                        }
                        Err(error) => {
                            crate::log::logline!("Diagnose fehlgeschlagen: {error}");
                        }
                    },
                    // A failed drag means the mouse button was already released. Nothing to
                    // report and nothing to do about it.
                    Some("drag") => {
                        window.drag_window().ok();
                    }
                    // Both put the window away rather than end the program. The backend
                    // ends a session whose heartbeat stops, so a companion closed mid-game
                    // throws the player off the server — and the X is the button people
                    // press when they mean "out of my way". Ending it is in the tray menu,
                    // where it is a deliberate choice.
                    Some("minimize" | "close") => {
                        window_proxy.send_event(Wake::HideWindow).ok();
                    }
                    _ => {}
                }
            }
        })
        .build()
    {
        Ok(webview) => webview,
        Err(error) => {
            crate::log::logline!("Oberflaeche konnte nicht geladen werden: {error}");
            std::process::exit(1);
        }
    };

    let menu = menu_window(&event_loop, &mut web_context);
    let tray = tray_icon(&event_loop);

    // Bridges the worker's channel into the event loop, which is the only place the webview
    // may be touched.
    let proxy = event_loop.create_proxy();
    spawn("fiveprotect-views", move || {
        while let Ok(model) = views.recv() {
            if proxy.send_event(Wake::View(Box::new(model))).is_err() {
                return;
            }
        }
    });

    event_loop.run(move |event, _target, control_flow| {
        *control_flow = ControlFlow::Wait;

        // Held for the whole run: dropping either removes it from the desktop.
        let _keep_alive = (&tray, &menu);

        match event {
            TaoEvent::UserEvent(Wake::View(model)) => {
                if let Err(error) = webview.evaluate_script(&shell::push_script(&model)) {
                    crate::log::logline!("Oberflaeche konnte nicht aktualisiert werden: {error}");
                }
            }
            TaoEvent::UserEvent(Wake::ShowWindow) => {
                hide_menu(menu.as_ref());
                window.set_visible(true);
                window.set_minimized(false);
                window.set_focus();
            }
            TaoEvent::UserEvent(Wake::HideWindow) => {
                hide_menu(menu.as_ref());
                window.set_visible(false);
            }
            TaoEvent::UserEvent(Wake::ToggleMenu { x, y }) => {
                if let Some((menu_window, _)) = menu.as_ref() {
                    if menu_window.is_visible() {
                        hide_menu(menu.as_ref());
                    } else {
                        show_menu_at(menu_window, x, y);
                    }
                }
            }
            TaoEvent::UserEvent(Wake::HideMenu) => hide_menu(menu.as_ref()),
            TaoEvent::UserEvent(Wake::Recheck) => {
                hide_menu(menu.as_ref());
                jobs.send(Job::Recheck).ok();
            }
            TaoEvent::UserEvent(Wake::Quit) => {
                // Tell the backend before going, so a player who quits on purpose is
                // dropped now rather than after the grace period. Bounded, because an exit
                // that hangs on an unreachable backend is worse than a late kick — and the
                // heartbeat timeout covers that case anyway.
                let (done, waiter) = mpsc::channel();
                if jobs.send(Job::Shutdown(done)).is_ok() {
                    waiter.recv_timeout(SHUTDOWN_GRACE).ok();
                }
                registry::withdraw();
                *control_flow = ControlFlow::Exit;
            }
            TaoEvent::WindowEvent {
                event: WindowEvent::CloseRequested,
                ..
            } => {
                // Reachable through the system menu, which an undecorated window still has.
                // Same answer as the page's own close button: put it away, do not end it.
                window.set_visible(false);
            }
            _ => {}
        }
    });
}

/// Places the menu so that it sits above and left of the cursor, and never off the screen.
fn show_menu_at(menu: &tao::window::Window, x: f64, y: f64) {
    let scale = menu.scale_factor();
    let width = shell::MENU_WIDTH * scale;
    let height = shell::MENU_HEIGHT * scale;

    // The tray lives in a corner, so the menu opens back towards the middle of the screen.
    let position = tao::dpi::PhysicalPosition::new((x - width).max(0.0), (y - height).max(0.0));

    menu.set_outer_position(position);
    menu.set_visible(true);
    menu.set_focus();
}

fn hide_menu(menu: Option<&(tao::window::Window, wry::WebView)>) {
    if let Some((window, _)) = menu {
        window.set_visible(false);
    }
}

//! The localhost endpoint.
//!
//! ADR 0003 in running form. `fiveprotect_core::local` decides what the endpoint accepts; this
//! file is the socket, the HTTP framing and nothing else. The split is deliberate — the
//! interesting refusals are unit-tested there without a port being opened.
//!
//! Since ADR 0010 this is the second way a nonce can arrive, not the first: FiveM does not
//! run client resources during a connect deferral, so the companion collects its nonce from
//! the backend. This path stays because it is the one that works once the player is in game.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Ipv4Addr, SocketAddrV4, TcpListener, TcpStream};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::Sender;
use std::sync::Arc;
use std::time::Duration;

use fiveprotect_core::local::{acknowledgement, handle_request, Accepted, RejectReason};
use fiveprotect_core::port_range;
use fiveprotect_protocol::LocalAttestCommand;

/// A request larger than this is not one the protocol describes.
const MAX_BODY: usize = 16 * 1024;

/// A connection that has not finished its request by now is not going to.
const IO_TIMEOUT: Duration = Duration::from_secs(3);

/// The NUI probes the whole range at once, so a hundred connections at a time is ordinary.
/// The cap is here to stop a local process from spawning threads without bound.
const MAX_CONCURRENT: usize = 160;

/// A command that reached the endpoint and passed every check.
pub type LocalCommand = Box<LocalAttestCommand>;

#[derive(Debug)]
pub struct Endpoint {
    pub port: u16,
    listener: TcpListener,
}

impl Endpoint {
    /// Binds the first free port of the range.
    ///
    /// A range rather than one port because the companion cannot ask the player to free a
    /// port, and because a single fixed port is the easiest thing in the world for another
    /// program to squat on.
    pub fn bind() -> std::io::Result<Self> {
        let mut last = None;
        for port in port_range() {
            match TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, port)) {
                Ok(listener) => return Ok(Self { port, listener }),
                Err(error) => last = Some(error),
            }
        }
        Err(last.unwrap_or_else(|| {
            std::io::Error::new(std::io::ErrorKind::AddrInUse, "no port in the range was free")
        }))
    }

    /// Serves until the process ends. Blocks; meant to own a thread.
    pub fn serve(self, allowed_backends: Vec<String>, jobs: Sender<LocalCommand>, version: String) {
        let live = Arc::new(AtomicUsize::new(0));
        let allowed = Arc::new(allowed_backends);

        for incoming in self.listener.incoming() {
            let Ok(stream) = incoming else { continue };

            if live.load(Ordering::Relaxed) >= MAX_CONCURRENT {
                // Dropping the stream closes it. A caller that meets this is either the NUI
                // retrying, which is harmless, or something that should not be here.
                continue;
            }

            let counter = Arc::clone(&live);
            let allowed = Arc::clone(&allowed);
            let jobs = jobs.clone();
            let version = version.clone();

            live.fetch_add(1, Ordering::Relaxed);
            let spawned = std::thread::Builder::new()
                .name("fiveprotect-local".to_owned())
                .spawn(move || {
                    serve_one(stream, &allowed, &jobs, &version);
                    counter.fetch_sub(1, Ordering::Relaxed);
                });

            if spawned.is_err() {
                live.fetch_sub(1, Ordering::Relaxed);
            }
        }
    }
}

fn serve_one(
    stream: TcpStream,
    allowed: &[String],
    jobs: &Sender<LocalCommand>,
    version: &str,
) {
    stream.set_read_timeout(Some(IO_TIMEOUT)).ok();
    stream.set_write_timeout(Some(IO_TIMEOUT)).ok();

    let Ok(mut writer) = stream.try_clone() else {
        return;
    };

    let request = match read_request(stream) {
        Ok(request) => request,
        Err(_) => {
            write_response(&mut writer, 400, "{\"code\":\"malformed_request\"}").ok();
            return;
        }
    };

    // The browser preflight is answered here rather than by `handle_request`, which refuses
    // every method but POST. A preflight carries no command — it asks whether the real
    // request may be sent — so letting the contract see it would mean teaching the contract
    // about CORS. Without this answer the NUI's fetch never gets as far as sending anything.
    if request.method.eq_ignore_ascii_case("OPTIONS") {
        write_response(&mut writer, 204, "").ok();
        return;
    }

    match handle_request(&request.method, &request.path, &request.body, allowed) {
        Ok(Accepted::Attest(command)) => {
            // The send can only fail once the worker is gone, which happens on shutdown.
            jobs.send(command).ok();

            let ack = acknowledgement(version);
            let body = serde_json::to_string(&ack)
                .unwrap_or_else(|_| String::from("{\"accepted\":true}"));
            write_response(&mut writer, 200, &body).ok();
        }
        Err(reason) => {
            // Every refusal answers the same way. Distinguishing them here would tell a
            // caller which of its guesses was closest, and the only caller that needs to
            // tell them apart is the developer reading the console.
            let status = match reason {
                RejectReason::WrongRoute => 404,
                _ => 400,
            };
            write_response(&mut writer, status, "{\"code\":\"refused\"}").ok();
        }
    }
}

#[derive(Debug)]
struct Request {
    method: String,
    path: String,
    body: String,
}

fn read_request(stream: TcpStream) -> std::io::Result<Request> {
    let mut reader = BufReader::new(stream);

    let mut start = String::new();
    reader.read_line(&mut start)?;

    let mut parts = start.split_whitespace();
    let method = parts.next().unwrap_or_default().to_owned();
    let path = parts.next().unwrap_or_default().to_owned();

    let mut content_length = 0usize;
    loop {
        let mut line = String::new();
        let read = reader.read_line(&mut line)?;
        if read == 0 || line.trim_end().is_empty() {
            break;
        }
        if let Some((name, value)) = line.split_once(':') {
            if name.trim().eq_ignore_ascii_case("content-length") {
                content_length = value.trim().parse().unwrap_or(0);
            }
        }
    }

    if content_length > MAX_BODY {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "body exceeds the maximum",
        ));
    }

    let mut body = vec![0u8; content_length];
    reader.read_exact(&mut body)?;

    Ok(Request {
        method,
        path,
        body: String::from_utf8_lossy(&body).into_owned(),
    })
}

/// Writes a response with the headers the NUI's fetch needs to read it.
///
/// `Access-Control-Allow-Origin: *` looks generous, and is: any page in any browser on this
/// machine can reach the endpoint. That is acceptable because the endpoint hands back an
/// acknowledgement and nothing else, and because the command it accepts must carry a live
/// nonce for a backend this build already trusts. The worst a hostile page achieves is
/// making the machine scan itself.
fn write_response(stream: &mut TcpStream, status: u16, body: &str) -> std::io::Result<()> {
    let reason = match status {
        200 => "OK",
        204 => "No Content",
        400 => "Bad Request",
        404 => "Not Found",
        _ => "Error",
    };

    let head = format!(
        "HTTP/1.1 {status} {reason}\r\n\
         Content-Type: application/json; charset=utf-8\r\n\
         Content-Length: {}\r\n\
         Access-Control-Allow-Origin: *\r\n\
         Access-Control-Allow-Methods: POST, OPTIONS\r\n\
         Access-Control-Allow-Headers: Content-Type\r\n\
         Access-Control-Max-Age: 600\r\n\
         Cache-Control: no-store\r\n\
         Connection: close\r\n\
         \r\n",
        body.len()
    );

    stream.write_all(head.as_bytes())?;
    stream.write_all(body.as_bytes())?;
    stream.flush()
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    use std::sync::mpsc;

    fn start() -> (u16, mpsc::Receiver<LocalCommand>) {
        let endpoint = Endpoint::bind().expect("binds a port");
        let port = endpoint.port;
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            endpoint.serve(vec!["http://127.0.0.1:8080".to_owned()], tx, "0.1.0".to_owned());
        });
        (port, rx)
    }

    fn request(port: u16, raw: &str) -> String {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).expect("connects");
        stream.write_all(raw.as_bytes()).expect("writes");
        let mut answer = String::new();
        stream.read_to_string(&mut answer).expect("reads");
        answer
    }

    fn post(port: u16, body: &str) -> String {
        request(
            port,
            &format!(
                "POST /attest HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
                body.len()
            ),
        )
    }

    #[test]
    fn binds_inside_the_range() {
        let endpoint = Endpoint::bind().expect("binds");
        assert!(port_range().contains(&endpoint.port), "{}", endpoint.port);
    }

    #[test]
    fn a_valid_command_is_acknowledged_and_forwarded() {
        let (port, rx) = start();
        let nonce = "a".repeat(64);
        let answer = post(
            port,
            &format!(
                r#"{{"nonce":"{nonce}","backendUrl":"http://127.0.0.1:8080","protocolVersion":1}}"#
            ),
        );

        assert!(answer.starts_with("HTTP/1.1 200"), "{answer}");
        assert!(answer.contains("\"accepted\":true"), "{answer}");

        let delivered = rx
            .recv_timeout(Duration::from_secs(2))
            .expect("the command reaches the worker");
        assert_eq!(delivered.nonce, nonce);
    }

    #[test]
    fn the_preflight_is_answered_although_the_contract_refuses_options() {
        // Without this the NUI's fetch never sends the POST at all, and the whole localhost
        // path fails in a way that looks like the companion not running.
        let (port, _rx) = start();
        let answer = request(
            port,
            "OPTIONS /attest HTTP/1.1\r\nHost: 127.0.0.1\r\nOrigin: https://cfx-nui-fiveprotect\r\nAccess-Control-Request-Method: POST\r\n\r\n",
        );

        assert!(answer.starts_with("HTTP/1.1 204"), "{answer}");
        assert!(answer.contains("Access-Control-Allow-Origin: *"), "{answer}");
        assert!(answer.contains("Access-Control-Allow-Headers: Content-Type"), "{answer}");
    }

    #[test]
    fn an_untrusted_backend_is_refused_and_nothing_is_forwarded() {
        let (port, rx) = start();
        let nonce = "a".repeat(64);
        let answer = post(
            port,
            &format!(
                r#"{{"nonce":"{nonce}","backendUrl":"https://evil.example","protocolVersion":1}}"#
            ),
        );

        assert!(answer.starts_with("HTTP/1.1 400"), "{answer}");
        assert!(
            rx.recv_timeout(Duration::from_millis(300)).is_err(),
            "no scan may be started for an untrusted backend"
        );
    }

    #[test]
    fn every_other_route_is_a_404() {
        let (port, _rx) = start();
        let answer = request(port, "GET /state HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
        assert!(answer.starts_with("HTTP/1.1 404"), "{answer}");
    }

    #[test]
    fn the_endpoint_answers_no_question_about_the_outcome() {
        // The reason there is no `GET /state`: a local process must not be able to read
        // whether the check passed (ADR 0004). This asserts the absence.
        let (port, _rx) = start();
        for route in ["GET /state", "GET /status", "GET /verdict", "GET /snapshot"] {
            let answer = request(port, &format!("{route} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n"));
            assert!(answer.starts_with("HTTP/1.1 404"), "{route}: {answer}");
        }
    }

    #[test]
    fn an_oversized_body_is_refused_before_it_is_read() {
        let (port, _rx) = start();
        let answer = request(
            port,
            "POST /attest HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 999999\r\n\r\n",
        );
        assert!(answer.starts_with("HTTP/1.1 400"), "{answer}");
    }
}

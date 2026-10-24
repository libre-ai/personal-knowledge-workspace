// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2

//! Test support for the Playwright run of the editor (CA-41), built only with
//! the `e2e-harness` feature.
//!
//! Playwright drives its own WebKit, not the WKWebView of the shell, so the page
//! cannot use the IPC of the shell. This binary stands in for that one link: it
//! serves the production front (`apps/desktop/dist`, plus test pages) over
//! loopback HTTP and relays each `POST /ipc/<command>` of the page to the very
//! bridge the shell ships, on Tauri's mock runtime with the real generated ACL
//! and the real `notebook-vault` core:
//!
//! page (production bundle) -> shim of `__TAURI_INTERNALS__` -> HTTP ->
//! `get_ipc_response` -> ACL -> `bridge::*` -> `notebook-vault` -> disk
//!
//! What it replaces is the WKWebView transport (`ipc://`, the custom protocol)
//! and the native folder dialog: the picker answers the folder given on the
//! command line, judged by the same guard as in the shell (`--vault` must be a
//! folder below its parent, which stands in for the home folder). It opens a
//! port, which the shell must never do (control C6); that is why it is a
//! separate binary behind a feature that `default` does not enable.
//!
//! Arguments: `--port N --assets DIR --vault DIR`.

use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::Arc;
use std::thread;

use libre_ai_notebook_vault::RootPolicy;
use libre_ai_p04_desktop::bridge::VaultState;
use libre_ai_p04_desktop::{context, with_vault_state};
use serde_json::Value;
use tauri::http::{HeaderMap, HeaderName, HeaderValue};
use tauri::ipc::{CallbackFn, InvokeBody, InvokeResponseBody};
use tauri::test::{INVOKE_KEY, MockRuntime, get_ipc_response, mock_builder};
use tauri::webview::InvokeRequest;
use tauri::{WebviewWindow, WebviewWindowBuilder};

/// The configuration of the shell, read at build time: the page is served under its CSP.
const TAURI_CONF: &str = include_str!("../../tauri.conf.json");
const MAX_HEAD: usize = 64 * 1024;
const MAX_BODY: usize = 8 * 1024 * 1024;

struct Shared {
    window: WebviewWindow<MockRuntime>,
    assets: PathBuf,
    csp: String,
}

struct Request {
    method: String,
    target: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("e2e-harness: {message}");
            ExitCode::FAILURE
        }
    }
}

fn argument(name: &str) -> Result<String, String> {
    let mut args = std::env::args().skip(1);
    while let Some(candidate) = args.next() {
        if candidate == name {
            return args.next().ok_or_else(|| format!("{name} needs a value"));
        }
    }
    Err(format!("{name} is required"))
}

/// The CSP of `tauri.conf.json`, with the one change the harness needs: the page
/// reaches its origin over HTTP where the shell reaches `ipc:`. Every other
/// directive is the shipped one, so a page that needs `unsafe-eval`, an inline
/// script or a remote host fails here as it would in the shell.
fn content_security_policy() -> Result<String, String> {
    let conf: Value = serde_json::from_str(TAURI_CONF).map_err(|error| error.to_string())?;
    let csp = conf
        .pointer("/app/security/csp")
        .and_then(Value::as_object)
        .ok_or("tauri.conf.json has no csp object")?;
    let mut directives = Vec::new();
    for (name, value) in csp {
        let value = value.as_str().ok_or("a csp directive is not a string")?;
        let value = if name == "connect-src" {
            "'self'"
        } else {
            value
        };
        directives.push(format!("{name} {value}"));
    }
    Ok(directives.join("; "))
}

fn run() -> Result<(), String> {
    let port: u16 = argument("--port")?
        .parse()
        .map_err(|_| "--port is not a port number".to_owned())?;
    let assets = PathBuf::from(argument("--assets")?);
    if !assets.join("index.html").is_file() {
        return Err(format!("{} has no index.html", assets.display()));
    }
    let vault = fs::canonicalize(argument("--vault")?).map_err(|error| error.to_string())?;
    let home = vault
        .parent()
        .ok_or("--vault has no parent folder to stand in for the home folder")?
        .to_path_buf();
    let policy = RootPolicy::new(&home, &[]).map_err(|error| format!("{error:?}"))?;

    // The root is injected as the native dialog cannot be driven: the same guard judges it.
    let picked = vault.clone();
    let state = VaultState::with_picker(Some(policy), move || Some(picked.clone()));
    let app = with_vault_state(mock_builder(), state)
        .build(context())
        .map_err(|error| error.to_string())?;
    let window = WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .map_err(|error| error.to_string())?;

    let listener =
        TcpListener::bind(("127.0.0.1", port)).map_err(|error| format!("bind {port}: {error}"))?;
    println!(
        "e2e-harness: listening on 127.0.0.1:{port}, assets {}, vault {}",
        assets.display(),
        vault.display()
    );
    let shared = Arc::new(Shared {
        window,
        assets,
        csp: content_security_policy()?,
    });
    for stream in listener.incoming() {
        let Ok(stream) = stream else { continue };
        let shared = Arc::clone(&shared);
        thread::spawn(move || {
            if let Err(message) = handle(stream, &shared) {
                eprintln!("e2e-harness: {message}");
            }
        });
    }
    // `app` lives as long as the loop: dropping it would end the runtime under the window.
    drop(app);
    Ok(())
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

fn read_request(stream: &mut TcpStream) -> Result<Request, String> {
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 16 * 1024];
    let head_end = loop {
        if let Some(position) = find(&buffer, b"\r\n\r\n") {
            break position;
        }
        if buffer.len() > MAX_HEAD {
            return Err("request head too large".to_owned());
        }
        let read = stream.read(&mut chunk).map_err(|error| error.to_string())?;
        if read == 0 {
            return Err("connection closed before the end of the head".to_owned());
        }
        buffer.extend_from_slice(chunk.get(..read).ok_or("short read")?);
    };
    let head = String::from_utf8_lossy(buffer.get(..head_end).ok_or("bad head")?).into_owned();
    let mut lines = head.split("\r\n");
    let request_line = lines.next().ok_or("empty request")?;
    let mut parts = request_line.split(' ');
    let method = parts.next().ok_or("no method")?.to_owned();
    let target = parts.next().ok_or("no target")?.to_owned();
    let headers: Vec<(String, String)> = lines
        .filter_map(|line| line.split_once(':'))
        .map(|(name, value)| (name.trim().to_ascii_lowercase(), value.trim().to_owned()))
        .collect();
    let length: usize = headers
        .iter()
        .find(|(name, _)| name == "content-length")
        .map(|(_, value)| value.parse().map_err(|_| "bad content-length".to_owned()))
        .transpose()?
        .unwrap_or(0);
    if length > MAX_BODY {
        return Err("request body too large".to_owned());
    }
    let mut body = buffer.get(head_end + 4..).ok_or("bad body")?.to_vec();
    while body.len() < length {
        let read = stream.read(&mut chunk).map_err(|error| error.to_string())?;
        if read == 0 {
            return Err("connection closed before the end of the body".to_owned());
        }
        body.extend_from_slice(chunk.get(..read).ok_or("short read")?);
    }
    body.truncate(length);
    Ok(Request {
        method,
        target,
        headers,
        body,
    })
}

fn respond(
    stream: &mut TcpStream,
    status: &str,
    content_type: &str,
    extra: &[(&str, &str)],
    body: &[u8],
) -> Result<(), String> {
    let mut head = format!(
        "HTTP/1.1 {status}\r\ncontent-type: {content_type}\r\ncontent-length: {}\r\ncache-control: no-store\r\nx-content-type-options: nosniff\r\nconnection: close\r\n",
        body.len()
    );
    for (name, value) in extra {
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    head.push_str("\r\n");
    stream
        .write_all(head.as_bytes())
        .and_then(|()| stream.write_all(body))
        .map_err(|error| error.to_string())
}

fn percent_decode(encoded: &str) -> Result<String, String> {
    let bytes = encoded.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut position = 0;
    while let Some(&byte) = bytes.get(position) {
        if byte == b'%' {
            let pair = encoded
                .get(position + 1..position + 3)
                .ok_or("short percent escape")?;
            decoded.push(u8::from_str_radix(pair, 16).map_err(|_| "bad percent escape")?);
            position += 3;
        } else {
            decoded.push(byte);
            position += 1;
        }
    }
    String::from_utf8(decoded).map_err(|_| "escape is not UTF-8".to_owned())
}

fn content_type_of(name: &str) -> &'static str {
    match Path::new(name).extension().and_then(|ext| ext.to_str()) {
        Some("html") => "text/html; charset=utf-8",
        Some("js") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        _ => "application/octet-stream",
    }
}

fn serve_asset(stream: &mut TcpStream, shared: &Shared, target: &str) -> Result<(), String> {
    let path = target.split('?').next().unwrap_or("/");
    let name = match path {
        "/" => "index.html",
        other => other.trim_start_matches('/'),
    };
    // Flat files of the assets folder only: no separator, no hidden file.
    let allowed = !name.is_empty()
        && !name.starts_with('.')
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'));
    let file = shared.assets.join(name);
    match (allowed, fs::read(&file)) {
        (true, Ok(bytes)) => respond(
            stream,
            "200 OK",
            content_type_of(name),
            &[("content-security-policy", shared.csp.as_str())],
            &bytes,
        ),
        _ => respond(stream, "404 Not Found", "text/plain", &[], b"not found"),
    }
}

fn relay(stream: &mut TcpStream, shared: &Shared, request: Request) -> Result<(), String> {
    let command = percent_decode(
        request
            .target
            .strip_prefix("/ipc/")
            .ok_or("not an ipc target")?,
    )?;
    let is_json = request
        .headers
        .iter()
        .any(|(name, value)| name == "content-type" && value.starts_with("application/json"));
    let body = if is_json {
        InvokeBody::Json(serde_json::from_slice(&request.body).map_err(|e| e.to_string())?)
    } else {
        InvokeBody::Raw(request.body)
    };
    // The bridge reads headers with its own prefix only; the others are the transport's.
    let mut headers = HeaderMap::new();
    for (name, value) in &request.headers {
        if name.starts_with("x-vault-") {
            headers.insert(
                HeaderName::from_bytes(name.as_bytes()).map_err(|e| e.to_string())?,
                HeaderValue::from_str(value).map_err(|e| e.to_string())?,
            );
        }
    }
    let outcome = get_ipc_response(
        &shared.window,
        InvokeRequest {
            cmd: command,
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: "tauri://localhost"
                .parse()
                .map_err(|_| "bad url".to_owned())?,
            body,
            headers,
            invoke_key: INVOKE_KEY.to_string(),
        },
    );
    match outcome {
        Ok(InvokeResponseBody::Json(text)) => {
            respond(stream, "200 OK", "application/json", &[], text.as_bytes())
        }
        Ok(InvokeResponseBody::Raw(bytes)) => {
            respond(stream, "200 OK", "application/octet-stream", &[], &bytes)
        }
        Err(refusal) => respond(
            stream,
            "400 Bad Request",
            "application/json",
            &[],
            refusal.to_string().as_bytes(),
        ),
    }
}

fn handle(mut stream: TcpStream, shared: &Shared) -> Result<(), String> {
    let request = read_request(&mut stream)?;
    match request.method.as_str() {
        "GET" => serve_asset(&mut stream, shared, &request.target),
        "POST" if request.target.starts_with("/ipc/") => relay(&mut stream, shared, request),
        _ => respond(
            &mut stream,
            "405 Method Not Allowed",
            "text/plain",
            &[],
            b"method not allowed",
        ),
    }
}

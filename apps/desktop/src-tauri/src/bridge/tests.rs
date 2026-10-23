// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2

//! CA-39, bridge clause: every command answers with its declared type or a
//! closed `vault.*` refusal. The commands are invoked through the IPC of the
//! mock runtime with the real generated ACL (`build.rs`, `capabilities/`), so a
//! command passes only if the shell exposes it to the window `main`.
//!
//! Test names are prefixed `bridge_`: the validation filter of CA-39 is
//! `cargo test -p libre-ai-p04-desktop bridge`.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc;
use std::time::Duration;

use libre_ai_notebook_vault::{Revision, VaultError};
use serde_json::{Value, json};
use tauri::http::{HeaderMap, HeaderName, HeaderValue};
use tauri::ipc::{CallbackFn, InvokeBody, InvokeResponseBody};
use tauri::test::{INVOKE_KEY, MockRuntime, get_ipc_response, mock_builder};
use tauri::webview::InvokeRequest;
use tauri::{Listener, WebviewWindow, WebviewWindowBuilder};

use super::{BRIDGE_CODES, BridgeError, PATH_HEADER, REVISION_HEADER, VAULT_CHANGED, decode_path};
use crate::{context, with_commands};

static COUNTER: AtomicU32 = AtomicU32::new(0);

struct Scratch(PathBuf);

impl Scratch {
    fn new() -> Self {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let path = std::env::temp_dir().join(format!("bridge-test-{}-{n}", std::process::id()));
        fs::create_dir_all(&path).unwrap();
        // The vault resolves its root; use the resolved form so paths compare equal.
        Self(fs::canonicalize(path).unwrap())
    }

    fn text(&self) -> String {
        self.0.to_str().unwrap().to_owned()
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

struct Shell {
    app: tauri::App<MockRuntime>,
    main: WebviewWindow<MockRuntime>,
}

fn shell() -> Shell {
    let app = with_commands(mock_builder()).build(context()).unwrap();
    let main = WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    Shell { app, main }
}

#[derive(Debug)]
enum Reply {
    Json(Value),
    Raw(Vec<u8>),
}

impl Reply {
    fn json(self) -> Value {
        match self {
            Self::Json(value) => value,
            Self::Raw(bytes) => panic!("expected JSON, got {} raw bytes", bytes.len()),
        }
    }

    fn raw(self) -> Vec<u8> {
        match self {
            Self::Raw(bytes) => bytes,
            Self::Json(value) => panic!("expected raw bytes, got JSON {value}"),
        }
    }
}

fn call(
    window: &WebviewWindow<MockRuntime>,
    command: &str,
    body: InvokeBody,
    headers: &[(&str, &str)],
) -> Result<Reply, Value> {
    let mut map = HeaderMap::new();
    for (name, value) in headers {
        map.insert(
            HeaderName::from_bytes(name.as_bytes()).unwrap(),
            HeaderValue::from_str(value).unwrap(),
        );
    }
    let response = get_ipc_response(
        window,
        InvokeRequest {
            cmd: command.into(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: "tauri://localhost".parse().unwrap(),
            body,
            headers: map,
            invoke_key: INVOKE_KEY.to_string(),
        },
    )?;
    Ok(match response {
        InvokeResponseBody::Json(text) => Reply::Json(serde_json::from_str(&text).unwrap()),
        InvokeResponseBody::Raw(bytes) => Reply::Raw(bytes),
    })
}

fn json_call(
    window: &WebviewWindow<MockRuntime>,
    command: &str,
    args: Value,
) -> Result<Reply, Value> {
    call(window, command, InvokeBody::Json(args), &[])
}

fn write(
    window: &WebviewWindow<MockRuntime>,
    encoded_path: &str,
    revision: Option<&str>,
    bytes: &[u8],
) -> Result<Reply, Value> {
    let mut headers = vec![(PATH_HEADER, encoded_path)];
    if let Some(revision) = revision {
        headers.push((REVISION_HEADER, revision));
    }
    call(
        window,
        "write_note",
        InvokeBody::Raw(bytes.to_vec()),
        &headers,
    )
}

fn closed_codes() -> Vec<&'static str> {
    VaultError::CODES
        .iter()
        .chain(BRIDGE_CODES.iter())
        .copied()
        .collect()
}

#[test]
fn bridge_every_command_answers_with_its_declared_type() {
    let scratch = Scratch::new();
    let shell = shell();
    let window = &shell.main;
    let mut answered = 0;

    // The probe of the shell: the ACL serves a declared command at all.
    assert_eq!(
        json_call(window, "shell_ping", json!({})).unwrap().json(),
        json!("pong")
    );

    assert_eq!(
        json_call(window, "open_vault", json!({ "path": scratch.text() }))
            .unwrap()
            .json(),
        Value::Null
    );
    answered += 1;

    let written = write(window, "notes%2Fa.md", None, b"# Title\n\nalpha beta\n")
        .unwrap()
        .json();
    assert_eq!(written["path"], "notes/a.md");
    assert_eq!(
        written["revision"],
        Revision::of(b"# Title\n\nalpha beta\n").as_str()
    );
    answered += 1;

    let stats = json_call(window, "rebuild_index", json!({}))
        .unwrap()
        .json();
    assert_eq!(
        stats,
        json!({ "notes": 1, "ignored": 0, "unreadable": 0, "terms": 3 })
    );
    answered += 1;

    let hits = json_call(window, "search", json!({ "query": "alpha" }))
        .unwrap()
        .json();
    assert_eq!(hits, json!([{ "path": "notes/a.md", "score": 1 }]));
    answered += 1;

    let frame = json_call(window, "read_note", json!({ "path": "notes/a.md" }))
        .unwrap()
        .raw();
    assert_eq!(
        &frame[..Revision::LEN],
        Revision::of(b"# Title\n\nalpha beta\n").as_str().as_bytes()
    );
    assert_eq!(&frame[Revision::LEN..], b"# Title\n\nalpha beta\n");
    answered += 1;

    let tree = call(
        window,
        "render_preview",
        InvokeBody::Raw(b"# Title\n".to_vec()),
        &[],
    )
    .unwrap()
    .json();
    assert_eq!(tree["kind"], "document");
    assert_eq!(tree["children"][0]["kind"], "heading");
    answered += 1;

    println!("bridge: {answered} of 6 commands answered with their declared type");
    assert_eq!(answered, 6);
}

#[test]
fn bridge_read_note_returns_the_exact_bytes_of_every_trap() {
    let scratch = Scratch::new();
    let shell = shell();
    json_call(&shell.main, "open_vault", json!({ "path": scratch.text() })).unwrap();
    let traps: Vec<(&str, Vec<u8>)> = vec![
        ("crlf", b"a\r\nb\r\n".to_vec()),
        ("lone-cr", b"a\rb\r".to_vec()),
        ("bom", b"\xEF\xBB\xBF# t\n".to_vec()),
        ("tabs-trailing", b"\t- x  \n\t\t- y \t\n".to_vec()),
        ("no-final-newline", b"last".to_vec()),
        ("nfc", "caf\u{e9}\n".as_bytes().to_vec()),
        ("nfd", "cafe\u{301}\n".as_bytes().to_vec()),
        ("non-bmp", "\u{1F600}\u{10348}\n".as_bytes().to_vec()),
        ("empty", Vec::new()),
        ("not-utf8", vec![0xFF, 0xFE, 0x00, 0x80]),
        ("every-byte", (0..=255u8).collect()),
    ];
    for (name, bytes) in &traps {
        write(&shell.main, &format!("traps%2F{name}.md"), None, bytes).unwrap();
        let frame = json_call(
            &shell.main,
            "read_note",
            json!({ "path": format!("traps/{name}.md") }),
        )
        .unwrap()
        .raw();
        assert_eq!(
            &frame[..Revision::LEN],
            Revision::of(bytes).as_str().as_bytes(),
            "{name}"
        );
        assert_eq!(&frame[Revision::LEN..], bytes.as_slice(), "{name}");
        assert_eq!(
            fs::read(scratch.0.join(format!("traps/{name}.md"))).unwrap(),
            *bytes,
            "{name}"
        );
    }
    println!(
        "bridge: {} byte traps written and read back exactly through the IPC",
        traps.len()
    );
}

#[test]
fn bridge_a_rewrite_with_the_revision_that_was_read_replaces_the_note() {
    let scratch = Scratch::new();
    let shell = shell();
    let window = &shell.main;
    json_call(window, "open_vault", json!({ "path": scratch.text() })).unwrap();
    write(window, "a.md", None, b"one\r\n").unwrap();

    let frame = json_call(window, "read_note", json!({ "path": "a.md" }))
        .unwrap()
        .raw();
    let read = String::from_utf8(frame[..Revision::LEN].to_vec()).unwrap();
    let written = write(window, "a.md", Some(&read), b"two\r\n")
        .unwrap()
        .json();
    assert_eq!(written["revision"], Revision::of(b"two\r\n").as_str());
    assert_eq!(fs::read(scratch.0.join("a.md")).unwrap(), b"two\r\n");

    // The revision read before is now stale: a second writer holding it is refused.
    let stale = write(window, "a.md", Some(&read), b"three\r\n").unwrap_err();
    assert_eq!(stale, json!("vault.revision_conflict"));
    assert_eq!(fs::read(scratch.0.join("a.md")).unwrap(), b"two\r\n");
}

#[test]
fn bridge_a_one_mebibyte_note_crosses_the_ipc_as_raw_bytes() {
    let scratch = Scratch::new();
    let shell = shell();
    json_call(&shell.main, "open_vault", json!({ "path": scratch.text() })).unwrap();
    let body: Vec<u8> = (0..1_048_576u32)
        .map(|n| (n.wrapping_mul(2_654_435_761) >> 24) as u8)
        .collect();
    write(&shell.main, "large.md", None, &body).unwrap();
    let frame = json_call(&shell.main, "read_note", json!({ "path": "large.md" }))
        .unwrap()
        .raw();
    assert_eq!(frame.len(), Revision::LEN + body.len());
    assert_eq!(&frame[Revision::LEN..], body.as_slice());
}

#[test]
fn bridge_every_refusal_is_a_closed_vault_code() {
    let scratch = Scratch::new();
    let shell = shell();
    let window = &shell.main;
    let closed = closed_codes();
    let mut refusals = 0;
    let mut expect = |outcome: Result<Reply, Value>, code: &str, what: &str| {
        let error = outcome.err().unwrap_or_else(|| panic!("{what}: accepted"));
        assert_eq!(error, json!(code), "{what}");
        assert!(
            closed.contains(&code),
            "{what}: {code} is outside the closed list"
        );
        refusals += 1;
    };

    // Before any vault is open.
    expect(
        json_call(window, "read_note", json!({ "path": "a.md" })),
        "vault.not_open",
        "read",
    );
    expect(write(window, "a.md", None, b"x"), "vault.not_open", "write");
    expect(
        json_call(window, "search", json!({ "query": "x" })),
        "vault.not_open",
        "search",
    );
    expect(
        json_call(window, "rebuild_index", json!({})),
        "vault.not_open",
        "rebuild",
    );

    // open_vault.
    expect(
        json_call(window, "open_vault", json!({ "path": "relative/dir" })),
        "vault.invalid_vault",
        "relative",
    );
    expect(
        json_call(
            window,
            "open_vault",
            json!({ "path": scratch.0.join("absent").to_str().unwrap() }),
        ),
        "vault.invalid_vault",
        "absent",
    );
    json_call(window, "open_vault", json!({ "path": scratch.text() })).unwrap();

    // Malformed requests never reach Tauri's own free-text argument errors.
    expect(
        json_call(window, "read_note", json!({})),
        "vault.invalid_request",
        "missing key",
    );
    expect(
        json_call(window, "read_note", json!({ "path": 7 })),
        "vault.invalid_request",
        "wrong type",
    );
    expect(
        json_call(window, "read_note", json!({ "path": "a.md", "extra": 1 })),
        "vault.invalid_request",
        "unknown key",
    );
    expect(
        json_call(window, "open_vault", json!({ "folder": "/x" })),
        "vault.invalid_request",
        "misnamed key",
    );
    expect(
        json_call(window, "search", json!({ "q": "x" })),
        "vault.invalid_request",
        "search key",
    );
    expect(
        call(window, "read_note", InvokeBody::Raw(vec![1]), &[]),
        "vault.invalid_request",
        "raw to json",
    );
    expect(
        call(
            window,
            "write_note",
            InvokeBody::Json(json!({})),
            &[(PATH_HEADER, "a.md")],
        ),
        "vault.invalid_request",
        "json to raw",
    );
    expect(
        call(window, "write_note", InvokeBody::Raw(b"x".to_vec()), &[]),
        "vault.invalid_request",
        "no path header",
    );
    expect(
        write(window, "a%zz.md", None, b"x"),
        "vault.invalid_request",
        "bad escape",
    );
    expect(
        write(window, "a%2", None, b"x"),
        "vault.invalid_request",
        "short escape",
    );
    expect(
        write(window, "a%FF.md", None, b"x"),
        "vault.invalid_request",
        "escape is not UTF-8",
    );
    expect(
        call(
            window,
            "render_preview",
            InvokeBody::Json(json!("# t")),
            &[],
        ),
        "vault.invalid_request",
        "preview json",
    );

    // The vault's own refusals, through the bridge.
    expect(
        json_call(window, "read_note", json!({ "path": "absent.md" })),
        "vault.not_found",
        "absent note",
    );
    expect(
        json_call(window, "read_note", json!({ "path": "../up.md" })),
        "vault.invalid_path",
        "dot dot",
    );
    expect(
        write(window, "%2E%2E%2Fup.md", None, b"x"),
        "vault.invalid_path",
        "encoded dot dot",
    );
    expect(
        write(window, "a.md", Some("not-a-revision"), b"x"),
        "vault.invalid_revision",
        "revision",
    );
    write(window, "a.md", None, b"one").unwrap();
    expect(
        write(window, "a.md", None, b"two"),
        "vault.revision_conflict",
        "create over existing",
    );
    expect(
        write(
            window,
            "a.md",
            Some(Revision::of(b"other").as_str()),
            b"two",
        ),
        "vault.revision_conflict",
        "stale revision",
    );
    expect(
        call(
            window,
            "render_preview",
            InvokeBody::Raw(vec![0xFF, 0xFE]),
            &[],
        ),
        "vault.not_utf8",
        "not UTF-8",
    );
    expect(
        json_call(window, "search", json!({ "query": "one" })),
        "vault.index_missing",
        "no index",
    );
    json_call(window, "rebuild_index", json!({})).unwrap();
    expect(
        json_call(window, "search", json!({ "query": "!!!" })),
        "vault.invalid_query",
        "empty query",
    );

    assert_eq!(
        fs::read(scratch.0.join("a.md")).unwrap(),
        b"one",
        "a refusal changed a note"
    );
    println!("bridge: {refusals} refusals, every one a closed vault.* code");
    assert!(refusals >= 25);
}

#[test]
fn bridge_a_refusal_never_carries_a_path_or_free_text() {
    let scratch = Scratch::new();
    let shell = shell();
    json_call(&shell.main, "open_vault", json!({ "path": scratch.text() })).unwrap();
    let secret = "private-folder-name-9f3a";
    let error = json_call(
        &shell.main,
        "read_note",
        json!({ "path": format!("{secret}/x.md") }),
    )
    .err()
    .unwrap();
    let text = error.to_string();
    assert!(
        !text.contains(secret) && !text.contains(&scratch.text()),
        "{text}"
    );
    assert_eq!(error, json!("vault.not_found"));
}

#[test]
fn bridge_only_the_declared_commands_and_the_declared_window_are_served() {
    let shell = shell();
    let other = WebviewWindowBuilder::new(&shell.app, "other", Default::default())
        .build()
        .unwrap();
    let mut refused = 0;
    // A refusal by the ACL is a message of Tauri's, not a `vault.*` code: a
    // command the capability let through would answer with a code or a value,
    // whatever its arguments, so the code is what tells the two refusals apart.
    let by_acl = |outcome: Result<Reply, Value>, what: &str| {
        let error = outcome.err().unwrap_or_else(|| panic!("{what} served"));
        let text = error.as_str().unwrap_or_default().to_owned();
        assert!(
            !text.is_empty() && !text.starts_with("vault."),
            "{what} reached the bridge: {error}"
        );
        text
    };
    for command in [
        "open_vault",
        "read_note",
        "write_note",
        "render_preview",
        "search",
        "rebuild_index",
    ] {
        let from_other = call(
            &other,
            command,
            InvokeBody::Json(json!({})),
            &[(PATH_HEADER, "a.md")],
        );
        let text = by_acl(from_other, command);
        println!("bridge: {command} from window other: {text}");
        refused += 1;
    }
    for undeclared in [
        "delete_note",
        "plugin:fs|read_text_file",
        "plugin:shell|execute",
        "read_dir",
    ] {
        let outcome = call(&shell.main, undeclared, InvokeBody::Json(json!({})), &[]);
        by_acl(outcome, undeclared);
        refused += 1;
    }
    println!("bridge: {refused} refusals of undeclared commands or windows");
}

#[test]
fn bridge_a_successful_write_emits_vault_changed_with_the_path_and_revision() {
    let scratch = Scratch::new();
    let shell = shell();
    json_call(&shell.main, "open_vault", json!({ "path": scratch.text() })).unwrap();
    let (sender, receiver) = mpsc::channel();
    shell.app.listen(VAULT_CHANGED, move |event| {
        let _ = sender.send(event.payload().to_owned());
    });

    write(&shell.main, "x%2Fy.md", None, b"payload\n").unwrap();
    let payload: Value =
        serde_json::from_str(&receiver.recv_timeout(Duration::from_secs(5)).unwrap()).unwrap();
    assert_eq!(
        payload,
        json!({ "path": "x/y.md", "revision": Revision::of(b"payload\n").as_str() })
    );

    // A refused write emits nothing.
    assert!(write(&shell.main, "x%2Fy.md", None, b"again").is_err());
    assert!(receiver.recv_timeout(Duration::from_millis(300)).is_err());
}

#[test]
fn bridge_the_preview_of_hostile_markdown_has_no_markup() {
    let shell = shell();
    let hostile =
        "<script>alert(1)</script>\n\n[x](javascript:alert(1)) <img src=x onerror=alert(1)>\n";
    let reply = call(
        &shell.main,
        "render_preview",
        InvokeBody::Raw(hostile.as_bytes().to_vec()),
        &[],
    )
    .unwrap();
    let text = reply.json().to_string();
    assert!(!text.contains('<') && !text.contains('>'), "{text}");
    assert!(
        !text.contains("alert") && !text.contains("javascript"),
        "{text}"
    );
}

#[test]
fn bridge_decode_path_is_strict_and_utf8() {
    let accepted = [
        ("a.md", "a.md"),
        ("notes%2Fa.md", "notes/a.md"),
        ("%C3%A9t%C3%A9.md", "\u{e9}t\u{e9}.md"),
        ("cafe%CC%81.md", "cafe\u{301}.md"),
        ("%F0%9F%98%80.md", "\u{1F600}.md"),
        ("a%20b.md", "a b.md"),
        ("%2e%2E.md", "...md"),
    ];
    for (encoded, decoded) in accepted {
        assert_eq!(decode_path(encoded).as_deref(), Ok(decoded), "{encoded}");
    }
    for refused in ["%", "%2", "%zz", "%+1", "a%2G", "%C3", "%FF%FE", "%80"] {
        assert_eq!(
            decode_path(refused),
            Err(BridgeError::InvalidRequest),
            "{refused}"
        );
    }
}

/// The wire contract the front's client is written against, read by the Bun tests too.
const WIRE: &str = include_str!("../../../tests/bridge/wire.v1.json");

#[test]
fn bridge_the_shared_wire_contract_names_what_the_shell_implements() {
    let wire: Value = serde_json::from_str(WIRE).unwrap();
    assert_eq!(wire["headers"]["path"], PATH_HEADER);
    assert_eq!(wire["headers"]["revision"], REVISION_HEADER);
    assert_eq!(wire["event"], VAULT_CHANGED);
    assert_eq!(wire["readFramePrefixBytes"], Revision::LEN);
    assert_eq!(wire["refusalCodes"], json!(closed_codes()));

    // Every command of the contract is served on the window `main` (an unserved
    // command is refused by the ACL, not by the bridge): none answers with the
    // ACL's message.
    let shell = shell();
    for command in wire["commands"].as_array().unwrap() {
        let name = command.as_str().unwrap();
        let outcome = call(&shell.main, name, InvokeBody::Json(json!({})), &[]);
        let message = outcome.err().map(|e| e.to_string()).unwrap_or_default();
        assert!(!message.contains("not allowed"), "{name}: {message}");
    }
}

#[test]
fn bridge_error_codes_are_serialised_as_their_code_and_nothing_else() {
    let all = [
        BridgeError::NotOpen,
        BridgeError::InvalidRequest,
        BridgeError::Vault(VaultError::NotFound),
        BridgeError::Vault(VaultError::Io(std::io::ErrorKind::PermissionDenied)),
    ];
    for error in all {
        assert_eq!(serde_json::to_value(error).unwrap(), json!(error.code()));
        assert!(error.code().starts_with("vault."));
    }
    assert_eq!(closed_codes().len(), 12);
}

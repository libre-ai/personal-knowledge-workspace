// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2

//! CA-39, bridge clause: every command answers with its declared type or a
//! closed `vault.*` refusal. The commands are invoked through the IPC of the
//! mock runtime with the real generated ACL (`build.rs`, `capabilities/`), so a
//! command passes only if the shell exposes it to the window `main`.
//!
//! CA-47: the front never names the folder of the vault. The root comes from a
//! picker on the Rust side (`RootPicker`), which the tests replace by a stub
//! (a native dialog cannot be automated), and the guard of the vault crate
//! judges whatever the picker returns.
//!
//! Test names are prefixed `bridge_`: the validation filter of CA-39 and CA-47
//! is `cargo test -p libre-ai-p04-desktop bridge`.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::time::Duration;

use libre_ai_notebook_vault::{Revision, RootPolicy, SYSTEM_DIRS, VaultError};
use serde_json::{Value, json};
use tauri::http::{HeaderMap, HeaderName, HeaderValue};
use tauri::ipc::{CallbackFn, InvokeBody, InvokeResponseBody};
use tauri::test::{INVOKE_KEY, MockRuntime, get_ipc_response, mock_builder};
use tauri::webview::InvokeRequest;
use tauri::{Listener, WebviewWindow, WebviewWindowBuilder};

use super::{
    BRIDGE_CODES, BridgeError, NativePicker, PATH_HEADER, REVISION_HEADER, RootPicker,
    VAULT_CHANGED, VaultState, decode_path,
};
use crate::{context, with_vault_state};

static COUNTER: AtomicU32 = AtomicU32::new(0);

/// The picker of a test: answers what it was told to and counts how often it was asked.
#[derive(Clone, Default)]
struct Picked(Arc<PickedInner>);

#[derive(Default)]
struct PickedInner {
    answer: Mutex<Option<PathBuf>>,
    asked: AtomicUsize,
}

impl Picked {
    fn answering(folder: &Path) -> Self {
        let picked = Self::default();
        picked.answer_with(Some(folder.to_path_buf()));
        picked
    }

    fn answer_with(&self, folder: Option<PathBuf>) {
        *self.0.answer.lock().unwrap() = folder;
    }

    fn asked(&self) -> usize {
        self.0.asked.load(Ordering::SeqCst)
    }
}

impl RootPicker for Picked {
    fn pick_folder(&self) -> Option<PathBuf> {
        self.0.asked.fetch_add(1, Ordering::SeqCst);
        self.0.answer.lock().unwrap().clone()
    }
}

/// A vault inside a stand-in home folder, removed on drop. The home folder is
/// the one the guard on roots judges against: no test reads the `$HOME` of
/// whoever runs it.
struct Scratch {
    base: PathBuf,
    home: PathBuf,
    vault: PathBuf,
}

impl Scratch {
    fn new() -> Self {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let base = std::env::temp_dir().join(format!("bridge-test-{}-{n}", std::process::id()));
        let home = base.join("home");
        let vault = home.join("vault");
        fs::create_dir_all(&vault).unwrap();
        // The vault resolves its root; use the resolved form so paths compare equal.
        Self {
            base,
            home: fs::canonicalize(home).unwrap(),
            vault: fs::canonicalize(vault).unwrap(),
        }
    }

    fn text(&self) -> String {
        self.vault.to_str().unwrap().to_owned()
    }

    /// The policy of the stand-in home folder, without system directories: the
    /// stand-in lives in the temporary directory of the machine, which is a
    /// system directory by the very list under test. The system directories
    /// are exercised by `bridge_choose_vault_refuses_the_system_directories`.
    fn policy(&self) -> RootPolicy {
        RootPolicy::new(&self.home, &[]).unwrap()
    }

    /// A state whose picker answers the vault of the stand-in home folder.
    fn state(&self) -> VaultState {
        VaultState::with_picker(Some(self.policy()), Picked::answering(&self.vault))
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.base);
    }
}

struct Shell {
    app: tauri::App<MockRuntime>,
    main: WebviewWindow<MockRuntime>,
}

/// A shell whose picker is dismissed at once and whose guard judges roots
/// against the home folder of the process. For the tests that open no vault.
fn shell() -> Shell {
    shell_with(VaultState::with_picker(
        RootPolicy::current_user().ok(),
        Picked::default(),
    ))
}

/// A shell whose bridge judges roots against the stand-in home folder of `scratch`.
fn shell_in(scratch: &Scratch) -> Shell {
    shell_with(scratch.state())
}

fn shell_with(state: VaultState) -> Shell {
    let app = with_vault_state(mock_builder(), state)
        .build(context())
        .unwrap();
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

/// `choose_vault`: no argument, the folder comes from the picker.
fn choose(window: &WebviewWindow<MockRuntime>) -> Result<Reply, Value> {
    json_call(window, "choose_vault", json!({}))
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
    let shell = shell_in(&scratch);
    let window = &shell.main;
    let mut answered = 0;

    // The probe of the shell: the ACL serves a declared command at all.
    assert_eq!(
        json_call(window, "shell_ping", json!({})).unwrap().json(),
        json!("pong")
    );

    assert_eq!(choose(window).unwrap().json(), Value::Null);
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
    let shell = shell_in(&scratch);
    choose(&shell.main).unwrap();
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
            fs::read(scratch.vault.join(format!("traps/{name}.md"))).unwrap(),
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
    let shell = shell_in(&scratch);
    let window = &shell.main;
    choose(window).unwrap();
    write(window, "a.md", None, b"one\r\n").unwrap();

    let frame = json_call(window, "read_note", json!({ "path": "a.md" }))
        .unwrap()
        .raw();
    let read = String::from_utf8(frame[..Revision::LEN].to_vec()).unwrap();
    let written = write(window, "a.md", Some(&read), b"two\r\n")
        .unwrap()
        .json();
    assert_eq!(written["revision"], Revision::of(b"two\r\n").as_str());
    assert_eq!(fs::read(scratch.vault.join("a.md")).unwrap(), b"two\r\n");

    // The revision read before is now stale: a second writer holding it is refused.
    let stale = write(window, "a.md", Some(&read), b"three\r\n").unwrap_err();
    assert_eq!(stale, json!("vault.revision_conflict"));
    assert_eq!(fs::read(scratch.vault.join("a.md")).unwrap(), b"two\r\n");
}

#[test]
fn bridge_a_one_mebibyte_note_crosses_the_ipc_as_raw_bytes() {
    let scratch = Scratch::new();
    let shell = shell_in(&scratch);
    choose(&shell.main).unwrap();
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
    let shell = shell_in(&scratch);
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
    expect(
        call(
            window,
            "render_preview",
            InvokeBody::Raw(b"# t".to_vec()),
            &[],
        ),
        "vault.not_open",
        "preview",
    );

    // choose_vault takes no argument at all (CA-47).
    expect(
        json_call(window, "choose_vault", json!({ "path": "/x" })),
        "vault.invalid_request",
        "choose_vault with a root",
    );
    expect(
        call(window, "choose_vault", InvokeBody::Raw(vec![1]), &[]),
        "vault.invalid_request",
        "choose_vault with a raw body",
    );
    choose(window).unwrap();
    expect(choose(window), "vault.already_open", "second choice");

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
        json_call(window, "search", json!({ "q": "x" })),
        "vault.invalid_request",
        "search key",
    );
    expect(
        json_call(window, "rebuild_index", json!({ "extra": 1 })),
        "vault.invalid_request",
        "rebuild with an argument",
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
        fs::read(scratch.vault.join("a.md")).unwrap(),
        b"one",
        "a refusal changed a note"
    );
    println!("bridge: {refusals} refusals, every one a closed vault.* code");
    assert!(refusals >= 25);
}

#[test]
fn bridge_a_refusal_never_carries_a_path_or_free_text() {
    let scratch = Scratch::new();
    let shell = shell_in(&scratch);
    choose(&shell.main).unwrap();
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
        "choose_vault",
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
        // The command that took a root from the front is gone, not merely refused.
        "open_vault",
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
    let shell = shell_in(&scratch);
    choose(&shell.main).unwrap();
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
    let scratch = Scratch::new();
    let shell = shell_in(&scratch);
    choose(&shell.main).unwrap();
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
        BridgeError::AlreadyOpen,
        BridgeError::Vault(VaultError::NotFound),
        BridgeError::Vault(VaultError::Io(std::io::ErrorKind::PermissionDenied)),
    ];
    for error in all {
        assert_eq!(serde_json::to_value(error).unwrap(), json!(error.code()));
        assert!(error.code().starts_with("vault."));
    }
    assert_eq!(closed_codes().len(), 13);
}

/// The refusal of `choose_vault` when the picker returns `path`: the closed code
/// of an invalid vault, no vault left open, and the single choice of the session
/// not consumed (the picker is consulted again by the next call).
fn assert_choice_refused(shell: &Shell, picked: &Picked, path: &str, what: &str) {
    let before = picked.asked();
    picked.answer_with(Some(PathBuf::from(path)));
    let outcome = choose(&shell.main);
    assert_eq!(
        outcome.err(),
        Some(json!("vault.invalid_vault")),
        "{what}: {path}"
    );
    assert_eq!(
        picked.asked(),
        before + 1,
        "{what}: the picker was not asked"
    );
    let after = json_call(&shell.main, "read_note", json!({ "path": "a.md" }));
    assert_eq!(
        after.err(),
        Some(json!("vault.not_open")),
        "{what}: a refused choice left a vault open"
    );
}

/// A shell whose picker is `picked`, judged by `policy`.
fn shell_picking(policy: Option<RootPolicy>, picked: &Picked) -> Shell {
    shell_with(VaultState::with_picker(policy, picked.clone()))
}

#[cfg(unix)]
#[test]
fn bridge_choose_vault_refuses_the_roots_the_guard_names() {
    use std::os::unix::fs::symlink;

    let scratch = Scratch::new();
    let home = &scratch.home;
    fs::create_dir_all(home.join(".ssh")).unwrap();
    fs::create_dir_all(home.join("Library/Application Support")).unwrap();
    fs::create_dir_all(scratch.base.join("elsewhere")).unwrap();
    symlink("/", home.join("link-to-root")).unwrap();
    symlink("/etc", home.join("link-to-etc")).unwrap();
    let text = |path: PathBuf| path.to_str().unwrap().to_owned();
    let hostile = [
        ("the disk root", "/".to_owned()),
        ("/private/etc", "/private/etc".to_owned()),
        ("a link to the disk root", text(home.join("link-to-root"))),
        ("a link to /etc", text(home.join("link-to-etc"))),
        ("the home folder itself", text(home.clone())),
        ("~/.ssh", text(home.join(".ssh"))),
        ("~/Library", text(home.join("Library"))),
        (
            "~/Library/Application Support",
            text(home.join("Library/Application Support")),
        ),
        (
            "a path with ..",
            text(home.join("vault").join("..").join(".ssh")),
        ),
        (
            "a path with .. entered outside the home folder",
            text(scratch.base.join("elsewhere/../home/vault")),
        ),
        ("a folder that does not exist", text(home.join("absent"))),
    ];
    // One shell and one picker for all the roots: a refusal must leave the
    // session able to choose again, which `assert_choice_refused` checks.
    let picked = Picked::default();
    let shell = shell_picking(Some(scratch.policy()), &picked);
    for (what, path) in &hostile {
        assert_choice_refused(&shell, &picked, path, what);
    }
    println!(
        "bridge: {} hostile roots refused by choose_vault",
        hostile.len()
    );

    // The legitimate root is then chosen through the same command.
    picked.answer_with(Some(scratch.vault.clone()));
    assert_eq!(choose(&shell.main).unwrap().json(), Value::Null);
}

#[test]
fn bridge_choose_vault_refuses_the_system_directories() {
    // A home folder that is the disk root contains every system directory, so
    // only the system-directory rule can refuse them.
    let picked = Picked::default();
    let shell = shell_picking(
        Some(RootPolicy::new(Path::new("/"), &SYSTEM_DIRS).unwrap()),
        &picked,
    );
    let mut refused = 0;
    for directory in SYSTEM_DIRS {
        if !Path::new(directory).is_dir() {
            continue;
        }
        assert_choice_refused(&shell, &picked, directory, "a system directory");
        refused += 1;
    }
    assert!(refused >= 6, "only {refused} system directories exist here");
    println!("bridge: {refused} system directories refused by choose_vault");
}

#[test]
fn bridge_without_a_home_folder_every_root_is_refused() {
    let scratch = Scratch::new();
    let picked = Picked::default();
    let shell = shell_picking(None, &picked);
    assert_choice_refused(
        &shell,
        &picked,
        &scratch.text(),
        "no home folder to judge against",
    );
}

#[test]
fn bridge_the_guard_of_the_application_judges_against_the_home_folder_of_the_process() {
    let picked = Picked::default();
    let shell = shell_picking(RootPolicy::current_user().ok(), &picked);
    assert_choice_refused(&shell, &picked, "/", "the disk root");
    if let Some(home) = std::env::home_dir() {
        assert_choice_refused(
            &shell,
            &picked,
            home.to_str().unwrap(),
            "the home folder itself",
        );
    }
    // The application's own state exists and is built without opening a dialog.
    let _native = VaultState::native();
    let _picker = NativePicker;
}

#[test]
fn bridge_a_dismissed_picker_leaves_no_vault_and_the_choice_open() {
    let scratch = Scratch::new();
    let picked = Picked::default();
    let shell = shell_picking(Some(scratch.policy()), &picked);

    assert_eq!(
        choose(&shell.main).err(),
        Some(json!("vault.not_open")),
        "a dismissed dialog"
    );
    assert_eq!(picked.asked(), 1);
    assert_eq!(
        json_call(&shell.main, "search", json!({ "query": "x" })).err(),
        Some(json!("vault.not_open"))
    );

    picked.answer_with(Some(scratch.vault.clone()));
    assert_eq!(choose(&shell.main).unwrap().json(), Value::Null);
    assert_eq!(picked.asked(), 2);
}

/// Names a front could give to a folder it wants the vault to open or read from.
const ROOT_KEYS: [&str; 9] = [
    "root",
    "vault",
    "vaultPath",
    "vault_path",
    "folder",
    "directory",
    "dir",
    "base",
    "cwd",
];

#[test]
fn bridge_no_command_accepts_a_root_from_the_front() {
    let scratch = Scratch::new();
    // A folder the guard would admit (below the stand-in home folder) and that
    // the front names in every payload it can build.
    let attacker = scratch.home.join("attacker-vault");
    fs::create_dir_all(&attacker).unwrap();
    fs::write(attacker.join("secret.md"), b"the attacker's note").unwrap();
    let named = attacker.to_str().unwrap();
    let shell = shell_in(&scratch);
    let window = &shell.main;
    let mut refused = 0;
    let mut expect_invalid = |outcome: Result<Reply, Value>, what: &str| {
        let error = outcome.err().unwrap_or_else(|| panic!("{what}: accepted"));
        assert_eq!(error, json!("vault.invalid_request"), "{what}");
        refused += 1;
    };

    // Before the root is chosen and after: the payload is judged first.
    for chosen in [false, true] {
        if chosen {
            choose(window).unwrap();
        }
        let state = if chosen { "after" } else { "before" };
        for key in ROOT_KEYS.iter().copied().chain(["path"]) {
            expect_invalid(
                json_call(window, "choose_vault", json!({ key: named })),
                &format!("{state}: choose_vault {key}"),
            );
            expect_invalid(
                json_call(window, "rebuild_index", json!({ key: named })),
                &format!("{state}: rebuild_index {key}"),
            );
            expect_invalid(
                json_call(window, "search", json!({ "query": "x", key: named })),
                &format!("{state}: search {key}"),
            );
            expect_invalid(
                json_call(window, "render_preview", json!({ key: named })),
                &format!("{state}: render_preview {key}"),
            );
            if key != "path" {
                expect_invalid(
                    json_call(
                        window,
                        "read_note",
                        json!({ "path": "secret.md", key: named }),
                    ),
                    &format!("{state}: read_note {key}"),
                );
            }
        }
        for header in ["x-vault-root", "x-vault-folder", "x-vault-vault"] {
            expect_invalid(
                call(
                    window,
                    "write_note",
                    InvokeBody::Raw(b"x".to_vec()),
                    &[(PATH_HEADER, "a.md"), (header, named)],
                ),
                &format!("{state}: write_note {header}"),
            );
        }
        // The folder as the note path: a root is not a note.
        let absolute = format!("{named}/secret.md");
        let outcome = json_call(window, "read_note", json!({ "path": absolute }));
        assert_eq!(
            outcome.err(),
            Some(json!(if chosen {
                "vault.invalid_path"
            } else {
                "vault.not_open"
            })),
            "{state}: read_note with an absolute path"
        );
    }

    // Nothing the front named took effect: the root is the one the picker gave,
    // the attacker's folder was neither read nor written.
    write(window, "mine.md", None, b"mine").unwrap();
    assert_eq!(fs::read(scratch.vault.join("mine.md")).unwrap(), b"mine");
    assert_eq!(
        fs::read_dir(&attacker).unwrap().count(),
        1,
        "something was written below the folder the front named"
    );
    assert_eq!(
        fs::read(attacker.join("secret.md")).unwrap(),
        b"the attacker's note"
    );
    assert_eq!(
        json_call(window, "read_note", json!({ "path": "secret.md" })).err(),
        Some(json!("vault.not_found")),
        "the note of the folder the front named is visible"
    );
    println!("bridge: {refused} payloads naming a root refused with a closed vault.* code");
    assert!(refused >= 100);
}

#[test]
fn bridge_the_chosen_root_does_not_change_during_the_session() {
    let scratch = Scratch::new();
    let other = scratch.home.join("other-vault");
    fs::create_dir_all(&other).unwrap();
    let picked = Picked::answering(&scratch.vault);
    let shell = shell_picking(Some(scratch.policy()), &picked);
    let window = &shell.main;

    choose(window).unwrap();
    write(window, "first.md", None, b"first").unwrap();

    // The picker would now answer another folder; it is not even asked.
    picked.answer_with(Some(other.clone()));
    for _ in 0..3 {
        assert_eq!(
            choose(window).err(),
            Some(json!("vault.already_open")),
            "a second choice"
        );
    }
    assert_eq!(picked.asked(), 1, "the picker was asked again");
    write(window, "second.md", None, b"second").unwrap();
    assert_eq!(
        fs::read(scratch.vault.join("second.md")).unwrap(),
        b"second",
        "a later write left the first root"
    );
    assert_eq!(fs::read_dir(&other).unwrap().count(), 0);
}

#[test]
fn bridge_two_choices_at_once_open_one_dialog() {
    let scratch = Scratch::new();
    let (entered_sender, entered) = mpsc::channel::<()>();
    let (release, released) = mpsc::channel::<()>();
    let entered_sender = Mutex::new(entered_sender);
    let released = Mutex::new(released);
    let vault = scratch.vault.clone();
    let asked = Arc::new(AtomicUsize::new(0));
    let counted = Arc::clone(&asked);
    let picker = move || {
        counted.fetch_add(1, Ordering::SeqCst);
        entered_sender.lock().unwrap().send(()).unwrap();
        released.lock().unwrap().recv().unwrap();
        Some(vault.clone())
    };
    let shell = shell_with(VaultState::with_picker(Some(scratch.policy()), picker));

    let window = shell.main.clone();
    let first = std::thread::spawn(move || choose(&window).map(|reply| reply.json()));
    entered.recv_timeout(Duration::from_secs(5)).unwrap();

    // The first dialog is on screen: a second call opens none.
    assert_eq!(
        choose(&shell.main).err(),
        Some(json!("vault.already_open")),
        "a choice while a dialog is open"
    );
    assert_eq!(
        json_call(&shell.main, "search", json!({ "query": "x" })).err(),
        Some(json!("vault.not_open")),
        "a command while the dialog is open"
    );
    release.send(()).unwrap();
    assert_eq!(first.join().unwrap().unwrap(), Value::Null);
    assert_eq!(asked.load(Ordering::SeqCst), 1);
}

/// Whether the ACL of the shell refused `command` for the window `main`, as
/// opposed to the command having run (whatever it then answered).
fn refused_by_the_acl(shell: &Shell, command: &str, args: Value) -> bool {
    call(&shell.main, command, InvokeBody::Json(args), &[])
        .err()
        .is_some_and(|error| error.to_string().contains("not allowed"))
}

#[test]
fn bridge_the_front_may_listen_to_events_and_do_nothing_else_with_them() {
    let shell = shell();
    let listen = json!({ "event": VAULT_CHANGED, "target": { "kind": "Any" }, "handler": 0 });
    assert!(
        !refused_by_the_acl(&shell, "plugin:event|listen", listen),
        "listen is refused by the ACL: the front cannot hear vault_changed"
    );
    let mut refused = 0;
    for (command, args) in [
        (
            "plugin:event|emit",
            json!({ "event": VAULT_CHANGED, "payload": null }),
        ),
        (
            "plugin:event|emit_to",
            json!({ "target": { "kind": "Any" }, "event": VAULT_CHANGED, "payload": null }),
        ),
        (
            "plugin:event|unlisten",
            json!({ "event": VAULT_CHANGED, "eventId": 0 }),
        ),
        ("plugin:window|close", json!({ "label": "main" })),
        ("plugin:webview|webview_close", json!({ "label": "main" })),
    ] {
        assert!(
            refused_by_the_acl(&shell, command, args),
            "{command} is not refused by the ACL"
        );
        refused += 1;
    }
    println!(
        "bridge: event listen served, {refused} other event, window or webview commands refused"
    );
}

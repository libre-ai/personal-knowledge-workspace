// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2

//! The bridge between the front and the vault core (EF-P04-9, CA-39): six
//! commands that carry the calls of the front to `libre-ai-notebook-vault` and
//! nothing of their own. The front reimplements none of them (CA-40).
//!
//! Wire contract, mirrored by `apps/desktop/src/bridge/`:
//!
//! | command | request | response |
//! | --- | --- | --- |
//! | `choose_vault` | none: the folder is picked on this side, see [`RootPicker`] | `null` |
//! | `read_note` | JSON `{ path }` | raw: 64 ASCII hex digits (revision), then the exact bytes of the file |
//! | `write_note` | raw body = the exact bytes; header `x-vault-path` (percent-encoded UTF-8), optional header `x-vault-revision` | JSON `{ path, revision }` |
//! | `render_preview` | raw body = the Markdown, UTF-8 | JSON attribute tree (`PreviewNode`) |
//! | `search` | JSON `{ query }` | JSON `[ { path, score } ]` |
//! | `rebuild_index` | none | JSON `{ notes, ignored, unreadable, terms }` |
//!
//! Note bytes travel raw, not as a JSON array of numbers: a 1 MiB note would
//! cost a million-element array in each direction (NFR-03). A refusal is the
//! JSON string of a closed `vault.*` code and nothing else: no path, no
//! operating-system message. A successful write emits `vault_changed` with the
//! path and the new revision.
//!
//! CA-47: no command receives a folder from the front. The root of the vault
//! is the answer of a native folder picker, kept by the process for the rest
//! of the session; every command works on that root alone and refuses
//! (`vault.not_open`) until it exists. A payload carries only the fields its
//! command declares: any other field, a root among them, and any `x-vault-*`
//! header the command does not read, is `vault.invalid_request`.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use libre_ai_notebook_vault::{
    IndexStats, PreviewNode, Revision, RootPolicy, SearchHit, Vault, VaultError,
    render_preview as render_markdown,
};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize, Serializer};
use serde_json::Value;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, Emitter, Runtime, State};

/// Event emitted after a successful `write_note`.
pub const VAULT_CHANGED: &str = "vault_changed";
/// Header carrying the percent-encoded note path of a `write_note`.
pub const PATH_HEADER: &str = "x-vault-path";
/// Header carrying the revision a `write_note` expects; absent to create a note.
pub const REVISION_HEADER: &str = "x-vault-revision";
/// Every header the bridge reads carries this prefix; a header with it that a
/// command does not read is refused rather than ignored (CA-47).
const BRIDGE_HEADER_PREFIX: &str = "x-vault-";

/// Codes the bridge adds to those of the vault.
pub const BRIDGE_CODES: [&str; 3] = [
    "vault.not_open",
    "vault.invalid_request",
    "vault.already_open",
];

/// The refusal of a command. It serialises as its code, a `vault.*` string.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BridgeError {
    /// A command that needs a vault ran before `choose_vault` gave one, or
    /// the folder dialog was dismissed.
    NotOpen,
    /// The request is not shaped as the contract above says (body, header, a field it does not declare).
    InvalidRequest,
    /// `choose_vault` ran after the root was chosen, or while its dialog is
    /// on screen: the root does not change during the session.
    AlreadyOpen,
    Vault(VaultError),
}

impl BridgeError {
    pub fn code(self) -> &'static str {
        match self {
            Self::NotOpen => BRIDGE_CODES[0],
            Self::InvalidRequest => BRIDGE_CODES[1],
            Self::AlreadyOpen => BRIDGE_CODES[2],
            Self::Vault(error) => error.code(),
        }
    }
}

impl From<VaultError> for BridgeError {
    fn from(error: VaultError) -> Self {
        Self::Vault(error)
    }
}

impl Serialize for BridgeError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.code())
    }
}

/// Where a root comes from: the one place a folder enters the process (CA-47).
/// The application uses [`NativePicker`]; a native dialog cannot be automated,
/// so the tests and the e2e harness inject their own, which is how the root is
/// injectable. Whatever the picker returns is judged by the guard of the vault
/// crate before it becomes the root.
pub trait RootPicker: Send + Sync + 'static {
    /// Blocks until the user chose a folder; `None` when the dialog is
    /// dismissed or there is none to show. Called off the main thread.
    fn pick_folder(&self) -> Option<PathBuf>;
}

impl<F> RootPicker for F
where
    F: Fn() -> Option<PathBuf> + Send + Sync + 'static,
{
    fn pick_folder(&self) -> Option<PathBuf> {
        self()
    }
}

/// The native folder dialog of macOS (`NSOpenPanel` through `rfd`), called from
/// Rust only: the front holds no dialog right and the shell registers no
/// plugin. `rfd` runs the panel on the main thread whatever thread asks
/// (`dispatch2::run_on_main`), so the blocking worker that calls this does not
/// need to be the main one. Off macOS the shell has no picker and offers none.
pub struct NativePicker;

impl RootPicker for NativePicker {
    #[cfg(target_os = "macos")]
    fn pick_folder(&self) -> Option<PathBuf> {
        rfd::FileDialog::new()
            .set_title("Choose the folder of your notes")
            .pick_folder()
    }

    #[cfg(not(target_os = "macos"))]
    fn pick_folder(&self) -> Option<PathBuf> {
        None
    }
}

/// The three moments of the root in a session. It only goes forward: nothing
/// returns from `Open` to another state, and `Choosing` returns to `Empty`
/// only when the dialog gave nothing the guard admits.
enum Slot {
    Empty,
    /// The dialog is on screen: a second `choose_vault` opens no second one.
    Choosing,
    Open(Arc<Vault>),
}

/// The root of the session, once chosen. It holds the guard on the roots the
/// picker may return, built on the Rust side from the home folder of the
/// process: no command receives the home folder, the policy or a root from the
/// front. The guard is a rail; the boundary is that the front never names the
/// folder (CA-47): the user does, in a dialog the front cannot drive.
pub struct VaultState {
    slot: Mutex<Slot>,
    /// `None` when the home folder of the process cannot be determined: the
    /// guard has nothing to judge against and `choose_vault` refuses every root.
    policy: Option<RootPolicy>,
    picker: Arc<dyn RootPicker>,
}

impl VaultState {
    /// The state of the application: roots judged against the user's home
    /// folder, chosen in the native dialog.
    pub fn native() -> Self {
        Self::with_picker(RootPolicy::current_user().ok(), NativePicker)
    }

    /// A state judging roots against `policy` and taking them from `picker`.
    /// The tests and the e2e harness use it to give the guard a home folder of
    /// their own and to answer the dialog; the front cannot reach it, it is not
    /// a command.
    pub fn with_picker(policy: Option<RootPolicy>, picker: impl RootPicker) -> Self {
        Self {
            slot: Mutex::new(Slot::Empty),
            policy,
            picker: Arc::new(picker),
        }
    }

    fn current(&self) -> Result<Arc<Vault>, BridgeError> {
        match &*self.slot.lock().map_err(|_| other_io())? {
            Slot::Open(vault) => Ok(Arc::clone(vault)),
            Slot::Empty | Slot::Choosing => Err(BridgeError::NotOpen),
        }
    }

    /// `Empty` to `Choosing`; any other state is a root already chosen, or a dialog already open.
    fn begin_choice(&self) -> Result<(), BridgeError> {
        let mut slot = self.slot.lock().map_err(|_| other_io())?;
        match *slot {
            Slot::Empty => {
                *slot = Slot::Choosing;
                Ok(())
            }
            Slot::Choosing | Slot::Open(_) => Err(BridgeError::AlreadyOpen),
        }
    }

    /// Ends a choice: the vault becomes the root, or nothing was chosen and the session may choose again.
    fn settle(&self, vault: Option<Vault>) -> Result<(), BridgeError> {
        let mut slot = self.slot.lock().map_err(|_| other_io())?;
        *slot = match vault {
            Some(vault) => Slot::Open(Arc::new(vault)),
            None => Slot::Empty,
        };
        Ok(())
    }
}

fn other_io() -> BridgeError {
    BridgeError::Vault(VaultError::Io(std::io::ErrorKind::Other))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Written {
    pub path: String,
    pub revision: Revision,
}

/// Runs vault work off the main thread: a read, a scan or a parse of a large
/// note must not freeze the window.
async fn blocking<T, F>(work: F) -> Result<T, BridgeError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, VaultError> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|_| other_io())?
        .map_err(BridgeError::from)
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

/// Decodes the percent-encoded UTF-8 of the path header. Strict: a `%` must be
/// followed by two hexadecimal digits and the result must be valid UTF-8.
pub(crate) fn decode_path(encoded: &str) -> Result<String, BridgeError> {
    let bytes = encoded.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut position = 0;
    while let Some(&byte) = bytes.get(position) {
        if byte == b'%' {
            let high = bytes.get(position + 1).copied().and_then(hex_value);
            let low = bytes.get(position + 2).copied().and_then(hex_value);
            let (Some(high), Some(low)) = (high, low) else {
                return Err(BridgeError::InvalidRequest);
            };
            decoded.push(high << 4 | low);
            position += 3;
        } else {
            decoded.push(byte);
            position += 1;
        }
    }
    String::from_utf8(decoded).map_err(|_| BridgeError::InvalidRequest)
}

fn header<'a>(request: &'a Request<'_>, name: &str) -> Result<Option<&'a str>, BridgeError> {
    match request.headers().get(name) {
        None => Ok(None),
        Some(value) => value
            .to_str()
            .map(Some)
            .map_err(|_| BridgeError::InvalidRequest),
    }
}

fn raw_body<'a>(request: &'a Request<'_>) -> Result<&'a [u8], BridgeError> {
    match request.body() {
        InvokeBody::Raw(bytes) => Ok(bytes),
        InvokeBody::Json(_) => Err(BridgeError::InvalidRequest),
    }
}

/// The request carries no `x-vault-*` header beyond `allowed`. A header the
/// command does not read is not ignored: it may be a root the front tried to
/// hand over, and the refusal says so to the front's own tests (CA-47).
fn only_headers(request: &Request<'_>, allowed: &[&str]) -> Result<(), BridgeError> {
    let foreign = request.headers().keys().any(|name| {
        let name = name.as_str();
        name.starts_with(BRIDGE_HEADER_PREFIX) && !allowed.contains(&name)
    });
    if foreign {
        Err(BridgeError::InvalidRequest)
    } else {
        Ok(())
    }
}

/// A command without arguments receives none: `invoke(command)` sends `{}`, and
/// any field in it (a root, whatever its name) is refused.
fn no_payload(request: &Request<'_>) -> Result<(), BridgeError> {
    match request.body() {
        InvokeBody::Json(Value::Null) => Ok(()),
        InvokeBody::Json(Value::Object(fields)) if fields.is_empty() => Ok(()),
        InvokeBody::Json(_) | InvokeBody::Raw(_) => Err(BridgeError::InvalidRequest),
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PathArgs {
    path: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct QueryArgs {
    query: String,
}

/// The JSON arguments of a command, read from the request rather than bound by
/// Tauri: when Tauri binds a missing or misnamed key itself, it refuses with a
/// free-text message, and a refusal here is a closed code or nothing.
fn json_args<T: DeserializeOwned>(request: &Request<'_>) -> Result<T, BridgeError> {
    match request.body() {
        InvokeBody::Json(value) => {
            serde_json::from_value(value.clone()).map_err(|_| BridgeError::InvalidRequest)
        }
        InvokeBody::Raw(_) => Err(BridgeError::InvalidRequest),
    }
}

/// Opens the native dialog and makes the folder it returns the root of the
/// session. It takes no argument (CA-47), and it runs once: a root already
/// chosen, or a dialog already on screen, is `vault.already_open`. A dialog
/// dismissed is `vault.not_open`, a folder the guard refuses is
/// `vault.invalid_vault`; neither uses up the choice.
#[tauri::command]
pub async fn choose_vault(
    state: State<'_, VaultState>,
    request: Request<'_>,
) -> Result<(), BridgeError> {
    only_headers(&request, &[])?;
    no_payload(&request)?;
    state.begin_choice()?;
    // The blocking task outlives the borrow of `state`: it owns what it needs.
    let picker = Arc::clone(&state.picker);
    let guarded = state.policy.clone();
    let outcome = blocking(move || {
        let Some(folder) = picker.pick_folder() else {
            return Ok(None);
        };
        let policy = guarded.as_ref().ok_or(VaultError::InvalidVault)?;
        Vault::open_with(&folder, policy).map(Some)
    })
    .await;
    match outcome {
        Ok(Some(vault)) => state.settle(Some(vault)),
        Ok(None) => {
            state.settle(None)?;
            Err(BridgeError::NotOpen)
        }
        Err(refusal) => {
            state.settle(None)?;
            Err(refusal)
        }
    }
}

#[tauri::command]
pub async fn read_note(
    state: State<'_, VaultState>,
    request: Request<'_>,
) -> Result<Response, BridgeError> {
    only_headers(&request, &[])?;
    let PathArgs { path } = json_args(&request)?;
    let vault = state.current()?;
    let note = blocking(move || vault.read_note(&path)).await?;
    let mut frame = Vec::with_capacity(Revision::LEN + note.bytes.len());
    frame.extend_from_slice(note.revision.as_str().as_bytes());
    frame.extend_from_slice(&note.bytes);
    Ok(Response::new(frame))
}

#[tauri::command]
pub async fn write_note<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultState>,
    request: Request<'_>,
) -> Result<Written, BridgeError> {
    only_headers(&request, &[PATH_HEADER, REVISION_HEADER])?;
    let path = decode_path(header(&request, PATH_HEADER)?.ok_or(BridgeError::InvalidRequest)?)?;
    let expected = header(&request, REVISION_HEADER)?
        .map(Revision::parse)
        .transpose()?;
    let bytes = raw_body(&request)?.to_vec();
    let vault = state.current()?;
    let target = path.clone();
    let revision = blocking(move || vault.write_note(&target, &bytes, expected.as_ref())).await?;
    let written = Written { path, revision };
    // The write is done: a failed emit changes nothing on disk and has no one to tell.
    let _ = app.emit(VAULT_CHANGED, &written);
    Ok(written)
}

/// The preview needs no file of the vault, but it is a command of the bridge
/// and CA-47 says every one refuses until a root is chosen: the editor only
/// exists inside a vault.
#[tauri::command]
pub async fn render_preview(
    state: State<'_, VaultState>,
    request: Request<'_>,
) -> Result<PreviewNode, BridgeError> {
    only_headers(&request, &[])?;
    let bytes = raw_body(&request)?.to_vec();
    state.current()?;
    blocking(move || render_markdown(&bytes)).await
}

#[tauri::command]
pub async fn search(
    state: State<'_, VaultState>,
    request: Request<'_>,
) -> Result<Vec<SearchHit>, BridgeError> {
    only_headers(&request, &[])?;
    let QueryArgs { query } = json_args(&request)?;
    let vault = state.current()?;
    blocking(move || vault.search(&query)).await
}

#[tauri::command]
pub async fn rebuild_index(
    state: State<'_, VaultState>,
    request: Request<'_>,
) -> Result<IndexStats, BridgeError> {
    only_headers(&request, &[])?;
    no_payload(&request)?;
    let vault = state.current()?;
    blocking(move || vault.rebuild_index()).await
}

#[cfg(test)]
mod tests;

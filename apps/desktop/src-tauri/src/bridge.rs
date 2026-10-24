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
//! | `open_vault` | JSON `{ path }` (absolute folder below the home folder, see [`VaultState`]) | `null` |
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

use std::sync::{Arc, Mutex};

use libre_ai_notebook_vault::{
    IndexStats, PreviewNode, Revision, RootPolicy, SearchHit, Vault, VaultError,
    render_preview as render_markdown,
};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize, Serializer};
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, Emitter, Runtime, State};

/// Event emitted after a successful `write_note`.
pub const VAULT_CHANGED: &str = "vault_changed";
/// Header carrying the percent-encoded note path of a `write_note`.
pub const PATH_HEADER: &str = "x-vault-path";
/// Header carrying the revision a `write_note` expects; absent to create a note.
pub const REVISION_HEADER: &str = "x-vault-revision";

/// Codes the bridge adds to those of the vault.
pub const BRIDGE_CODES: [&str; 2] = ["vault.not_open", "vault.invalid_request"];

/// The refusal of a command. It serialises as its code, a `vault.*` string.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BridgeError {
    /// A command that needs a vault ran before `open_vault`.
    NotOpen,
    /// The request is not shaped as the contract above says (body, header).
    InvalidRequest,
    Vault(VaultError),
}

impl BridgeError {
    pub fn code(self) -> &'static str {
        match self {
            Self::NotOpen => BRIDGE_CODES[0],
            Self::InvalidRequest => BRIDGE_CODES[1],
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

/// The vault the front opened, if any. One at a time: opening replaces it.
///
/// It holds the guard on the roots `open_vault` accepts, built on the Rust side
/// from the home folder of the process. No command receives the home folder or
/// the policy from the front. The guard is a rail, not a boundary: it leaves
/// open every folder below the home folder, so a compromised front can still
/// name `~/Documents`. The boundary is CA-47 (WP-4): the front stops naming the
/// root, and a native folder picker, on this side, does.
pub struct VaultState {
    vault: Mutex<Option<Arc<Vault>>>,
    /// `None` when the home folder of the process cannot be determined: the
    /// guard has nothing to judge against and `open_vault` refuses every root.
    policy: Option<RootPolicy>,
}

impl Default for VaultState {
    fn default() -> Self {
        Self::with_policy(RootPolicy::current_user().ok())
    }
}

impl VaultState {
    /// A state judging roots against `policy`. The application uses the
    /// default (the user's home folder); this is how the tests give the guard a
    /// home folder of their own.
    pub fn with_policy(policy: Option<RootPolicy>) -> Self {
        Self {
            vault: Mutex::new(None),
            policy,
        }
    }

    fn current(&self) -> Result<Arc<Vault>, BridgeError> {
        let guard = self.vault.lock().map_err(|_| other_io())?;
        guard.clone().ok_or(BridgeError::NotOpen)
    }

    fn replace(&self, vault: Vault) -> Result<(), BridgeError> {
        *self.vault.lock().map_err(|_| other_io())? = Some(Arc::new(vault));
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

#[tauri::command]
pub async fn open_vault(
    state: State<'_, VaultState>,
    request: Request<'_>,
) -> Result<(), BridgeError> {
    let PathArgs { path } = json_args(&request)?;
    // The blocking task outlives the borrow of `state`: it owns a copy of the policy.
    let guarded = state.policy.clone();
    let vault = blocking(move || {
        let policy = guarded.as_ref().ok_or(VaultError::InvalidVault)?;
        Vault::open_with(std::path::Path::new(&path), policy)
    })
    .await?;
    state.replace(vault)
}

#[tauri::command]
pub async fn read_note(
    state: State<'_, VaultState>,
    request: Request<'_>,
) -> Result<Response, BridgeError> {
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

#[tauri::command]
pub async fn render_preview(request: Request<'_>) -> Result<PreviewNode, BridgeError> {
    let bytes = raw_body(&request)?.to_vec();
    blocking(move || render_markdown(&bytes)).await
}

#[tauri::command]
pub async fn search(
    state: State<'_, VaultState>,
    request: Request<'_>,
) -> Result<Vec<SearchHit>, BridgeError> {
    let QueryArgs { query } = json_args(&request)?;
    let vault = state.current()?;
    blocking(move || vault.search(&query)).await
}

#[tauri::command]
pub async fn rebuild_index(state: State<'_, VaultState>) -> Result<IndexStats, BridgeError> {
    let vault = state.current()?;
    blocking(move || vault.rebuild_index()).await
}

#[cfg(test)]
mod tests;

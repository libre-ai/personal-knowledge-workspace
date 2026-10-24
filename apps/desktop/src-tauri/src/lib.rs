// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2

//! P04 desktop shell (ADR-0057 section 2). The front it serves can call the
//! commands of `build.rs` and nothing else: the liveness probe of the shell and
//! the six commands of the vault bridge (`bridge`).

pub mod bridge;

use tauri::utils::config::WindowConfig;
use tauri::{Builder, Context, Manager, Runtime, Url, WebviewWindowBuilder};

/// Commands of the shell. They live in a module because `#[tauri::command]`
/// on a `pub fn` at the crate root defines its helper macros twice.
pub mod commands {
    /// Liveness probe of the bridge. It is the positive control that tells a
    /// refused undeclared command from a bridge that refuses everything.
    #[tauri::command]
    pub fn shell_ping() -> &'static str {
        "pong"
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ShellError {
    #[error("tauri.conf.json declares no window")]
    NoWindow,
    #[error(transparent)]
    Tauri(#[from] tauri::Error),
}

/// The private scheme the shell serves its front from. On macOS Tauri answers
/// `tauri://localhost` from the assets embedded at build time.
pub fn is_private_origin(url: &Url) -> bool {
    url.scheme() == "tauri" && url.host_str() == Some("localhost")
}

/// The context of the shell: `tauri.conf.json`, the generated ACL and the
/// embedded front. The macro defines a linker symbol, so the crate expands it
/// once and the shell tests take their context from here.
pub fn context<R: Runtime>() -> Context<R> {
    tauri::generate_context!()
}

/// Registers the commands of the shell, those listed in `build.rs`, and the
/// state of the vault bridge, which judges roots against the home folder of
/// the user.
pub fn with_commands<R: Runtime>(builder: Builder<R>) -> Builder<R> {
    with_vault_state(builder, bridge::VaultState::default())
}

/// [`with_commands`] with a given state of the vault bridge. The tests use it
/// to give the guard on roots a home folder of their own; the front cannot
/// reach it, it is not a command.
pub fn with_vault_state<R: Runtime>(builder: Builder<R>, state: bridge::VaultState) -> Builder<R> {
    builder
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            commands::shell_ping,
            bridge::open_vault,
            bridge::read_note,
            bridge::write_note,
            bridge::render_preview,
            bridge::search,
            bridge::rebuild_index
        ])
}

/// Takes the creation of the main window out of Tauri's hands and returns its
/// configuration entry. Tauri builds configured windows without any guard on
/// navigation: a page may send the top-level document to `http://host/`, and
/// the content-security policy does not cover navigation. The shell builds the
/// window itself, from the same entry, through [`main_window`].
pub fn take_window_config<R: Runtime>(
    context: &mut Context<R>,
) -> Result<WindowConfig, ShellError> {
    let entry = context
        .config_mut()
        .app
        .windows
        .first_mut()
        .ok_or(ShellError::NoWindow)?;
    entry.create = false;
    Ok(entry.clone())
}

/// The main window: its configuration entry plus the guard the configuration
/// cannot express, a navigation that leaves the private scheme nowhere.
///
/// `window.open` needs no guard of its own: measured on wry 0.57.0 and 0.57.1,
/// the page's `window.open(<external URL>)` returns `null` and reaches nothing
/// without any `on_new_window` handler (the `popup` vector of
/// `tests/shell_controls.rs`).
pub fn main_window<'a, R: Runtime, M: Manager<R>>(
    manager: &'a M,
    config: &WindowConfig,
) -> Result<WebviewWindowBuilder<'a, R, M>, ShellError> {
    Ok(WebviewWindowBuilder::from_config(manager, config)?.on_navigation(is_private_origin))
}

/// Runs the shell on the real runtime with the configuration of `tauri.conf.json`.
pub fn run() -> Result<(), ShellError> {
    let mut context = context();
    let window = take_window_config(&mut context)?;
    with_commands(Builder::default())
        .setup(move |app| {
            main_window(app, &window)?.build()?;
            Ok(())
        })
        .run(context)?;
    Ok(())
}

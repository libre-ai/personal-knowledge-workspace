// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2

//! The series binary of P04 (CA-48, `tools/qualification/p04-tauri/PROTOCOL.md`
//! section 10): the shell as it ships, built from the library of the shell and
//! its embedded front (`apps/desktop/dist`), with exactly two additions.
//!
//! - **An injected root picker.** The native folder dialog cannot be driven, so
//!   `choose_vault` is answered with `--vault`, judged by the same guard as in
//!   the shell (the parent of `--vault` stands in for the home folder, as in
//!   the e2e harness).
//! - **An instrumentation script** (`--script`), injected into the page by
//!   `initialization_script`. It drives the front through its DOM and reports by
//!   the document title; the title is read here by `on_document_title_changed`
//!   and printed to stdout, one line per title. No port is opened (control C6),
//!   no command is added, the ACL, the CSP and the window guard are those of
//!   the shell: the window is the one `main_window` builds.
//!
//! Protocol of the title channel: a title that starts with `P04SERIES ` is
//! printed verbatim; the title `P04SERIES-EXIT` ends the process with code 0.
//! Any other title is the front's own and is ignored.
//!
//! Arguments: `--vault DIR --script FILE`.

#[cfg(not(target_os = "macos"))]
fn main() -> std::process::ExitCode {
    eprintln!("unavailable: the series runs on macOS (WKWebView)");
    std::process::ExitCode::FAILURE
}

#[cfg(target_os = "macos")]
fn main() -> std::process::ExitCode {
    match macos::run() {
        Ok(0) => std::process::ExitCode::SUCCESS,
        Ok(code) => {
            eprintln!("p04-series: the shell exited with code {code}");
            std::process::ExitCode::FAILURE
        }
        Err(message) => {
            eprintln!("p04-series: {message}");
            std::process::ExitCode::FAILURE
        }
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use std::fs;
    use std::path::PathBuf;

    use libre_ai_notebook_vault::RootPolicy;
    use libre_ai_p04_desktop::bridge::VaultState;
    use libre_ai_p04_desktop::{context, main_window, take_window_config, with_vault_state};
    use tauri::Builder;

    const REPORT_PREFIX: &str = "P04SERIES ";
    const EXIT_TITLE: &str = "P04SERIES-EXIT";

    fn argument(name: &str) -> Result<String, String> {
        let mut args = std::env::args().skip(1);
        while let Some(candidate) = args.next() {
            if candidate == name {
                return args.next().ok_or_else(|| format!("{name} needs a value"));
            }
        }
        Err(format!("{name} is required"))
    }

    pub fn run() -> Result<i32, String> {
        let vault: PathBuf =
            fs::canonicalize(argument("--vault")?).map_err(|error| format!("--vault: {error}"))?;
        let script = fs::read_to_string(argument("--script")?)
            .map_err(|error| format!("--script: {error}"))?;
        let home = vault
            .parent()
            .ok_or("--vault has no parent folder to stand in for the home folder")?
            .to_path_buf();
        let policy = RootPolicy::new(&home, &[]).map_err(|error| format!("{error:?}"))?;
        let root = vault.clone();
        let state = VaultState::with_picker(Some(policy), move || Some(root.clone()));

        let mut context = context();
        let window = take_window_config(&mut context).map_err(|error| error.to_string())?;
        let app = with_vault_state(Builder::default(), state)
            .setup(move |app| {
                let handle = app.handle().clone();
                let webview = main_window(app, &window)?
                    .initialization_script(script.clone())
                    .on_document_title_changed(move |_, title| {
                        if title == EXIT_TITLE {
                            handle.exit(0);
                        } else if title.starts_with(REPORT_PREFIX) {
                            println!("{title}");
                        }
                    })
                    .build()?;
                // Keystrokes of the series go to the frontmost window (PROTOCOL.md section 10).
                webview.set_focus()?;
                Ok(())
            })
            .build(context)
            .map_err(|error| format!("build: {error}"))?;
        Ok(app.run_return(|_, _| {}))
    }
}

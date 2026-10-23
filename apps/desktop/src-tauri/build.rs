// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2

use std::error::Error;
use std::path::Path;

/// The only commands the front can call. `AppManifest::commands` makes
/// tauri-build generate one `allow-<command>` permission per name; a command
/// registered in the handler but absent here has no permission and is refused.
/// `capabilities/main.json` lists the same names, and `tests/shell/config.test.ts`
/// fails on any drift between the two.
const COMMANDS: &[&str] = &["shell_ping"];

fn main() -> Result<(), Box<dyn Error>> {
    // `generate_context!` embeds `frontendDist`; without it the failure is a
    // proc-macro panic that does not say how to build the front.
    if !Path::new("../dist/index.html").is_file() {
        return Err(
            "apps/desktop/dist/index.html is missing: run `bun run --cwd apps/desktop build`"
                .into(),
        );
    }
    println!("cargo::rerun-if-changed=../dist");
    println!("cargo::rerun-if-changed=build.rs");

    let attributes = tauri_build::Attributes::new()
        .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS));
    tauri_build::try_build(attributes)?;
    Ok(())
}

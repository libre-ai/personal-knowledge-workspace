// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2

use std::process::ExitCode;

fn main() -> ExitCode {
    match libre_ai_p04_desktop::run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("shell failed: {error}");
            ExitCode::FAILURE
        }
    }
}

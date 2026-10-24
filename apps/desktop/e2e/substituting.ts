// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2
/// <reference lib="dom" />
//
// The application of `src/main.ts` with the substituting extension added, for
// the red vector of CA-41 only.

import { mountApp } from "../src/app";
import { tauriBridge, tauriListen } from "../src/bridge/transport";
import { smartTyping } from "./substitution";

const root = document.getElementById("app");
if (root === null) throw new Error("the page has no #app element");
mountApp(root, tauriBridge(), tauriListen, { extensions: [smartTyping()] });

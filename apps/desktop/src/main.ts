// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2
/// <reference lib="dom" />

import { mountApp } from "./app";
import { tauriBridge, tauriListen } from "./bridge/transport";

const root = document.getElementById("app");
if (root === null) throw new Error("the page has no #app element");
mountApp(root, tauriBridge(), tauriListen);

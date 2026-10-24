// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2
//
// `tsconfig.json` of this app includes `scripts/` and `tests/` only, so a source
// that no test imports is never typechecked by `bun run --cwd apps/desktop
// typecheck`. The imports below are erased at run time (`import type`) and put
// the sources that need a browser, and the e2e files, in the program the
// compiler reads. Add a new entry point or spec here.

import type * as Accessibility from "../../e2e/accessibility";
import type * as AccessibilitySpec from "../../e2e/accessibility.e2e";
import type * as Shim from "../../e2e/shim";
import type * as Stage from "../../e2e/stage";
import type * as Substituting from "../../e2e/substituting";
import type * as Teardown from "../../e2e/teardown";
import type * as Config from "../../playwright.config";
import type * as App from "../../src/app";
import type * as Transport from "../../src/bridge/transport";
import type * as AccessibleText from "../../src/editor/accessible-text";
import type * as NoteEditor from "../../src/editor/note-editor";
import type * as Preview from "../../src/editor/preview";
import type * as Styles from "../../src/editor/styles";
import type * as TypedText from "../../src/editor/typed-text";
import type * as Main from "../../src/main";

export type Program = [
  typeof Config,
  typeof App,
  typeof Main,
  typeof Transport,
  typeof NoteEditor,
  typeof AccessibleText,
  typeof Preview,
  typeof Styles,
  typeof TypedText,
  typeof Shim,
  typeof Accessibility,
  typeof AccessibilitySpec,
  typeof Stage,
  typeof Substituting,
  typeof Teardown,
];

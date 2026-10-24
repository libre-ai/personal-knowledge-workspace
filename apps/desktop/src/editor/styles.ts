// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2
/// <reference lib="dom" />
//
// The styles of the editor, as a constructable stylesheet adopted by a shadow
// root. Why not a `<style>` element: the CSP of the shell is `style-src 'self'`
// (EF-P04-8, control 3), which refuses an inline `<style>`, and CodeMirror mounts
// its own base theme in one when the root is the document (`style-mod`, measured
// by the first e2e run: `style-src-elem inline` violation, editor unstyled).
// `style-mod` adopts a constructable stylesheet instead when the root is a shadow
// root, and so does this module for the rules of the live preview; the CSSOM is
// not an inline style, the CSP stays as the gate of control C3 judges it.
//
// Colours are the tokens defined on `:root` by `style.css`; custom properties
// inherit into the shadow tree, and nothing here names a colour.

const RULES = `
:host {
  display: block;
  border: 1px solid var(--border);
  min-height: 16rem;
}

.cm-editor {
  min-height: 16rem;
}

.cm-editor.cm-focused {
  outline: 2px solid var(--accent);
}

.cm-content {
  font-family: ui-monospace, monospace;
  padding: 0.5rem;
}

/* The marks of the live preview change how text looks, never what it says. */
.cm-md-heading {
  font-weight: 700;
}

.cm-md-h1 {
  font-size: 1.4em;
}

.cm-md-h2 {
  font-size: 1.2em;
}

.cm-md-emphasis {
  font-style: italic;
}

.cm-md-strong {
  font-weight: 700;
}

.cm-md-strikethrough {
  text-decoration: line-through;
}

.cm-md-code,
.cm-md-code_block {
  background: var(--mark-code);
}

.cm-md-block_quote {
  background: var(--mark-quote);
}

.cm-md-link,
.cm-md-wiki_link {
  color: var(--accent);
  text-decoration: underline;
}

.cm-md-link[data-md-blocked="true"] {
  text-decoration: line-through;
}
`;

/** Thrown when the WebView cannot adopt a stylesheet: the editor would be unstyled under the CSP. */
export class StylesUnsupported extends Error {
  constructor() {
    super("editor.styles_unsupported");
    this.name = "StylesUnsupported";
  }
}

const adopted = new WeakSet<ShadowRoot>();

/**
 * Gives `root` the styles of the editor, once. `style-mod` adopts its own sheet in
 * the same way, so the list is added to, never replaced.
 */
export function adoptEditorStyles(root: ShadowRoot): void {
  if (adopted.has(root)) return;
  if (typeof CSSStyleSheet !== "function" || !("adoptedStyleSheets" in root)) {
    throw new StylesUnsupported();
  }
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(RULES);
  root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
  adopted.add(root);
}

// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2
//
// The client of the bridge against a recording transport: what it sends is what
// the Rust bridge tests (src-tauri/src/bridge/tests.rs) accept, what it receives
// is shaped as they say. The names come from `wire.v1.json`, the same file the
// Rust tests read; the transport itself is not exercised here (NOT VERIFIED in a
// real WebView: the editor package wires `@tauri-apps/api/core`).

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  BRIDGE_COMMANDS,
  BridgeFailure,
  BridgeRefusal,
  createBridge,
  type Invoke,
  type InvokeOptions,
  PATH_HEADER,
  type PreviewNode,
  READ_FRAME_PREFIX_BYTES,
  REFUSAL_CODES,
  REVISION_HEADER,
  VAULT_CHANGED_EVENT,
} from "../../src/bridge";

interface Call {
  command: string;
  args: Record<string, unknown> | Uint8Array | undefined;
  options: InvokeOptions | undefined;
}

function recorder(answer: unknown): { invoke: Invoke; calls: Call[] } {
  const calls: Call[] = [];
  const invoke: Invoke = async (command, args, options) => {
    calls.push({ command, args, options });
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { invoke, calls };
}

const REVISION = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

function frameOf(bytes: Uint8Array, revision = REVISION): ArrayBuffer {
  const frame = new Uint8Array(READ_FRAME_PREFIX_BYTES + bytes.length);
  frame.set(new TextEncoder().encode(revision), 0);
  frame.set(bytes, READ_FRAME_PREFIX_BYTES);
  return frame.buffer;
}

describe("the names are the ones of the shared wire contract", () => {
  const wire = JSON.parse(readFileSync(join(import.meta.dir, "wire.v1.json"), "utf8")) as {
    commands: string[];
    headers: { path: string; revision: string };
    readFramePrefixBytes: number;
    event: string;
    refusalCodes: string[];
  };

  test("commands, headers, frame, event and refusal codes equal the fixture", () => {
    expect([...BRIDGE_COMMANDS] as string[]).toEqual(wire.commands);
    expect(PATH_HEADER).toBe(wire.headers.path);
    expect(REVISION_HEADER).toBe(wire.headers.revision);
    expect(READ_FRAME_PREFIX_BYTES).toBe(wire.readFramePrefixBytes);
    expect(VAULT_CHANGED_EVENT).toBe(wire.event);
    expect([...REFUSAL_CODES] as string[]).toEqual(wire.refusalCodes);
    console.log(
      `wire: ${wire.commands.length} commands, ${wire.refusalCodes.length} refusal codes, frame prefix ${wire.readFramePrefixBytes} bytes`,
    );
  });

  test("the commands are those that build.rs declares, minus the probe, and the capability lists", () => {
    const shell = join(import.meta.dir, "..", "..", "src-tauri");
    const build = readFileSync(join(shell, "build.rs"), "utf8");
    const declared = [
      ...(/const\s+COMMANDS[^=]*=\s*&\[([^\]]*)\]/.exec(build)?.[1] ?? "").matchAll(/"([a-z_]+)"/g),
    ]
      .map((m) => m[1])
      .filter((name) => name !== "shell_ping");
    expect(declared.length).toBeGreaterThan(0);
    expect([...declared].sort()).toEqual([...wire.commands].sort());

    const capability = JSON.parse(
      readFileSync(join(shell, "capabilities", "main.json"), "utf8"),
    ) as {
      permissions: string[];
    };
    const permitted = capability.permissions
      .map((p) => p.replace(/^allow-/, "").replaceAll("-", "_"))
      .filter((name) => name !== "shell_ping");
    expect([...permitted].sort()).toEqual([...wire.commands].sort());
  });
});

describe("what the client sends", () => {
  test("open_vault, search and rebuild_index send JSON arguments", async () => {
    const { invoke, calls } = recorder(null);
    const bridge = createBridge(invoke);
    await bridge.openVault("/tmp/vault");
    expect(calls.at(-1)).toEqual({
      command: "open_vault",
      args: { path: "/tmp/vault" },
      options: undefined,
    });

    const searching = recorder([{ path: "a.md", score: 2 }]);
    expect(await createBridge(searching.invoke).search("alpha beta")).toEqual([
      { path: "a.md", score: 2 },
    ]);
    expect(searching.calls[0]).toEqual({
      command: "search",
      args: { query: "alpha beta" },
      options: undefined,
    });

    const rebuilding = recorder({ notes: 3, ignored: 1, unreadable: 0, terms: 9 });
    expect(await createBridge(rebuilding.invoke).rebuildIndex()).toEqual({
      notes: 3,
      ignored: 1,
      unreadable: 0,
      terms: 9,
    });
    expect(rebuilding.calls[0]?.command).toBe("rebuild_index");
  });

  test("write_note sends the exact bytes raw, the path percent-encoded in a header", async () => {
    const { invoke, calls } = recorder({ path: "notes/été-😀.md", revision: REVISION });
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x0d, 0x0a, 0xff, 0x00]);
    const written = await createBridge(invoke).writeNote("notes/été-😀.md", bytes, REVISION);
    const call = calls[0];
    expect(call?.command).toBe("write_note");
    expect(call?.args).toBe(bytes);
    expect(call?.options?.headers).toEqual({
      "x-vault-path": "notes%2F%C3%A9t%C3%A9-%F0%9F%98%80.md",
      "x-vault-revision": REVISION,
    });
    expect(written).toEqual({ path: "notes/été-😀.md", revision: REVISION });
  });

  test("creating a note sends no revision header", async () => {
    const { invoke, calls } = recorder({ path: "a.md", revision: REVISION });
    await createBridge(invoke).writeNote("a.md", new Uint8Array(), null);
    expect(Object.keys(calls[0]?.options?.headers ?? {})).toEqual(["x-vault-path"]);
  });

  test("a path with a lone surrogate is refused before anything is sent", async () => {
    const { invoke, calls } = recorder({});
    const outcome = await createBridge(invoke)
      .writeNote("\ud800.md", new Uint8Array(), null)
      .catch((e) => e);
    expect(outcome).toBeInstanceOf(BridgeRefusal);
    expect((outcome as BridgeRefusal).code).toBe("vault.invalid_path");
    expect(calls).toEqual([]);
  });

  test("render_preview sends the buffer raw", async () => {
    const tree: PreviewNode = { kind: "document", from: 0, to: 0, children: [] };
    const { invoke, calls } = recorder(tree);
    const buffer = new TextEncoder().encode("# Title\n");
    expect(await createBridge(invoke).renderPreview(buffer)).toEqual(tree);
    expect(calls[0]?.args).toBe(buffer);
  });
});

describe("what the client returns", () => {
  test("read_note splits the frame into the revision and the exact bytes", async () => {
    const note = new Uint8Array([0x61, 0x0d, 0x0a, 0xef, 0xbb, 0xbf, 0xff, 0x00]);
    const { invoke } = recorder(frameOf(note));
    const read = await createBridge(invoke).readNote("a.md");
    expect(read.revision).toBe(REVISION);
    expect([...read.bytes]).toEqual([...note]);
  });

  test("an empty note is the frame prefix alone", async () => {
    const { invoke } = recorder(frameOf(new Uint8Array()));
    const read = await createBridge(invoke).readNote("empty.md");
    expect(read.bytes.length).toBe(0);
  });

  test("answers that do not have the contract's shape are failures", async () => {
    const shapes: Array<
      [string, (b: ReturnType<typeof createBridge>) => Promise<unknown>, unknown]
    > = [
      ["short frame", (b) => b.readNote("a.md"), new Uint8Array(10).buffer],
      [
        "frame without a revision",
        (b) => b.readNote("a.md"),
        frameOf(new Uint8Array(3), "Z".repeat(64)),
      ],
      ["frame is not bytes", (b) => b.readNote("a.md"), "text"],
      [
        "written without a revision",
        (b) => b.writeNote("a.md", new Uint8Array(), null),
        { path: "a.md" },
      ],
      [
        "written with a bad revision",
        (b) => b.writeNote("a.md", new Uint8Array(), null),
        { path: "a.md", revision: "x" },
      ],
      ["hits are not a list", (b) => b.search("x"), { path: "a.md" }],
      ["a hit has no score", (b) => b.search("x"), [{ path: "a.md" }]],
      ["stats lack a field", (b) => b.rebuildIndex(), { notes: 1 }],
      [
        "tree is not a document",
        (b) => b.renderPreview(new Uint8Array()),
        { kind: "paragraph", children: [] },
      ],
    ];
    for (const [name, call, answer] of shapes) {
      const outcome = await call(createBridge(recorder(answer).invoke)).catch((e) => e);
      expect(outcome, name).toBeInstanceOf(BridgeFailure);
    }
  });
});

describe("refusals", () => {
  test("each closed code is a BridgeRefusal carrying that code", async () => {
    for (const code of REFUSAL_CODES) {
      const invoke: Invoke = async () => {
        throw code;
      };
      const outcome = await createBridge(invoke)
        .search("x")
        .catch((e) => e);
      expect(outcome).toBeInstanceOf(BridgeRefusal);
      expect((outcome as BridgeRefusal).code).toBe(code);
    }
    console.log(`refusals: ${REFUSAL_CODES.length} closed codes mapped`);
  });

  test("anything else is a BridgeFailure that repeats nothing", async () => {
    const rejections: unknown[] = [
      "vault.something_new",
      "read_note not allowed on window other, URL: local",
      new Error("a message that names a private folder"),
      { code: "vault.io" },
      42,
      undefined,
    ];
    for (const rejection of rejections) {
      const invoke: Invoke = async () => {
        throw rejection;
      };
      const outcome = await createBridge(invoke)
        .openVault("/x")
        .catch((e) => e);
      expect(outcome).toBeInstanceOf(BridgeFailure);
      expect((outcome as Error).message).toBe("bridge.failure");
    }
  });
});

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import module_ from "../src/index.js";
import { MemoryPlugin } from "../src/plugin.js";

describe("smoke: plugin module", () => {
  it("exports a v1 plugin module with id and a lazy server entry", async () => {
    expect(module_.id).toBe("@log0u7/opencode-memory");
    // server() lazily loads the v1 implementation so the v1-only import graph
    // stays out of the static graph (v2 hosts reject it at load time). The
    // contract is therefore not identity with MemoryPlugin but the same hooks.
    expect(typeof module_.server).toBe("function");
    const hooks = await module_.server(fakeInput());
    expect(Object.keys(hooks).sort()).toEqual([
      "dispose",
      "experimental.chat.system.transform",
      "experimental.session.compacting",
      "tool",
    ]);
    await hooks.dispose?.();
  });

  it("plugin factory resolves hooks without network or side effects", async () => {
    const hooks = await MemoryPlugin(fakeInput());
    expect(Object.keys(hooks).sort()).toEqual([
      "dispose",
      "experimental.chat.system.transform",
      "experimental.session.compacting",
      "tool",
    ]);
    expect(Object.keys(hooks.tool ?? {}).sort()).toEqual([
      "memory_forget",
      "memory_list",
      "memory_restore",
      "memory_save",
      "memory_search",
      "memory_stats",
    ]);
    await hooks.dispose?.();
  });

  it("forwards the options argument through server() (dbPath honored)", async () => {
    // The store opens lazily on the first tool call: writing one entry forces
    // the open, and the file must land at the dbPath the wrapper forwarded.
    const dir = mkdtempSync(join(tmpdir(), "opencode-memory-smoke-"));
    try {
      const dbPath = join(dir, "forwarded.db");
      const hooks = await module_.server(fakeInput(), { dbPath });
      expect(hooks.tool?.memory_save).toBeDefined();
      await hooks.tool?.memory_save?.execute(
        { kind: "fact", title: "options forwarded", body: "x" },
        ctx(),
      );
      expect(existsSync(dbPath)).toBe(true);
      await hooks.dispose?.();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function ctx() {
  return {
    sessionID: "s1",
    messageID: "m1",
    agent: "build",
    directory: "/work/project",
    worktree: "/work/project",
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
  };
}

function fakeInput() {
  return {
    client: {} as never,
    project: { id: "p1" } as never,
    directory: "/tmp/project",
    worktree: "/tmp/project",
    experimental_workspace: {} as never,
    serverUrl: new URL("http://localhost:4096"),
    $: (() => Promise.resolve()) as never,
  };
}

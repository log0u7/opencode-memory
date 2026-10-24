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
});

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

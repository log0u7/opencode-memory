import { describe, expect, it } from "vitest";

import module_ from "../src/index.js";
import { MemoryPlugin } from "../src/plugin.js";

describe("smoke: plugin module", () => {
  it("exports a v1 plugin module with id and server", () => {
    expect(module_.id).toBe("@log0u7/opencode-memory");
    expect(module_.server).toBe(MemoryPlugin);
  });

  it("plugin factory resolves hooks without network or side effects", async () => {
    const hooks = await MemoryPlugin(fakeInput());
    expect(typeof hooks).toBe("object");
    expect(Object.keys(hooks)).toEqual([]);
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

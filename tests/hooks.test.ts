import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MemoryPlugin } from "../src/plugin.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "opencode-memory-hooks-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function fakeInput() {
  return {
    client: {} as never,
    project: { id: "p1" } as never,
    directory: "/work/project",
    worktree: "/work/project",
    experimental_workspace: {} as never,
    serverUrl: new URL("http://localhost:4096"),
    $: (() => Promise.resolve()) as never,
  };
}

describe("memory plugin hooks", () => {
  it("appends memory guidance to the system prompt", async () => {
    const hooks = await MemoryPlugin(fakeInput(), { dbPath: join(dir, "m.db") });
    const transform = hooks["experimental.chat.system.transform"];
    expect(transform).toBeDefined();

    const output = { system: ["base prompt"] };
    await transform?.({ sessionID: "s1", model: {} as never }, output);

    expect(output.system).toHaveLength(2);
    expect(output.system[1]).toContain("memory_search");
    expect(output.system[1]).toContain("memory_save");
    expect(output.system[1]?.toLowerCase()).toContain("credential");
  });

  it("appends compaction context that asks for durable decisions", async () => {
    const hooks = await MemoryPlugin(fakeInput(), { dbPath: join(dir, "m.db") });
    const compacting = hooks["experimental.session.compacting"];
    expect(compacting).toBeDefined();

    const output = { context: [] };
    await compacting?.({ sessionID: "s1" }, output);

    expect(output.context).toHaveLength(1);
    expect(output.context[0]).toContain("memory_save");
    expect(output.context[0]).toContain("decision");
  });
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MemoryPlugin } from "../src/plugin.js";
import type { ToolContext } from "@opencode-ai/plugin";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "opencode-memory-plugin-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const WORKTREE = "/work/project";

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionID: "s1",
    messageID: "m1",
    agent: "build",
    directory: WORKTREE,
    worktree: WORKTREE,
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
    ...overrides,
  };
}

async function loadTools(options: Record<string, unknown> = {}) {
  const hooks = await MemoryPlugin(fakeInput(), options);
  return hooks.tool ?? {};
}

function fakeInput() {
  return {
    client: {} as never,
    project: { id: "p1" } as never,
    directory: WORKTREE,
    worktree: WORKTREE,
    experimental_workspace: {} as never,
    serverUrl: new URL("http://localhost:4096"),
    $: (() => Promise.resolve()) as never,
  };
}

describe("memory plugin tools", () => {
  it("registers the four memory tools", async () => {
    const tools = await loadTools({ dbPath: join(dir, "m.db") });
    expect(Object.keys(tools).sort()).toEqual([
      "memory_forget",
      "memory_list",
      "memory_save",
      "memory_search",
    ]);
  });

  it("saves, searches, and forgets with worktree as default scope", async () => {
    const tools = await loadTools({ dbPath: join(dir, "m.db") });

    const saved = await tools.memory_save?.execute(
      { kind: "decision", title: "Adopt batching", body: "batch size 1000", tags: ["db"] },
      ctx(),
    );
    expect(saved).toContain("saved");

    const hits = await tools.memory_search?.execute({ query: "batching" }, ctx());
    expect(hits).toContain("Adopt batching");

    const listed = await tools.memory_list?.execute({}, ctx());
    expect(listed).toContain("Adopt batching");

    const all = JSON.parse(String(listed)) as Array<{ id: string }>;
    const forgotten = await tools.memory_forget?.execute({ id: all[0]?.id }, ctx());
    expect(forgotten).toContain("1");
  });

  it("returns a readable error instead of throwing on secret-looking bodies", async () => {
    const tools = await loadTools({ dbPath: join(dir, "m.db") });
    const result = await tools.memory_save?.execute(
      { kind: "fact", title: "key", body: "sk-abcdefghijklmnop12345678", tags: [] },
      ctx(),
    );
    expect(result).toContain("credential");
  });
});

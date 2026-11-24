import { existsSync, mkdtempSync, rmSync } from "node:fs";
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
    expect(output.system[1]).toContain("kind=lesson");
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
    expect(output.context[0]).toContain("kind=lesson");
  });

  it("appends compaction context that asks for durable decisions with an inventory of stored entries", async () => {
    const dbPath = join(dir, "inv.db");
    const hooks = await MemoryPlugin(fakeInput(), { dbPath });
    const tools = hooks.tool ?? {};
    await tools.memory_save?.execute(
      { kind: "decision", title: "Use WAL mode", body: "journal_mode=WAL" },
      ctx(),
    );

    const compacting = hooks["experimental.session.compacting"];
    const output = { context: [] };
    await compacting?.({ sessionID: "s1" }, output);

    expect(output.context).toHaveLength(2);
    expect(String(output.context[1])).toContain("Use WAL mode");
    expect(String(output.context[1])).toContain("Memory already stored");
    await hooks.dispose?.();
  });

  it("compaction lists nothing when the store is absent", async () => {
    const hooks = await MemoryPlugin(fakeInput(), { dbPath: join(dir, "absent.db") });

    const output = { context: [] };
    await hooks["experimental.session.compacting"]?.({ sessionID: "s1" }, output);

    expect(output.context).toHaveLength(1);
    await hooks.dispose?.();
  });

  it("re-injects the same inventory on every request of a session (stable prefix)", async () => {
    const dbPath = join(dir, "inject.db");
    const hooks = await MemoryPlugin(fakeInput(), { dbPath });
    const transform = hooks["experimental.chat.system.transform"];
    await hooks.tool?.memory_save?.execute(
      { kind: "fact", title: "Adopt batching", body: "batch 1000" },
      ctx(),
    );

    const first = { system: ["base"] };
    await transform?.({ sessionID: "s1", model: {} as never }, first);
    expect(first.system).toHaveLength(3);
    expect(first.system[2]).toContain("Adopt batching");

    // The host rebuilds the system prompt per call: the next request must carry a
    // byte-identical block, or the prompt cache misses from that point on.
    await hooks.tool?.memory_save?.execute(
      { kind: "fact", title: "Later entry", body: "x" },
      ctx(),
    );
    const second = { system: ["base"] };
    await transform?.({ sessionID: "s1", model: {} as never }, second);
    expect(second.system).toEqual(first.system);

    // A new session gets its own, fresh inventory.
    const third = { system: ["base"] };
    await transform?.({ sessionID: "s2", model: {} as never }, third);
    expect(third.system[2]).toContain("Later entry");
    await hooks.dispose?.();
  });

  it("does not rebuild a live session's inventory when a lesson is saved", async () => {
    const dbPath = join(dir, "lesson.db");
    const hooks = await MemoryPlugin(fakeInput(), { dbPath });
    const transform = hooks["experimental.chat.system.transform"];
    await hooks.tool?.memory_save?.execute({ kind: "fact", title: "seed", body: "x" }, ctx());

    const first = { system: ["base"] };
    await transform?.({ sessionID: "s1", model: {} as never }, first);
    await hooks.tool?.memory_save?.execute(
      { kind: "lesson", title: "new lesson", body: "x" },
      ctx(),
    );
    const second = { system: ["base"] };
    await transform?.({ sessionID: "s1", model: {} as never }, second);
    expect(second.system).toEqual(first.system);
    await hooks.dispose?.();
  });

  it("injects nothing when the store does not exist", async () => {
    const hooks = await MemoryPlugin(fakeInput(), { dbPath: join(dir, "no.db") });
    const transform = hooks["experimental.chat.system.transform"];

    const output = { system: ["base"] };
    await transform?.({ sessionID: "s1", model: {} as never }, output);

    expect(output.system).toHaveLength(2);
    expect(existsSync(join(dir, "no.db"))).toBe(false);
    await hooks.dispose?.();
  });

  it("keeps one sticky inventory per instance when the session id is missing", async () => {
    const dbPath = join(dir, "unknown.db");
    const hooks = await MemoryPlugin(fakeInput(), { dbPath });
    const transform = hooks["experimental.chat.system.transform"];
    await hooks.tool?.memory_save?.execute({ kind: "fact", title: "WAL again", body: "x" }, ctx());

    const a = { system: ["base"] };
    const b = { system: ["base"] };
    await transform?.({ model: {} as never }, a);
    await transform?.({ model: {} as never }, b);

    expect(a.system[2]).toContain("WAL again");
    expect(b.system).toEqual(a.system);
    await hooks.dispose?.();
  });

  it("caps the injected-session bookkeeping instead of growing it forever", async () => {
    const dbPath = join(dir, "cap.db");
    const hooks = await MemoryPlugin(fakeInput(), { dbPath });
    const transform = hooks["experimental.chat.system.transform"];
    await hooks.tool?.memory_save?.execute(
      { kind: "fact", title: "capped store", body: "x" },
      ctx(),
    );

    const count = (system: string[]) => system.filter((s) => s.includes("capped store")).length;

    const output = { system: ["base"] };
    await transform?.({ sessionID: "first", model: {} as never }, output);
    expect(count(output.system)).toBe(1);

    // Overflow the key set: only the oldest session is evicted, never the whole cache.
    for (let i = 0; i < 512; i++) {
      await transform?.({ sessionID: `s-${i}`, model: {} as never }, output);
    }
    expect(count(output.system)).toBe(513);

    // The evicted first session gets a recomputed inventory on its next request.
    await transform?.({ sessionID: "first", model: {} as never }, output);
    expect(count(output.system)).toBe(514);
    await hooks.dispose?.();
  });
});

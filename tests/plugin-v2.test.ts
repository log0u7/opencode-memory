import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Plugin } from "@opencode/plugin";
import type { ToolContext } from "@opencode-ai/plugin";

import { MemoryPlugin } from "../src/plugin.js";
import { pluginModule } from "../src/index.js";
import { list, MAX_LIMIT } from "../src/lib/store.js";
import { openMemoryDb } from "../src/lib/db.js";

function v1Input(worktree = "/home/u/project") {
  return {
    client: {} as never,
    project: { id: "p1" } as never,
    directory: worktree,
    worktree,
    experimental_workspace: {} as never,
    serverUrl: new URL("http://localhost:4096"),
    $: (() => Promise.resolve()) as never,
  };
}

function v1ToolContext(worktree = "/home/u/project"): ToolContext {
  return {
    sessionID: "s1",
    messageID: "m1",
    agent: "build",
    directory: worktree,
    worktree,
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
  } as unknown as ToolContext;
}

const dirs: string[] = [];

function tmpDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "opencode-memory-v2-"));
  dirs.push(dir);
  return join(dir, "memory.db");
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

type AddedTool = {
  name: string;
  execute: (
    input: Record<string, unknown>,
    context: { sessionID: string },
  ) => Promise<{ content?: string }>;
};

type V2Event = { type: string; data: { sessionID: string } };

function fakeCtx(
  dbPath: string,
  options: Record<string, unknown> = {},
  fixtures: {
    events?: V2Event[];
    sessionGet?: () => { parentID?: string };
    context?: () => unknown[];
    generateText?: () => Promise<{ text: string }>;
  } = {},
) {
  const added: AddedTool[] = [];
  const sessionHooks = new Map<
    string,
    (event: { system: Array<{ type: string; text: string }>; messages: unknown[] }) => void
  >();

  const ctx = {
    location: { directory: "/home/u/project" },
    options: { dbPath, ...options },
    tool: {
      transform: async (fn: (editor: { add: (t: AddedTool & { id: string }) => void }) => void) =>
        fn({ add: (t) => added.push(t) }),
    },
    session: {
      hook: async (
        name: string,
        fn: typeof sessionHooks extends Map<string, infer F> ? F : never,
      ) => {
        sessionHooks.set(name, fn);
      },
      get: vi.fn(async (input: { sessionID: string }) =>
        fixtures.sessionGet ? fixtures.sessionGet() : { id: input.sessionID },
      ),
      context: vi.fn(async () => (fixtures.context ? fixtures.context() : [])),
    },
    generate: { text: vi.fn(fixtures.generateText ?? (async () => ({ text: "[]" }))) },
    event: {
      subscribe: vi.fn(() =>
        (async function* () {
          for (const event of fixtures.events ?? []) {
            yield event;
          }
        })(),
      ),
    },
  } as unknown as Plugin.Context;

  return { ctx, added, sessionHooks };
}

describe("v1 and v2 share one behaviour", () => {
  it("returns the same model-facing text for the same calls", async () => {
    const dbPath = tmpDbPath();
    const { ctx, added } = fakeCtx(dbPath);
    const cleanupV2 = await pluginModule.setup(ctx);
    const v2 = new Map(added.map((t) => [t.name, t]));

    const hooks = await MemoryPlugin(v1Input(), { dbPath });
    const v1 = hooks.tool ?? {};
    const v1Scope = {
      ...v1ToolContext(),
      directory: "/home/u/project",
      worktree: "/home/u/project",
    };

    const saveArgs = { kind: "decision", title: "Parity check", body: "same behaviour" };
    expect(await v1.memory_save?.execute(saveArgs, v1Scope)).toBe(
      (await v2.get("memory_save")?.execute(saveArgs, { sessionID: "s1" }))?.content,
    );

    const searchArgs = { query: "parity" };
    expect(await v1.memory_search?.execute(searchArgs, v1Scope)).toBe(
      (await v2.get("memory_search")?.execute(searchArgs, { sessionID: "s1" }))?.content,
    );
    expect(await v1.memory_list?.execute({}, v1Scope)).toBe(
      (await v2.get("memory_list")?.execute({}, { sessionID: "s1" }))?.content,
    );

    const forgetArgs = { query: "parity" };
    expect(await v1.memory_forget?.execute(forgetArgs, v1Scope)).toBe("deleted 1 entry");
    // Recreate through the other host so both sides forget from the same state.
    expect(
      (await v2.get("memory_save")?.execute(saveArgs, { sessionID: "s1" }))?.content,
    ).toContain("saved");
    expect((await v2.get("memory_forget")?.execute(forgetArgs, { sessionID: "s1" }))?.content).toBe(
      "deleted 1 entry",
    );

    await hooks.dispose?.();
    await cleanupV2?.();
  });
});

describe("opencode-memory v2 setup", () => {
  it("registers the four memory tools", async () => {
    const dbPath = tmpDbPath();
    const { ctx, added } = fakeCtx(dbPath);

    const cleanup = await pluginModule.setup(ctx);
    const names = added.map((t) => t.name).sort();
    expect(names).toEqual(["memory_forget", "memory_list", "memory_save", "memory_search"]);
    await cleanup?.();
  });

  it("saves, searches and forgets through the v2 tools", async () => {
    const dbPath = tmpDbPath();
    const { ctx, added } = fakeCtx(dbPath);
    const cleanup = await pluginModule.setup(ctx);
    const byName = new Map(added.map((t) => [t.name, t]));

    const save = byName.get("memory_save");
    const saved = await save?.execute(
      { kind: "decision", title: "Use pnpm", body: "This repo uses pnpm workspaces." },
      { sessionID: "s1" },
    );
    expect(saved?.content).toContain("saved");

    const search = byName.get("memory_search");
    const found = await search?.execute({ query: "pnpm" }, { sessionID: "s1" });
    expect(found?.content).toContain("Use pnpm");

    const list = byName.get("memory_list");
    const listed = await list?.execute({}, { sessionID: "s1" });
    expect(listed?.content).toContain("Use pnpm");

    const forget = byName.get("memory_forget");
    const entryId = JSON.parse(listed?.content ?? "[]")[0]?.id;
    const deleted = await forget?.execute({ id: entryId }, { sessionID: "s1" });
    expect(deleted?.content).toContain("deleted 1");
    const after = await search?.execute({ query: "pnpm" }, { sessionID: "s1" });
    expect(after?.content).toContain("no matching memory entries");

    await cleanup?.();
  });

  it("refuses credentials with guidance instead of throwing", async () => {
    const dbPath = tmpDbPath();
    const { ctx, added } = fakeCtx(dbPath);
    const cleanup = await pluginModule.setup(ctx);
    const save = added.find((t) => t.name === "memory_save");

    const out = await save?.execute(
      { kind: "gotcha", title: "oops", body: "token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789" },
      { sessionID: "s1" },
    );
    expect(out?.content).toContain("refused");
    await cleanup?.();
  });

  it("refuses credentials hidden in the title", async () => {
    const dbPath = tmpDbPath();
    const { ctx, added } = fakeCtx(dbPath);
    const cleanup = await pluginModule.setup(ctx);
    const save = added.find((t) => t.name === "memory_save");

    const out = await save?.execute(
      { kind: "fact", title: "openai key sk-abcdefghij1234567890", body: "harmless" },
      { sessionID: "s1" },
    );
    expect(out?.content).toContain("refused");
    await cleanup?.();
  });

  it("memory_forget by query stays inside the plugin location scope", async () => {
    const dbPath = tmpDbPath();
    const { ctx, added } = fakeCtx(dbPath);
    const cleanup = await pluginModule.setup(ctx);
    const byName = new Map(added.map((t) => [t.name, t]));

    await byName
      .get("memory_save")
      ?.execute(
        { kind: "fact", title: "postgres batching", body: "uses postgres" },
        { sessionID: "s1" },
      );
    await byName
      .get("memory_save")
      ?.execute(
        { kind: "fact", title: "postgres sharding", body: "uses postgres", scope: "/home/u/other" },
        { sessionID: "s1" },
      );

    const deleted = await byName
      .get("memory_forget")
      ?.execute({ query: "postgres" }, { sessionID: "s1" });
    expect(deleted?.content).toContain("deleted 1");

    const other = await byName
      .get("memory_list")
      ?.execute({ scope: "/home/u/other" }, { sessionID: "s1" });
    expect(other?.content).toContain("sharding");
    await cleanup?.();
  });

  it("caps the number of returned entries whatever the requested limit", async () => {
    const dbPath = tmpDbPath();
    const { ctx, added } = fakeCtx(dbPath);
    const cleanup = await pluginModule.setup(ctx);
    const byName = new Map(added.map((t) => [t.name, t]));

    for (let i = 0; i < MAX_LIMIT + 5; i++) {
      await byName
        .get("memory_save")
        ?.execute(
          { kind: "fact", title: `postgres note ${i}`, body: "x".repeat(8000) },
          { sessionID: "s1" },
        );
    }

    const search = byName.get("memory_search");
    const rawHuge = String(
      (await search?.execute({ query: "postgres", limit: 1e9 }, { sessionID: "s1" }))?.content,
    );
    expect(JSON.parse(rawHuge)).toHaveLength(MAX_LIMIT);
    expect(rawHuge).toContain("truncated");
    await cleanup?.();
  });

  it("sees entries written by the v1 entry point under the same scope", async () => {
    const dbPath = tmpDbPath();
    const { ctx, added } = fakeCtx(dbPath);
    const cleanupV2 = await pluginModule.setup(ctx);
    const v2 = new Map(added.map((t) => [t.name, t]));

    const v1Hooks = await MemoryPlugin(v1Input(), { dbPath });
    const v1Tools = v1Hooks.tool ?? {};

    // Same location string: the v1 session worktree and the v2 plugin directory.
    await v1Tools.memory_save?.execute(
      { kind: "decision", title: "cross host decision", body: "written by the v1 host" },
      v1ToolContext(),
    );

    const found = await v2
      .get("memory_search")
      ?.execute({ query: "cross host" }, { sessionID: "s1" });
    expect(found?.content).toContain("cross host decision");

    await v1Hooks.dispose?.();
    await cleanupV2?.();
  });

  it("reports a readable error for invalid input instead of throwing", async () => {
    const dbPath = tmpDbPath();
    const { ctx, added } = fakeCtx(dbPath);
    const cleanup = await pluginModule.setup(ctx);
    const save = added.find((t) => t.name === "memory_save");

    const out = await save?.execute({ kind: "fact", title: "", body: "x" }, { sessionID: "s1" });
    expect(out?.content).toContain("error:");
    expect(out?.content).toContain("title");
    await cleanup?.();
  });

  it("explains usage when forget has no argument, and reports an empty store", async () => {
    const dbPath = tmpDbPath();
    const { ctx, added } = fakeCtx(dbPath);
    const cleanup = await pluginModule.setup(ctx);
    const byName = new Map(added.map((t) => [t.name, t]));

    expect((await byName.get("memory_forget")?.execute({}, { sessionID: "s1" }))?.content).toBe(
      "provide id or query",
    );
    expect((await byName.get("memory_list")?.execute({}, { sessionID: "s1" }))?.content).toBe(
      "no memory entries",
    );
    await cleanup?.();
  });

  it("injects system guidance on context and compaction hooks", async () => {
    const dbPath = tmpDbPath();
    const { ctx, sessionHooks } = fakeCtx(dbPath);
    const cleanup = await pluginModule.setup(ctx);

    expect(sessionHooks.get("context")).toBeDefined();
    expect(sessionHooks.get("compaction")).toBeDefined();

    const contextEvent = { system: [] as Array<{ type: string; text: string }>, messages: [] };
    sessionHooks.get("context")?.(contextEvent as never);
    expect(contextEvent.system[0]?.text).toContain("persistent working memory");

    const compactionEvent = { system: [] as Array<{ type: string; text: string }>, messages: [] };
    sessionHooks.get("compaction")?.(compactionEvent as never);
    expect(compactionEvent.system[0]?.text).toContain("compacted");

    await cleanup?.();
  });

  it("lists stored entries in the compaction context", async () => {
    const dbPath = tmpDbPath();
    const { ctx, added, sessionHooks } = fakeCtx(dbPath);
    const cleanup = await pluginModule.setup(ctx);
    const byName = new Map(added.map((t) => [t.name, t]));
    await byName
      .get("memory_save")
      ?.execute(
        { kind: "decision", title: "Use WAL mode", body: "journal_mode=WAL" },
        { sessionID: "s1" },
      );

    const event = { system: [] as Array<{ type: string; text: string }>, messages: [] };
    sessionHooks.get("compaction")?.(event as never);

    expect(event.system).toHaveLength(2);
    expect(event.system[1]?.text).toContain("Use WAL mode");
    expect(event.system[1]?.text).toContain("Memory already stored");
    await cleanup?.();
  });

  it("injects the inventory once per session on the first request that has entries", async () => {
    const dbPath = tmpDbPath();
    const { ctx, added, sessionHooks } = fakeCtx(dbPath);
    const cleanup = await pluginModule.setup(ctx);
    const byName = new Map(added.map((t) => [t.name, t]));
    await byName
      .get("memory_save")
      ?.execute({ kind: "fact", title: "Adopt batching", body: "batch 1000" }, { sessionID: "s1" });

    const context = sessionHooks.get("context") as
      | ((event: { sessionID?: string; system: Array<{ type: string; text: string }> }) => void)
      | undefined;
    const event = (sessionID?: string) => ({
      sessionID,
      system: [] as Array<{ type: string; text: string }>,
    });

    const first = event("s1");
    context?.(first as never);
    expect(first.system).toHaveLength(2);
    expect(first.system[1]?.text).toContain("Adopt batching");

    const second = event("s1");
    context?.(second as never);
    expect(second.system).toHaveLength(1);
    expect(second.system[0]?.text).toContain("memory_search");

    const third = event("s2");
    context?.(third as never);
    expect(third.system).toHaveLength(2);
    expect(third.system[1]?.text).toContain("Adopt batching");
    await cleanup?.();
  });

  it("creates the default db directory when missing", async () => {
    const dbPath = join(tmpdir(), `opencode-memory-v2-${Date.now()}`, "nested", "memory.db");
    const { ctx, added } = fakeCtx(dbPath);
    const cleanup = await pluginModule.setup(ctx);
    const save = added.find((t) => t.name === "memory_save");
    const out = await save?.execute({ kind: "fact", title: "t", body: "b" }, { sessionID: "s1" });
    expect(out?.content).toContain("saved");
    expect(existsSync(dbPath)).toBe(true);
    rmSync(join(tmpdir(), `opencode-memory-v2-${Date.now()}`), { recursive: true, force: true });
    await cleanup?.();
  });

  it("wires no event subscription when reflection is disabled", async () => {
    const { ctx } = fakeCtx(tmpDbPath());
    const cleanup = await pluginModule.setup(ctx);
    expect(ctx.event.subscribe as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    await cleanup?.();
  });

  it("distills the session tail into lessons on session.idle", async () => {
    const dbPath = tmpDbPath();
    const { ctx } = fakeCtx(
      dbPath,
      { reflection: { enabled: true } },
      {
        events: [{ type: "session.idle", data: { sessionID: "s1" } }],
        sessionGet: () => ({}),
        context: () => [
          {
            type: "user",
            text: "migrate the postgres tables tonight, the script is scripts/migrate.ts and it currently fires one giant UPDATE",
          },
          {
            type: "assistant",
            content: [
              {
                type: "text",
                text: "batching by 1000 rows avoided the lock contention; applied the same batch size to the cleanup query and the whole run finished clean",
              },
            ],
          },
        ],
        generateText: () =>
          Promise.resolve({
            text: '[{"title":"batch updates","body":"batching by 1000 avoided lock contention"}]',
          }),
      },
    );
    const cleanup = await pluginModule.setup(ctx);

    const db = openMemoryDb(dbPath);
    await vi.waitFor(() => {
      expect(
        list(db, { scope: "/home/u/project" }).some(
          (e) => e.kind === "lesson" && e.title === "batch updates",
        ),
      ).toBe(true);
    });
    db.close();
    await cleanup?.();
  });

  it("skips subagent sessions", async () => {
    const { ctx } = fakeCtx(
      tmpDbPath(),
      { reflection: { enabled: true } },
      {
        events: [{ type: "session.idle", data: { sessionID: "child1" } }],
        sessionGet: () => ({ parentID: "s1" }),
        context: () => [],
      },
    );
    const cleanup = await pluginModule.setup(ctx);
    await new Promise((r) => setTimeout(r, 30));
    expect(ctx.generate.text).not.toHaveBeenCalled();
    await cleanup?.();
  });
});

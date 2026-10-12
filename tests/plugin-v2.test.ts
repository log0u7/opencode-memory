import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type { Plugin } from "@opencode/plugin";

import { pluginModule } from "../src/index.js";

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

function fakeCtx(dbPath: string) {
  const added: AddedTool[] = [];
  const sessionHooks = new Map<
    string,
    (event: { system: Array<{ type: string; text: string }>; messages: unknown[] }) => void
  >();

  const ctx = {
    location: { directory: "/home/u/project" },
    options: { dbPath },
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
    },
    event: { subscribe: () => (async function* () {})() },
  } as unknown as Plugin.Context;

  return { ctx, added, sessionHooks };
}

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
});

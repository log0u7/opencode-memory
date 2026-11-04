import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Plugin } from "@opencode/plugin";
import type { ToolContext } from "@opencode-ai/plugin";

import { MemoryPlugin } from "../src/plugin.js";
import { pluginModule } from "../src/index.js";
import { list, MAX_LIMIT } from "../src/lib/store.js";
import { openMemoryDb } from "../src/lib/db.js";
import { writeTranscriptFile } from "../src/compaction.js";

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
    context: { sessionID: string; agent?: string },
  ) => Promise<{ content?: string }>;
};

type AddedCommand = {
  name: string;
  execute: (input: {
    sessionID: string;
    prompt: { text: string };
    delivery: "steer" | "queue";
  }) => Promise<void>;
};

type V2Event = { type: string; data: { sessionID: string } };

function fakeCtx(
  dbPath: string,
  options: Record<string, unknown> = {},
  fixtures: {
    events?: V2Event[];
    subscribe?: () => AsyncIterable<V2Event>;
    sessionGet?: () => Record<string, unknown>;
    context?: () => unknown[];
    sessions?: Array<{ id?: string; location?: { directory?: string } }>;
    generateText?: () => Promise<{ text: string }>;
  } = {},
) {
  const added: AddedTool[] = [];
  const commands: AddedCommand[] = [];
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
      prompt: vi.fn(async () => ({})),
      list: vi.fn(async () => ({ data: fixtures.sessions ?? [], cursor: {} })),
    },
    command: {
      transform: async (fn: (editor: { add: (definition: AddedCommand) => void }) => void) =>
        fn({ add: (definition) => commands.push(definition) }),
    },
    generate: { text: vi.fn(fixtures.generateText ?? (async () => ({ text: "[]" }))) },
    event: {
      subscribe: vi.fn(
        fixtures.subscribe ??
          (() =>
            (async function* () {
              for (const event of fixtures.events ?? []) {
                yield event;
              }
            })()),
      ),
    },
  } as unknown as Plugin.Context;

  return { ctx, added, sessionHooks, commands };
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
    // Same shape from both hosts; the receipt differs because the second save rewrites
    // the row the first one created, which is exactly what the receipt reports.
    expect(await v1.memory_save?.execute(saveArgs, v1Scope)).toMatch(
      /^saved [0-9a-f-]{36} \(\/home\/u\/project, created\)$/,
    );
    expect((await v2.get("memory_save")?.execute(saveArgs, { sessionID: "s1" }))?.content).toMatch(
      /^saved [0-9a-f-]{36} \(\/home\/u\/project, updated\)$/,
    );

    const searchArgs = { query: "parity" };
    expect(await v1.memory_search?.execute(searchArgs, v1Scope)).toBe(
      (await v2.get("memory_search")?.execute(searchArgs, { sessionID: "s1" }))?.content,
    );
    expect(await v1.memory_list?.execute({}, v1Scope)).toBe(
      (await v2.get("memory_list")?.execute({}, { sessionID: "s1" }))?.content,
    );

    const forgetArgs = { query: "parity" };
    expect(await v1.memory_forget?.execute(forgetArgs, v1Scope)).toMatch(
      /^deleted 1 entry: "Parity check" \([0-9a-f-]{36}\)$/,
    );
    // Recreate through the other host so both sides forget from the same state.
    expect((await v2.get("memory_save")?.execute(saveArgs, { sessionID: "s1" }))?.content).toMatch(
      /^saved [0-9a-f-]{36} \(\/home\/u\/project, created\)$/,
    );
    expect(
      (await v2.get("memory_forget")?.execute(forgetArgs, { sessionID: "s1" }))?.content,
    ).toMatch(/^deleted 1 entry: "Parity check" \([0-9a-f-]{36}\)$/);

    await hooks.dispose?.();
    await cleanupV2?.();
  });

  it("records the calling agent as the writer of an entry", async () => {
    const dbPath = tmpDbPath();
    const { ctx, added } = fakeCtx(dbPath);
    const cleanupV2 = await pluginModule.setup(ctx);
    const save = added.find((t) => t.name === "memory_save");
    const list = added.find((t) => t.name === "memory_list");

    await save?.execute(
      { kind: "fact", title: "agent note", body: "x" },
      { sessionID: "s1", agent: "build" },
    );

    const content = (await list?.execute({}, { sessionID: "s1" }))?.content ?? "[]";
    expect(JSON.parse(content)[0].source).toBe("build");
    await cleanupV2?.();
  });
});

describe("opencode-memory v2 setup", () => {
  it("registers the six memory tools", async () => {
    const dbPath = tmpDbPath();
    const { ctx, added } = fakeCtx(dbPath);

    const cleanup = await pluginModule.setup(ctx);
    const names = added.map((t) => t.name).sort();
    expect(names).toEqual([
      "memory_forget",
      "memory_list",
      "memory_restore",
      "memory_save",
      "memory_search",
      "memory_session_read",
      "memory_session_search",
      "memory_stats",
    ]);
    await cleanup?.();
  });

  it("reports counts per kind through memory_stats", async () => {
    const dbPath = tmpDbPath();
    const { ctx, added } = fakeCtx(dbPath);
    const cleanup = await pluginModule.setup(ctx);
    const byName = new Map(added.map((t) => [t.name, t]));

    const save = byName.get("memory_save");
    await save?.execute(
      { kind: "lesson", title: "retry with backoff", body: "b" },
      { sessionID: "s1" },
    );
    await save?.execute({ kind: "fact", title: "port 5432", body: "b" }, { sessionID: "s1" });

    const result = await byName.get("memory_stats")?.execute({}, { sessionID: "s1" });
    expect(result?.content).toContain("lesson: 1");
    expect(result?.content).toContain("fact: 1");
    expect(result?.content).toContain("total: 2");
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

  it("exports the transcript and sets the pointer when compaction runs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opencode-memory-wire-"));
    dirs.push(dir);
    const dbPath = join(dir, "memory.db");
    const { ctx, sessionHooks } = fakeCtx(dbPath, {
      retrieval: { dir: join(dir, "transcripts") },
    });
    const cleanup = await pluginModule.setup(ctx);

    const event = {
      system: [] as Array<{ type: string; text: string }>,
      sessionID: "ses_w",
      model: { providerID: "p", id: "m" },
      messages: [{ role: "user", content: [{ type: "text", text: "wire me" }] }],
    };
    await sessionHooks.get("compaction")?.(event as never);

    expect(
      existsSync(join(dir, "transcripts", encodeURIComponent("/home/u/project"), "ses_w.md")),
    ).toBe(true);
    const result = (event as { result?: { summary: string } }).result;
    expect(result?.summary).toContain("ses_w.md");
    expect(result?.summary).toContain("Never guess: retrieve.");
    await cleanup?.();
  });

  it("keeps the plain compaction flow when retrieval is disabled", async () => {
    const dbPath = tmpDbPath();
    const { ctx, added, sessionHooks } = fakeCtx(dbPath, { retrieval: { enabled: false } });
    const cleanup = await pluginModule.setup(ctx);
    const names = added.map((t) => t.name);
    expect(names).not.toContain("memory_session_search");
    expect(names).not.toContain("memory_session_read");

    const event = {
      system: [] as Array<{ type: string; text: string }>,
      sessionID: "ses_d",
      messages: [{ role: "user", content: [{ type: "text", text: "x" }] }],
    };
    await sessionHooks.get("compaction")?.(event as never);
    expect((event as { result?: unknown }).result).toBeUndefined();
    await cleanup?.();
  });

  it("limits the search to the requested session, not its siblings", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opencode-memory-scope-"));
    dirs.push(dir);
    const transcriptsDir = join(dir, "transcripts");
    const scopeDir = join(transcriptsDir, encodeURIComponent("/home/u/project"));
    writeTranscriptFile(join(scopeDir, "ses_one.md"), "## user\nsecret-one here\n");
    writeTranscriptFile(join(scopeDir, "ses_two.md"), "## user\nsecret-two here\n");
    const { ctx, added } = fakeCtx(join(dir, "memory.db"), {
      retrieval: { dir: transcriptsDir },
    });
    const cleanup = await pluginModule.setup(ctx);
    const byName = new Map(added.map((t) => [t.name, t]));
    const out = await byName
      .get("memory_session_search")
      ?.execute({ query: "secret", sessionID: "ses_one" }, { sessionID: "s1" });
    expect(out?.content).toContain("ses_one.md");
    expect(out?.content).not.toContain("ses_two.md");
    await cleanup?.();
  });

  it("hides memory-continue when retrieval is disabled", async () => {
    const { ctx, commands } = fakeCtx(tmpDbPath(), { retrieval: { enabled: false } });
    const cleanup = await pluginModule.setup(ctx);
    expect(commands.map((c) => c.name)).not.toContain("memory-continue");
    await cleanup?.();
  });

  it("falls back to the model summary when the transcript export fails", async () => {
    if (process.platform === "win32") {
      return;
    }
    const dir = mkdtempSync(join(tmpdir(), "opencode-memory-ro-"));
    dirs.push(dir);
    const restricted = join(dir, "restricted");
    mkdirSync(restricted, { mode: 0o500 });
    const { ctx, sessionHooks } = fakeCtx(join(dir, "memory.db"), {
      retrieval: { dir: join(restricted, "transcripts") },
    });
    const cleanup = await pluginModule.setup(ctx);
    const event = {
      system: [] as Array<{ type: string; text: string }>,
      sessionID: "ses_ro",
      model: { providerID: "p", id: "m" },
      messages: [{ role: "user", content: [{ type: "text", text: "survive me" }] }],
    };
    await sessionHooks.get("compaction")?.(event as never);
    chmodSync(restricted, 0o700);
    expect((event as { result?: unknown }).result).toBeUndefined();
    expect((event as { system: unknown[] }).system.length).toBeGreaterThan(0);
    await cleanup?.();
  });

  it("exports a missing session transcript on demand through the retrieval tools", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opencode-memory-lazy-"));
    dirs.push(dir);
    const dbPath = join(dir, "memory.db");
    const { ctx, added } = fakeCtx(
      dbPath,
      { retrieval: { dir: join(dir, "transcripts") } },
      {
        sessionGet: () => ({ location: { directory: "/home/u/other" } }),
        context: () => [
          { type: "user", text: "lazy user line" },
          { type: "assistant", content: [{ type: "text", text: "lazy assistant line" }] },
        ],
      },
    );
    const cleanup = await pluginModule.setup(ctx);
    const byName = new Map(added.map((t) => [t.name, t]));

    const out = await byName
      .get("memory_session_search")
      ?.execute({ query: "lazy user", sessionID: "ses_lazy" }, { sessionID: "s1" });
    expect(out?.content).toContain("lazy user line");
    expect(
      existsSync(join(dir, "transcripts", encodeURIComponent("/home/u/other"), "ses_lazy.md")),
    ).toBe(true);

    // The read tool finds the same exported transcript without a second export.
    const read = await byName
      .get("memory_session_read")
      ?.execute({ sessionID: "ses_lazy", offset: 5, limit: 2 }, { sessionID: "s1" });
    expect(read?.content).toContain("lazy user line");
    await cleanup?.();
  });

  it("exports on demand honoring the configured output cap", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opencode-memory-lazy-"));
    dirs.push(dir);
    const { ctx, added } = fakeCtx(
      join(dir, "memory.db"),
      { retrieval: { dir: join(dir, "transcripts"), inlineOutputMaxBytes: 1000 } },
      {
        sessionGet: () => ({ location: { directory: "/home/u/other" } }),
        context: () => [
          {
            type: "assistant",
            content: [
              {
                type: "tool-result",
                id: "c1",
                name: "shell",
                result: { type: "text", value: "z".repeat(5000) },
              },
            ],
          },
        ],
      },
    );
    const cleanup = await pluginModule.setup(ctx);
    const byName = new Map(added.map((t) => [t.name, t]));
    await byName
      .get("memory_session_search")
      ?.execute({ query: "truncated", sessionID: "ses_cap" }, { sessionID: "s1" });
    const file = join(dir, "transcripts", encodeURIComponent("/home/u/other"), "ses_cap.md");
    const body = readFileSync(file, "utf8");
    expect(body).toContain("[truncated; tool call id: c1]");
    expect(body.length).toBeLessThan(3000);
    await cleanup?.();
  });

  it("reports an unexportable session instead of failing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opencode-memory-lazy-"));
    dirs.push(dir);
    const { ctx, added } = fakeCtx(join(dir, "memory.db"), {
      retrieval: { dir: join(dir, "transcripts") },
    });
    const cleanup = await pluginModule.setup(ctx);
    const byName = new Map(added.map((t) => [t.name, t]));
    const out = await byName
      .get("memory_session_read")
      ?.execute({ sessionID: "ses_nope" }, { sessionID: "s1" });
    expect(out?.content).toContain("ses_nope");
    await cleanup?.();
  });

  it("memory-continue injects the pointer for a lazy-exported session", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opencode-memory-cmd-"));
    dirs.push(dir);
    const { ctx, commands } = fakeCtx(
      join(dir, "memory.db"),
      { retrieval: { dir: join(dir, "transcripts") } },
      {
        sessionGet: () => ({ location: { directory: "/home/u/other" } }),
        context: () => [{ type: "user", text: "continued request" }],
      },
    );
    const cleanup = await pluginModule.setup(ctx);
    const command = commands.find((c) => c.name === "memory-continue");
    expect(command).toBeDefined();

    await command?.execute({
      sessionID: "ses_cur",
      prompt: { text: "ses_old" },
      delivery: "queue",
    });
    const call = (ctx.session.prompt as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as
      | { sessionID: string; text: string; delivery: string }
      | undefined;
    expect(call?.sessionID).toBe("ses_cur");
    expect(call?.delivery).toBe("queue");
    expect(call?.text).toContain("ses_old.md");
    expect(call?.text).toContain("continued request");
    expect(call?.text).toContain("Never guess: retrieve.");
    await cleanup?.();
  });

  it("memory-continue explains a missing session id argument", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opencode-memory-cmd-"));
    dirs.push(dir);
    const { ctx, commands } = fakeCtx(join(dir, "memory.db"), {
      retrieval: { dir: join(dir, "transcripts") },
    });
    const cleanup = await pluginModule.setup(ctx);
    const command = commands.find((c) => c.name === "memory-continue");
    await command?.execute({
      sessionID: "ses_cur",
      prompt: { text: "" },
      delivery: "steer",
    });
    const call = (ctx.session.prompt as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as
      | { text: string }
      | undefined;
    expect(call?.text).toContain("session id");
    expect(call?.text).not.toContain("could not be exported");
    await cleanup?.();
  });

  it("memory-continue explains an unexportable target", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opencode-memory-cmd-"));
    dirs.push(dir);
    const { ctx, commands } = fakeCtx(join(dir, "memory.db"), {
      retrieval: { dir: join(dir, "transcripts") },
    });
    const cleanup = await pluginModule.setup(ctx);
    const command = commands.find((c) => c.name === "memory-continue");
    await command?.execute({
      sessionID: "ses_cur",
      prompt: { text: "ses_ghost" },
      delivery: "steer",
    });
    const call = (ctx.session.prompt as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as
      | { text: string }
      | undefined;
    expect(call?.text).toContain("ses_ghost");
    expect(call?.text).toContain("could not be exported");
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

  it("reconnects the event stream after it throws", async () => {
    const dbPath = tmpDbPath();
    const line =
      "migrate the postgres tables tonight; the script is scripts/migrate.ts and the first attempt fired one giant UPDATE";
    let calls = 0;
    const subscribe = () =>
      (async function* () {
        calls += 1;
        if (calls === 1) {
          throw new Error("stream reset");
        }
        yield { type: "session.idle", data: { sessionID: "s1" } };
      })();
    const { ctx } = fakeCtx(
      dbPath,
      { reflection: { enabled: true } },
      {
        subscribe,
        sessionGet: () => ({}),
        context: () => [
          { type: "user", text: line },
          {
            type: "assistant",
            content: [
              {
                type: "text",
                text: `${line} and it hit lock contention; batching by 1000 rows avoided it and the cleanup query finished clean`,
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
    await vi.waitFor(
      () => {
        expect(
          list(db, { scope: "/home/u/project" }).some(
            (e) => e.kind === "lesson" && e.title === "batch updates",
          ),
        ).toBe(true);
      },
      { timeout: 3000 },
    );
    db.close();
    await cleanup?.();
    expect(ctx.event.subscribe).toHaveBeenCalledTimes(2);
  });

  it("does not reopen the store after cleanup", async () => {
    const dbPath = tmpDbPath();
    const { ctx, added, sessionHooks } = fakeCtx(dbPath);
    const cleanup = await pluginModule.setup(ctx);
    const save = added.find((t) => t.name === "memory_save");

    await save?.execute({ kind: "fact", title: "before", body: "x" }, { sessionID: "s1" });

    const before = { system: [] as Array<{ type: string; text: string }>, messages: [] };
    sessionHooks.get("context")?.(before);
    expect(before.system).toHaveLength(2);

    await cleanup?.();
    for (const suffix of ["", "-wal", "-shm"]) {
      rmSync(`${dbPath}${suffix}`, { force: true });
    }

    const out = await save?.execute(
      { kind: "fact", title: "after", body: "y" },
      { sessionID: "s1" },
    );
    expect(out?.content).toContain("error:");
    expect(existsSync(dbPath)).toBe(false);

    const event = { system: [] as Array<{ type: string; text: string }>, messages: [] };
    expect(() => sessionHooks.get("context")?.(event)).not.toThrow();
    expect(event.system).toHaveLength(1);
    expect(existsSync(dbPath)).toBe(false);
  });
});

import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MemoryPlugin } from "../src/plugin.js";
import { list } from "../src/lib/store.js";
import { MAX_LIMIT } from "../src/lib/store.js";
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

function fakeInput(overrides: Record<string, unknown> = {}) {
  return {
    client: {} as never,
    project: { id: "p1" } as never,
    directory: WORKTREE,
    worktree: WORKTREE,
    experimental_workspace: {} as never,
    serverUrl: new URL("http://localhost:4096"),
    $: (() => Promise.resolve()) as never,
    ...overrides,
  };
}

function reflectionClient() {
  return {
    session: {
      get: vi.fn(async () => ({ data: { id: "s1" } })),
      messages: vi.fn(async () => ({
        data: [
          {
            info: { role: "user" },
            parts: [
              {
                type: "text",
                text: "migrate the postgres tables tonight, the migration script is scripts/migrate.ts",
              },
              {
                type: "text",
                text: "the first attempt fired one giant UPDATE and hit lock contention for forty seconds",
              },
            ],
          },
          {
            info: { role: "assistant" },
            parts: [
              {
                type: "text",
                text: "batching by 1000 rows avoided the contention; applied the same batch size to the cleanup query and the run finished clean",
              },
            ],
          },
        ],
      })),
      create: vi.fn(async () => ({ data: { id: "child1", parentID: "s1" } })),
      prompt: vi.fn(async () => ({
        data: {
          parts: [
            {
              type: "text",
              text: '[{"title":"batch updates","body":"batching by 1000 avoided lock contention"}]',
            },
          ],
        },
      })),
      delete: vi.fn(async () => ({ data: undefined })),
    },
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

  it("memory_forget by query stays inside the session scope", async () => {
    const tools = await loadTools({ dbPath: join(dir, "m.db") });

    await tools.memory_save?.execute(
      { kind: "fact", title: "postgres batching", body: "uses postgres", tags: [] },
      ctx(),
    );
    await tools.memory_save?.execute(
      {
        kind: "fact",
        title: "postgres sharding",
        body: "uses postgres",
        tags: [],
        scope: "/work/other",
      },
      ctx(),
    );

    const deleted = await tools.memory_forget?.execute({ query: "postgres" }, ctx());
    expect(deleted).toContain("deleted 1");

    expect(await tools.memory_list?.execute({ scope: "/work/other" }, ctx())).toContain("sharding");
  });

  it("caps search and list output instead of dumping the store", async () => {
    const tools = await loadTools({ dbPath: join(dir, "m.db") });
    for (let i = 0; i < MAX_LIMIT + 5; i++) {
      await tools.memory_save?.execute(
        { kind: "fact", title: `postgres note ${i}`, body: "x".repeat(8000), tags: [] },
        ctx(),
      );
    }

    const raw = String(
      await tools.memory_search?.execute({ query: "postgres", limit: 1e9 }, ctx()),
    );
    expect(JSON.parse(raw)).toHaveLength(MAX_LIMIT);
    expect(raw).toContain("[truncated]");
  });

  it("refuses credentials hidden in the title", async () => {
    const tools = await loadTools({ dbPath: join(dir, "m.db") });
    const result = await tools.memory_save?.execute(
      { kind: "fact", title: "openai key sk-abcdefghij1234567890", body: "harmless", tags: [] },
      ctx(),
    );
    expect(result).toContain("credential");
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

describe("memory plugin error paths", () => {
  it("returns a readable error for invalid input instead of throwing", async () => {
    const tools = await loadTools({ dbPath: join(dir, "m2.db") });
    const result = await tools.memory_save?.execute(
      { kind: "fact", title: "", body: "x", tags: [] },
      ctx(),
    );
    expect(result).toContain("error:");
    expect(result).toContain("title");
  });

  it("defaults the store path to XDG data home when no option is given", async () => {
    process.env.XDG_DATA_HOME = dir;
    try {
      const hooks = await MemoryPlugin(fakeInput());
      const tools = hooks.tool ?? {};
      const saved = await tools.memory_save?.execute(
        { kind: "fact", title: "xdg", body: "uses xdg data home", tags: [] },
        ctx(),
      );
      expect(saved).toContain("saved");
      expect(statSync(join(dir, "opencode-memory", "memory.db")).isFile()).toBe(true);
      await hooks.dispose?.();
    } finally {
      delete process.env.XDG_DATA_HOME;
    }
  });
});

describe("memory plugin remaining branches", () => {
  it("memory_forget without id or query explains usage", async () => {
    const tools = await loadTools({ dbPath: join(dir, "m3.db") });
    const result = await tools.memory_forget?.execute({}, ctx());
    expect(result).toBe("provide id or query");
  });

  it("dispose is idempotent (second call with closed db)", async () => {
    const hooks = await MemoryPlugin(fakeInput(), { dbPath: join(dir, "m4.db") });
    await hooks.dispose?.();
    await expect(hooks.dispose?.()).resolves.toBeUndefined();
  });
});

describe("memory plugin empty results", () => {
  it("search and list report empty stores readably", async () => {
    const tools = await loadTools({ dbPath: join(dir, "m5.db") });
    expect(await tools.memory_search?.execute({ query: "nothing" }, ctx())).toBe(
      "no matching memory entries",
    );
    expect(await tools.memory_list?.execute({}, ctx())).toBe("no memory entries");
  });
});

describe("memory plugin reflection", () => {
  it("wires no event hook when reflection is disabled", async () => {
    const hooks = await MemoryPlugin(fakeInput(), { dbPath: join(dir, "r0.db") });
    expect(hooks.event).toBeUndefined();
  });

  it("distills a session tail into lessons on session.idle", async () => {
    const dbPath = join(dir, "r1.db");
    const client = reflectionClient();
    const hooks = await MemoryPlugin(fakeInput({ client: client as never }), {
      dbPath,
      reflection: { enabled: true },
    });
    const event = hooks.event;
    expect(event).toBeDefined();

    await event?.({ event: { type: "session.idle", properties: { sessionID: "s1" } } as never });

    const { openMemoryDb } = await import("../src/lib/db.js");
    const db = openMemoryDb(dbPath);
    await vi.waitFor(() => {
      expect(
        list(db, { scope: WORKTREE }).some(
          (e) => e.kind === "lesson" && e.title === "batch updates",
        ),
      ).toBe(true);
    });
    db.close();

    expect(client.session.create).toHaveBeenCalled();
    expect(client.session.delete).toHaveBeenCalledWith({ path: { id: "child1" } });
  });

  it("ignores non-idle events", async () => {
    const client = reflectionClient();
    const hooks = await MemoryPlugin(fakeInput({ client: client as never }), {
      dbPath: join(dir, "r2.db"),
      reflection: { enabled: true },
    });
    await hooks.event?.({
      event: { type: "session.status", properties: { sessionID: "s1" } } as never,
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(client.session.create).not.toHaveBeenCalled();
  });
});

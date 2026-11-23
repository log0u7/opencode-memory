import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Plugin } from "@opencode/plugin";

import { pluginModule } from "../src/index.js";
import { openMemoryDb, type MemoryDb } from "../src/lib/db.js";
import { createMemoryOps } from "../src/lib/memory-ops.js";
import { parseReflectionActivation, reflectionGuidance } from "../src/lib/reflection.js";
import { allLive, endorseEntry, forget, isShareable, saveEntry } from "../src/lib/store.js";

let dirs: string[] = [];
let db: MemoryDb;

function save(options: { source?: string; shareable?: boolean; title?: string } = {}) {
  return saveEntry(db, {
    scope: "/w",
    kind: "fact",
    title: options.title ?? "share this one",
    body: "b",
    tags: [],
    expires_at: null,
    ...(options.source !== undefined ? { source: options.source } : {}),
    ...(options.shareable !== undefined ? { shareable: options.shareable } : {}),
  }).entry;
}

// Minimal v2 host: the reflection contract is read through the context hook the
// plugin registers at setup, which pushes the standing guidance first.
function fakeCtx(dbPath: string, options: Record<string, unknown> = {}) {
  const sessionHooks = new Map<
    string,
    (event: { system: Array<{ type: string; text: string }>; messages: unknown[] }) => void
  >();
  const ctx = {
    location: { directory: "/home/u/project" },
    options: { dbPath, ...options },
    tool: {
      transform: async (fn: (editor: { add: (tool: unknown) => void }) => void) =>
        fn({ add: () => {} }),
    },
    session: {
      hook: async (name: string, fn: never) => {
        sessionHooks.set(name, fn);
      },
      get: async (input: { sessionID: string }) => ({ id: input.sessionID }),
      context: async () => [],
      prompt: async () => ({}),
      list: async () => ({ data: [], cursor: {} }),
    },
    command: { transform: async () => {} },
    generate: { text: async () => ({ text: "[]" }) },
    rpc: {
      register: async () => ({ dispose: async () => {}, events: { emit: async () => {} } }),
    },
    event: {
      subscribe: () =>
        (async function* () {
          // no events
        })(),
    },
  } as unknown as Plugin.Context;
  return { ctx, sessionHooks };
}

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "memory-endorsement-"));
  dirs.push(dir);
  db = openMemoryDb(join(dir, "memory.db"));
});

afterEach(() => {
  db.close();
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
  db = undefined as unknown as MemoryDb;
});

describe("endorsement quorum (store)", () => {
  it("an endorsement from a peer makes the entry shareable", () => {
    const entry = save({ source: "author" });
    expect(isShareable(entry)).toBe(false);

    const result = endorseEntry(db, { id: entry.id, endorser: "peer" });
    expect(result).not.toBeNull();
    expect(result?.created).toBe(true);
    expect(result?.shareable).toBe(true);
    expect(result?.entry.endorsed_by).toEqual(["peer"]);
    expect(isShareable(result?.entry as never)).toBe(true);
  });

  it("the author's own endorsement is recorded but never makes it shareable", () => {
    const entry = save({ source: "author" });

    const result = endorseEntry(db, { id: entry.id, endorser: "author" });
    expect(result?.created).toBe(true);
    expect(result?.shareable).toBe(false);
    expect(result?.entry.endorsed_by).toEqual(["author"]);
  });

  it("a second endorsement from the same peer changes nothing", () => {
    const entry = save({ source: "author" });
    endorseEntry(db, { id: entry.id, endorser: "peer" });

    const again = endorseEntry(db, { id: entry.id, endorser: "peer" });
    expect(again?.created).toBe(false);
    expect(again?.entry.endorsed_by).toEqual(["peer"]);
  });

  it("an unknown or trashed id yields null", () => {
    expect(endorseEntry(db, { id: "no-such-id", endorser: "peer" })).toBeNull();

    const entry = save();
    forget(db, { scope: "/w", id: entry.id });
    expect(endorseEntry(db, { id: entry.id, endorser: "peer" })).toBeNull();
  });
});

describe("endorsement receipts (ops)", () => {
  it("a peer endorsement reports the entry as shareable", () => {
    const ops = createMemoryOps(() => db);
    const entry = save({ source: "author" });

    expect(ops.endorse({ id: entry.id }, "peer")).toBe(`endorsed ${entry.id} (shareable)`);
  });

  it("the author's endorsement reports the entry as not shareable", () => {
    const ops = createMemoryOps(() => db);
    const entry = save({ source: "author" });

    expect(ops.endorse({ id: entry.id }, "author")).toBe(
      `endorsed ${entry.id} (not shareable: the endorser is the author)`,
    );
  });

  it("a repeat endorsement by the author reports already endorsed", () => {
    const ops = createMemoryOps(() => db);
    // The shareable-at-save marker already carries the author's endorsement.
    const entry = save({ source: "author", shareable: true });

    expect(ops.endorse({ id: entry.id }, "author")).toBe("error: already endorsed by you");
  });

  it("an unknown id reports entry not found", () => {
    const ops = createMemoryOps(() => db);

    expect(ops.endorse({ id: "no-such-id" }, "peer")).toBe("error: entry not found");
  });
});

describe("shareable at save", () => {
  it("a save with shareable: true records the author's endorsement", () => {
    const ops = createMemoryOps(() => db);
    ops.save({ kind: "fact", title: "published", body: "b", shareable: true }, "/w", "author");

    const stored = allLive(db, "/w").find((e) => e.title === "published");
    expect(stored?.endorsed_by).toEqual(["author"]);
    expect(isShareable(stored as never)).toBe(false);
  });

  it("a plain save records no endorsement", () => {
    const ops = createMemoryOps(() => db);
    ops.save({ kind: "fact", title: "unpublished", body: "b" }, "/w", "author");

    const stored = allLive(db, "/w").find((e) => e.title === "unpublished");
    expect(stored?.endorsed_by).toBeUndefined();
  });

  it("a rewrite keeps peer endorsements and adds the author's marker when published", () => {
    const entry = save({ source: "author" });
    endorseEntry(db, { id: entry.id, endorser: "peer" });

    const rewritten = saveEntry(db, {
      scope: "/w",
      kind: "fact",
      title: "share this one",
      body: "b2",
      tags: [],
      expires_at: null,
      source: "author",
      shareable: true,
    }).entry;
    expect(rewritten.id).toBe(entry.id);
    expect(rewritten.endorsed_by).toEqual(["peer", "author"]);
    expect(isShareable(rewritten)).toBe(true);
  });
});

describe("reflection activation", () => {
  it("is on by default with the default budget", () => {
    expect(parseReflectionActivation(undefined)).toEqual({ enabled: true, maxPerDay: 3 });
  });

  it("reflection: false switches the loop off", () => {
    expect(parseReflectionActivation(false)).toEqual({ enabled: false, maxPerDay: 3 });
  });

  it("an object config without enabled: true stays off", () => {
    expect(parseReflectionActivation({ maxLessons: 7 }).enabled).toBe(false);
  });

  it("an enabled object config doubles maxLessons as the daily budget", () => {
    expect(parseReflectionActivation({ enabled: true, maxLessons: 7 })).toEqual({
      enabled: true,
      maxPerDay: 7,
    });
  });

  it("the directive names the lesson-saving contract", () => {
    const text = reflectionGuidance(7);
    expect(text).toContain("memory_save(kind=lesson");
    expect(text).toContain("At most 7 new lessons per day");
  });
});

describe("reflection guidance in the v2 system prompt", () => {
  it("carries the reflection directive by default", async () => {
    const dbPath = join(dirs[dirs.length - 1], "plugin.db");
    const { ctx, sessionHooks } = fakeCtx(dbPath);
    const cleanup = await pluginModule.setup(ctx);

    const event = { system: [] as Array<{ type: string; text: string }>, messages: [] };
    sessionHooks.get("context")?.(event as never);
    expect(event.system[0]?.text).toContain("persistent working memory");
    expect(event.system[0]?.text).toContain("Reflect in-context");
    await cleanup?.();
  });

  it("reflection: false keeps the standing guidance without the directive", async () => {
    const dbPath = join(dirs[dirs.length - 1], "plugin-off.db");
    const { ctx, sessionHooks } = fakeCtx(dbPath, { reflection: false });
    const cleanup = await pluginModule.setup(ctx);

    const event = { system: [] as Array<{ type: string; text: string }>, messages: [] };
    sessionHooks.get("context")?.(event as never);
    expect(event.system[0]?.text).toContain("persistent working memory");
    expect(event.system[0]?.text).not.toContain("Reflect in-context");
    await cleanup?.();
  });
});

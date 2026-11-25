import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openMemoryDb } from "../src/lib/db.js";
import { createMemoryOps, memoryInventory } from "../src/lib/memory-ops.js";
import { forget, neverRecalled, save, saveEntry, touchUsage } from "../src/lib/store.js";
import type { EntryInput } from "../src/types/entry.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const SCOPE = "/work/project";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "opencode-memory-usage-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function input(overrides: Partial<EntryInput> = {}): EntryInput {
  return {
    scope: SCOPE,
    kind: "fact",
    title: "entry",
    body: "some body",
    tags: [],
    expires_at: null,
    ...overrides,
  };
}

function usageOf(db: ReturnType<typeof openMemoryDb>, id: string) {
  return db.conn.get<{ use_count: number; last_used: number | null }>(
    "SELECT use_count, last_used FROM entries WHERE id = ?",
    [id],
  );
}

describe("usage tracking", () => {
  it("touchUsage increments use_count and stamps last_used", () => {
    const db = openMemoryDb(":memory:");
    const a = save(db, input({ title: "a" }));
    const b = save(db, input({ title: "b" }));

    touchUsage(db, [a.id], 1000);
    touchUsage(db, [a.id, b.id], 2000);

    expect(usageOf(db, a.id)).toEqual({ use_count: 2, last_used: 2000 });
    expect(usageOf(db, b.id)).toEqual({ use_count: 1, last_used: 2000 });
    db.close();
  });

  it("search touches the entries it serves, twice searched counts twice", () => {
    const db = openMemoryDb(":memory:");
    const ops = createMemoryOps(() => db);
    const hit = save(db, input({ title: "alpha hit", body: "alpha beta" }));
    const missed = save(db, input({ title: "unrelated", body: "gamma delta" }));

    ops.search({ query: "alpha" }, SCOPE);
    expect(usageOf(db, hit.id)?.use_count).toBe(1);
    expect(usageOf(db, hit.id)?.last_used).not.toBeNull();
    expect(usageOf(db, missed.id)).toEqual({ use_count: 0, last_used: null });

    ops.search({ query: "alpha" }, SCOPE);
    expect(usageOf(db, hit.id)?.use_count).toBe(2);
    db.close();
  });

  it("a search without hits touches nothing", () => {
    const db = openMemoryDb(":memory:");
    const ops = createMemoryOps(() => db);
    const entry = save(db, input({ title: "quiet" }));

    expect(ops.search({ query: "nothing matches this" }, SCOPE)).toBe("no matching memory entries");
    expect(usageOf(db, entry.id)).toEqual({ use_count: 0, last_used: null });
    db.close();
  });

  it("inventory touches the entries it injects, not the ones the budget cut", () => {
    const dbPath = join(dir, "m.db");
    const db = openMemoryDb(dbPath);
    const entries = [];
    for (let i = 0; i < 60; i++) {
      entries.push(
        save(
          db,
          input({ title: `entry number ${i} with a long descriptive title to fill the budget` }),
        ),
      );
    }

    const inventory = memoryInventory(() => db, dbPath, SCOPE) as string;
    const included = entries.filter((entry) => inventory.includes(entry.title));
    const cut = entries.filter((entry) => !inventory.includes(entry.title));
    expect(included.length).toBeGreaterThan(0);
    expect(cut.length).toBeGreaterThan(0);

    for (const entry of included) {
      expect(usageOf(db, entry.id)?.use_count).toBe(1);
    }
    for (const entry of cut) {
      expect(usageOf(db, entry.id)?.use_count).toBe(0);
    }
    db.close();
  });
});

describe("neverRecalled", () => {
  it("lists old unused entries, skips used and recent ones", () => {
    const db = openMemoryDb(":memory:");
    const now = Date.now();
    const old = save(db, input({ title: "old unused" }), { now: now - 40 * DAY_MS });
    const used = save(db, input({ title: "old used" }), { now: now - 40 * DAY_MS });
    save(db, input({ title: "recent" }), { now });
    touchUsage(db, [used.id], now);

    const result = neverRecalled(db, { scope: SCOPE, now });

    expect(result.map((entry) => entry.id)).toEqual([old.id]);
    db.close();
  });

  it("lists unanchored lessons not recalled for more than 30 days, even once used", () => {
    const db = openMemoryDb(":memory:");
    const now = Date.now();
    const lesson = save(db, input({ title: "stale lesson", kind: "lesson" }), {
      now: now - 40 * DAY_MS,
    });
    touchUsage(db, [lesson.id], now - 35 * DAY_MS);

    const result = neverRecalled(db, { scope: SCOPE, now });

    expect(result.map((entry) => entry.id)).toContain(lesson.id);
    db.close();
  });

  it("keeps recently recalled unanchored lessons out", () => {
    const db = openMemoryDb(":memory:");
    const now = Date.now();
    const lesson = save(db, input({ title: "fresh lesson", kind: "lesson" }), {
      now: now - 40 * DAY_MS,
    });
    touchUsage(db, [lesson.id], now - 5 * DAY_MS);

    expect(neverRecalled(db, { scope: SCOPE, now }).map((entry) => entry.id)).not.toContain(
      lesson.id,
    );
    db.close();
  });

  it("keeps anchored lessons out: the anchoring owns their lifecycle", () => {
    const db = openMemoryDb(":memory:");
    const now = Date.now();
    const lesson = save(
      db,
      input({
        title: "anchored lesson",
        kind: "lesson",
        paths: ["src/a.ts"],
        commit_sha: "abc1234",
      }),
      { now: now - 40 * DAY_MS },
    );
    touchUsage(db, [lesson.id], now - 35 * DAY_MS);

    expect(neverRecalled(db, { scope: SCOPE, now }).map((entry) => entry.id)).not.toContain(
      lesson.id,
    );
    db.close();
  });

  it("excludes superseded and tombstoned entries", () => {
    const db = openMemoryDb(":memory:");
    const now = Date.now();
    const replaced = save(db, input({ title: "replaced", body: "v1" }), { now: now - 40 * DAY_MS });
    saveEntry(
      db,
      { ...input({ title: "replacement", body: "v2" }), supersedes: replaced.id },
      { now },
    );
    const trashed = save(db, input({ title: "trashed" }), { now: now - 40 * DAY_MS });
    forget(db, { id: trashed.id, scope: SCOPE });

    expect(neverRecalled(db, { scope: SCOPE, now })).toEqual([]);
    db.close();
  });
});

describe("stats never-recalled section", () => {
  it("names the never-recalled entries as a purge proposal", () => {
    const db = openMemoryDb(":memory:");
    const ops = createMemoryOps(() => db);
    save(db, input({ title: "never served entry" }), { now: Date.now() - 40 * DAY_MS });

    const result = ops.stats(SCOPE);

    expect(result).toContain("never-recalled: 1");
    expect(result).toContain("never served entry");
    expect(result).toContain("memory_forget");
    db.close();
  });

  it("stays silent when every entry was used or is recent", () => {
    const db = openMemoryDb(":memory:");
    const ops = createMemoryOps(() => db);
    save(db, input({ title: "fresh entry" }));

    expect(ops.stats(SCOPE)).not.toContain("never-recalled");
    db.close();
  });

  it("proposes old unanchored never-recalled lessons", () => {
    const db = openMemoryDb(":memory:");
    const ops = createMemoryOps(() => db);
    save(db, input({ title: "immortal lesson", kind: "lesson" }), {
      now: Date.now() - 40 * DAY_MS,
    });

    const result = ops.stats(SCOPE);

    expect(result).toContain("never-recalled: 1");
    expect(result).toContain("immortal lesson");
    db.close();
  });
});

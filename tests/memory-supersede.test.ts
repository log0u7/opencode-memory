import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openMemoryDb } from "../src/lib/db.js";
import { createMemoryOps, memoryInventory } from "../src/lib/memory-ops.js";
import {
  forget,
  list,
  restore,
  save,
  saveEntry,
  search,
  suggestReplacements,
} from "../src/lib/store.js";
import type { EntryInput } from "../src/types/entry.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "opencode-memory-supersede-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function input(overrides: Partial<EntryInput> = {}): EntryInput {
  return {
    scope: "/work/project",
    kind: "fact",
    title: "postgres batching",
    body: "migrate in batches of 1000",
    tags: [],
    expires_at: null,
    ...overrides,
  };
}

type Lifecycle = { status: string; superseded_at: number | null; deleted_at: number | null };

function lifecycleOf(db: ReturnType<typeof openMemoryDb>, id: string): Lifecycle {
  const row = db.conn.get<Lifecycle>(
    "SELECT status, superseded_at, deleted_at FROM entries WHERE id = ?",
    [id],
  );
  return {
    status: row?.status ?? "",
    superseded_at: row?.superseded_at ?? null,
    deleted_at: row?.deleted_at ?? null,
  };
}

describe("store.save supersedes", () => {
  it("replaces a named entry instead of stacking a duplicate", () => {
    const db = openMemoryDb(":memory:");
    const a = save(db, input({ title: "postgres batching", body: "v1" }), { now: 1000 });
    const result = saveEntry(
      db,
      input({ title: "postgres batching v2", body: "v2", supersedes: a.id }),
      { now: 2000 },
    );

    expect(result.created).toBe(true);
    expect(result.superseded).toBe(a.id);
    expect(result.entry.supersedes).toBe(a.id);
    expect(result.entry.status).toBe("current");

    // The old row stays as a live tombstone: hidden, but restorable.
    expect(lifecycleOf(db, a.id)).toEqual({
      status: "superseded",
      superseded_at: 2000,
      deleted_at: null,
    });
    expect(list(db, { scope: "/work/project" }).map((e) => e.id)).toEqual([result.entry.id]);
    db.close();
  });

  it("tombstones the named entry even when the titles coincide", () => {
    const db = openMemoryDb(":memory:");
    const a = save(db, input({ body: "v1" }));
    const result = saveEntry(db, input({ body: "v2", supersedes: a.id }));

    // Superseding skips the title rewrite on purpose: a fresh row takes over.
    expect(result.entry.id).not.toBe(a.id);
    expect(result.superseded).toBe(a.id);
    expect(list(db, { scope: "/work/project" })).toHaveLength(1);
    expect(lifecycleOf(db, a.id).status).toBe("superseded");
    db.close();
  });

  it("refuses to supersede a missing, foreign or trashed entry", () => {
    const db = openMemoryDb(":memory:");
    const foreign = save(db, input({ scope: "/work/other" }));

    expect(() => saveEntry(db, input({ supersedes: "missing-id" }))).toThrow(TypeError);
    expect(() => saveEntry(db, input({ supersedes: foreign.id }))).toThrow(TypeError);
    // A refused link leaves the target untouched.
    expect(list(db, { scope: "/work/other" })).toHaveLength(1);

    forget(db, { id: foreign.id, scope: "/work/other" });
    expect(() => saveEntry(db, input({ supersedes: foreign.id }))).toThrow(TypeError);
    db.close();
  });

  it("keeps a title rewrite from resurrecting a superseded row", () => {
    const db = openMemoryDb(":memory:");
    const a = save(db, input({ title: "postgres batching", body: "v1" }));
    saveEntry(db, input({ title: "postgres batching v2", body: "v2", supersedes: a.id }));

    const third = saveEntry(db, input({ title: "postgres batching", body: "back again" }));

    expect(third.created).toBe(true);
    expect(third.entry.id).not.toBe(a.id);
    const shown = list(db, { scope: "/work/project" }).map((e) => e.id);
    expect(shown).not.toContain(a.id);
    expect(shown).toContain(third.entry.id);
    db.close();
  });

  it("restores a superseded entry and steps its replacement down", () => {
    const db = openMemoryDb(":memory:");
    const a = save(db, input({ title: "postgres batching", body: "v1" }), { now: 1000 });
    const b = saveEntry(
      db,
      input({ title: "postgres batching v2", body: "v2", supersedes: a.id }),
      { now: 2000 },
    ).entry;

    expect(restore(db, { id: a.id })?.id).toBe(a.id);

    expect(lifecycleOf(db, a.id)).toEqual({
      status: "current",
      superseded_at: null,
      deleted_at: null,
    });
    expect(lifecycleOf(db, b.id)).toEqual({
      status: "superseded",
      superseded_at: expect.any(Number),
      deleted_at: null,
    });
    expect(list(db, { scope: "/work/project" }).map((e) => e.id)).toEqual([a.id]);
    db.close();
  });
});

describe("superseded rows are invisible to reads", () => {
  it("keeps search and list on the current rows only", () => {
    const db = openMemoryDb(":memory:");
    const a = save(db, input({ title: "postgres batching" }));
    const b = saveEntry(db, input({ title: "postgres batching v2", supersedes: a.id })).entry;

    expect(search(db, { query: "postgres", scope: "/work/project" }).map((e) => e.id)).toEqual([
      b.id,
    ]);
    expect(list(db, { scope: "/work/project" }).map((e) => e.id)).toEqual([b.id]);
    db.close();
  });

  it("keeps the inventory on the current rows only", () => {
    const dbPath = join(dir, "m.db");
    const db = openMemoryDb(dbPath);
    const a = save(db, input({ title: "old batching plan" }));
    save(db, input({ title: "new batching plan", supersedes: a.id }));

    const inventory = memoryInventory(() => db, dbPath, "/work/project");
    expect(inventory).toContain("new batching plan");
    expect(inventory).not.toContain("old batching plan");
    db.close();
  });
});

describe("store.suggestReplacements", () => {
  it("proposes the same-kind same-scope entry a title could replace", () => {
    const db = openMemoryDb(":memory:");
    const a = save(db, input({ title: "postgres batching plan" }));
    save(db, input({ title: "docker compose notes" }));

    const suggestions = suggestReplacements(db, {
      scope: "/work/project",
      kind: "fact",
      title: "postgres batching strategy",
    });
    expect(suggestions.map((e) => e.id)).toEqual([a.id]);
    db.close();
  });

  it("fills the remaining slots with prefix matches after the strict ones", () => {
    const db = openMemoryDb(":memory:");
    const a = save(db, input({ title: "postgres batching plan" }));

    const suggestions = suggestReplacements(db, {
      scope: "/work/project",
      kind: "fact",
      title: "postgres batch",
    });
    expect(suggestions.map((e) => e.id)).toEqual([a.id]);
    db.close();
  });

  it("respects kind, scope, the exact-title rule and an explicit exclusion", () => {
    const db = openMemoryDb(":memory:");
    const a = save(db, input({ title: "postgres batching plan" }));

    const query = {
      scope: "/work/project",
      kind: "fact",
      title: "postgres batching strategy",
    };
    expect(suggestReplacements(db, { ...query, kind: "decision" })).toEqual([]);
    expect(suggestReplacements(db, { ...query, scope: "/work/other" })).toEqual([]);
    expect(suggestReplacements(db, { ...query, title: "postgres batching plan" })).toEqual([]);
    expect(suggestReplacements(db, { ...query, excludeId: a.id })).toEqual([]);
    db.close();
  });

  it("returns nothing when no entry is close", () => {
    const db = openMemoryDb(":memory:");
    save(db, input({ title: "postgres batching plan" }));

    expect(
      suggestReplacements(db, { scope: "/work/project", kind: "fact", title: "zebra qux" }),
    ).toEqual([]);
    expect(suggestReplacements(db, { scope: "/work/project", kind: "fact", title: "   " })).toEqual(
      [],
    );
    db.close();
  });
});

describe("ops.save supersede", () => {
  function store() {
    const dbPath = join(dir, "ops.db");
    let db: ReturnType<typeof openMemoryDb> | null = null;
    const getDb = () => (db ??= openMemoryDb(dbPath));
    return { ops: createMemoryOps(getDb), getDb, close: () => db?.close() };
  }

  it("reports the replacement when supersedes names a live entry", () => {
    const { ops, close } = store();
    const firstId =
      ops.save({ kind: "fact", title: "postgres batching", body: "x" }, "/w").split(" ")[1] ?? "";
    const second = ops.save(
      { kind: "fact", title: "postgres batching v2", body: "x", supersedes: firstId },
      "/w",
    );

    expect(second).toMatch(
      new RegExp(`^saved [0-9a-f-]{36} \\(/w, created\\); replaced ${firstId}$`),
    );
    expect(second).not.toContain("similar entries");
    close();
  });

  it("names similar entries when the save does not supersede anything", () => {
    const { ops, close } = store();
    const first = ops.save({ kind: "fact", title: "postgres batching", body: "x" }, "/w");
    const second = ops.save(
      { kind: "fact", title: "postgres batching v2", body: "x", supersedes: first.split(" ")[1] },
      "/w",
    );
    const secondId = second.split(" ")[1] ?? "";

    const third = ops.save({ kind: "fact", title: "postgres sharding", body: "x" }, "/w");

    expect(third).toContain("\nsimilar entries: ");
    expect(third).toContain(`("postgres batching v2")`);
    expect(third).toContain(`use supersedes=${secondId} to replace`);
    close();
  });
});

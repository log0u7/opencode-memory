import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openMemoryDb } from "../src/lib/db.js";
import { INVENTORY_MAX_CHARS, createMemoryOps, memoryInventory } from "../src/lib/memory-ops.js";
import { list } from "../src/lib/store.js";

const MAX_ENTRIES = 200;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "opencode-memory-ops-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function store() {
  const dbPath = join(dir, "m.db");
  let db: ReturnType<typeof openMemoryDb> | null = null;
  const getDb = () => (db ??= openMemoryDb(dbPath));
  return { ops: createMemoryOps(getDb), dbPath, getDb, close: () => db?.close() };
}

describe("memory ops", () => {
  it("returns the same model-facing text for every operation", () => {
    const { ops, close } = store();

    expect(
      ops.save({ kind: "decision", title: "Adopt batching", body: "batch 1000" }, "/w"),
    ).toMatch(/^saved .+ \(\/w\)$/);
    expect(ops.search({ query: "batching" }, "/w")).toContain("Adopt batching");
    expect(ops.list({}, "/w")).toBe(ops.search({ query: "batching" }, "/w"));
    expect(ops.forget({ query: "batching" }, "/w")).toBe("deleted 1 entry");
    expect(ops.search({ query: "batching" }, "/w")).toBe("no matching memory entries");
    close();
  });

  it("reports read results and usage without throwing", () => {
    const { ops, close } = store();

    expect(ops.search({ query: "nothing" }, "/w")).toBe("no matching memory entries");
    expect(ops.list({}, "/w")).toBe("no memory entries");
    expect(ops.forget({}, "/w")).toBe("provide id or query");
    close();
  });

  it("maps a secret refusal to guidance instead of throwing", () => {
    const { ops, close } = store();

    expect(
      ops.save(
        { kind: "fact", title: "openai key sk-abcdefghij1234567890", body: "harmless" },
        "/w",
      ),
    ).toBe("refused: the content looks like a credential; secrets must never be stored in memory");
    expect(ops.save({ kind: "fact", title: "", body: "x" }, "/w")).toMatch(/^error: .*title/);
    close();
  });

  it("keeps the search and list limits capped", () => {
    const { ops, close } = store();
    for (let i = 0; i < 60; i++) {
      ops.save({ kind: "fact", title: `postgres note ${i}`, body: "x" }, "/w");
    }

    expect(JSON.parse(ops.search({ query: "postgres", limit: 1e9 }, "/w"))).toHaveLength(50);
    expect(JSON.parse(ops.search({ query: "postgres", limit: -1 }, "/w"))).toHaveLength(10);
    close();
  });

  it("stores in the scope it is given and never crosses scopes when forgetting", () => {
    const { ops, getDb, close } = store();
    ops.save({ kind: "fact", title: "postgres sharding", body: "uses postgres" }, "/w");
    ops.save({ kind: "fact", title: "postgres replica", body: "uses postgres" }, "/other");

    expect(ops.forget({ query: "postgres" }, "/w")).toBe("deleted 1 entry");
    expect(list(getDb(), { scope: "/other" })).toHaveLength(1);
    close();
  });
});

describe("memory inventory", () => {
  it("returns null when the store does not exist yet, and creates nothing", () => {
    const { ops, dbPath, getDb, close } = store();

    expect(memoryInventory(getDb, dbPath, "/w")).toBeNull();
    expect(dbPath).toBeDefined();
    expect(ops.save({ kind: "fact", title: "seed", body: "x" }, "/w")).toMatch(/^saved/);
    close();
  });

  it("returns null when the scope has no entries", () => {
    const { ops, dbPath, getDb, close } = store();
    ops.save({ kind: "fact", title: "seed", body: "x" }, "/w");

    expect(memoryInventory(getDb, dbPath, "/other")).toBeNull();
    expect(memoryInventory(getDb, dbPath, "/w")).toContain("seed");
    close();
  });

  it("lists titles, kinds and dates without bodies", () => {
    const { ops, dbPath, getDb, close } = store();
    ops.save({ kind: "decision", title: "Use WAL mode", body: "secret body" }, "/w");

    const inventory = memoryInventory(getDb, dbPath, "/w");
    expect(inventory).toContain("[decision] Use WAL mode");
    expect(inventory).not.toContain("secret body");
    expect(inventory).toMatch(/updated \d{4}-\d{2}-\d{2}/);
    close();
  });

  it("includes global entries and forgets expired ones", () => {
    const { ops, dbPath, getDb, close } = store();
    ops.save({ kind: "fact", title: "global note", body: "x" }, "global");
    ops.save({ kind: "fact", title: "stale note", body: "x" }, "/w");
    getDb().conn.run("UPDATE entries SET expires_at = 1 WHERE title = 'stale note'");

    const inventory = memoryInventory(getDb, dbPath, "/w");
    expect(inventory).toContain("global note");
    expect(inventory).not.toContain("stale note");
    close();
  });

  it("stays within the character budget whatever the store size", () => {
    const { ops, dbPath, getDb, close } = store();
    for (let i = 0; i < MAX_ENTRIES; i++) {
      ops.save(
        { kind: "fact", title: `entry number ${i} with a long descriptive title`, body: "x" },
        "/w",
      );
    }
    const inventory = memoryInventory(getDb, dbPath, "/w");
    expect(inventory).not.toBeNull();
    expect((inventory as string).length).toBeLessThanOrEqual(INVENTORY_MAX_CHARS);
    close();
  });
});

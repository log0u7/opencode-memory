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
  it("counts entries by kind for the scope plus global, ignoring expired ones", () => {
    const { ops, getDb, close } = store();
    ops.save({ kind: "lesson", title: "lesson one", body: "x" }, "/w");
    ops.save({ kind: "lesson", title: "lesson two", body: "x" }, "/other");
    ops.save({ kind: "fact", title: "local fact", body: "x" }, "/w");
    ops.save({ kind: "fact", title: "global fact", body: "x" }, "global");
    ops.save({ kind: "decision", title: "stale decision", body: "x" }, "/w");
    getDb().conn.run("UPDATE entries SET expires_at = 1 WHERE title = 'stale decision'");

    const result = ops.stats("/w");

    expect(result).toContain("lesson: 1");
    expect(result).toContain("fact: 2");
    expect(result).toContain("total: 3");
    expect(result).not.toContain("decision");
    close();
  });

  it("reports an empty store readably in stats", () => {
    const { ops, close } = store();
    expect(ops.stats("/w")).toBe("no memory entries");
    close();
  });

  it("records who wrote an entry and names the writer in the inventory", () => {
    const { ops, dbPath, getDb, close } = store();
    ops.save({ kind: "lesson", title: "check the schema first", body: "x" }, "/w", "reflection");

    expect(JSON.parse(ops.list({}, "/w"))[0].source).toBe("reflection");
    expect(memoryInventory(getDb, dbPath, "/w")).toContain("by reflection");
    close();
  });

  it("says whether a save created an entry or rewrote one", () => {
    const { ops, close } = store();

    const created = ops.save(
      { kind: "decision", title: "Adopt batching", body: "batch 1000" },
      "/w",
    );
    const rewritten = ops.save(
      { kind: "decision", title: "Adopt batching", body: "batch 500" },
      "/w",
    );

    expect(created).toMatch(/^saved [0-9a-f-]{36} \(\/w, created\)$/);
    expect(rewritten).toMatch(/^saved [0-9a-f-]{36} \(\/w, updated\)$/);
    expect(rewritten).toContain(created.split(" ")[1]);
    close();
  });

  it("lists what a query delete removed instead of only counting it", () => {
    const { ops, close } = store();
    ops.save({ kind: "fact", title: "postgres sharding", body: "x" }, "/w");
    ops.save({ kind: "fact", title: "postgres replica", body: "x" }, "/w");
    ops.save({ kind: "fact", title: "docker compose", body: "x" }, "/w");

    const report = ops.forget({ query: "postgres" }, "/w");

    expect(report).toMatch(/^deleted 2 entries: "/);
    expect(report).toContain('"postgres sharding" (');
    expect(report).toContain('"postgres replica" (');
    expect(report).not.toContain("docker compose");
    expect(ops.forget({ query: "postgres" }, "/w")).toBe("deleted 0 entries");
    close();
  });

  it("caps the delete report so a broad query cannot flood the context", () => {
    const { ops, close } = store();
    for (let i = 0; i < 12; i++) {
      ops.save({ kind: "fact", title: `postgres note ${i}`, body: "x" }, "/w");
    }

    const report = ops.forget({ query: "postgres" }, "/w");

    expect(report).toContain("deleted 12 entries");
    expect(report.match(/\(/g)).toHaveLength(10);
    expect(report).toContain("and 2 more");
    close();
  });

  it("reports the store size and the oldest entry in stats", () => {
    const { ops, close } = store();
    ops.save({ kind: "fact", title: "old note", body: "x" }, "/w");
    ops.save({ kind: "fact", title: "new note", body: "x" }, "/w");

    const result = ops.stats("/w");

    // A size of zero means the pragmas were read wrong, not an empty store.
    const size = /store: (\d+(?:\.\d+)?) ([KMG]B)/.exec(result);
    expect(size).not.toBeNull();
    expect(Number(size?.[1])).toBeGreaterThan(0);
    expect(result).toMatch(/oldest: \d{4}-\d{2}-\d{2}/);
    expect(result).toContain("fact: 2");
    expect(result).toContain("total: 2");
    close();
  });

  it("returns the same model-facing text for every operation", () => {
    const { ops, close } = store();

    expect(
      ops.save({ kind: "decision", title: "Adopt batching", body: "batch 1000" }, "/w"),
    ).toMatch(/^saved [0-9a-f-]{36} \(\/w, created\)$/);
    expect(ops.search({ query: "batching" }, "/w")).toContain("Adopt batching");
    expect(ops.list({}, "/w")).toBe(ops.search({ query: "batching" }, "/w"));
    expect(ops.forget({ query: "batching" }, "/w")).toMatch(
      /^deleted 1 entry: "Adopt batching" \(/,
    );
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

    expect(ops.forget({ query: "postgres" }, "/w")).toMatch(
      /^deleted 1 entry: "postgres sharding" \(/,
    );
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
    // One transaction instead of 200 autocommits: the point is the budget, not
    // fsync throughput, and throttled CI runners otherwise push this past the
    // default 5s test timeout.
    getDb().conn.run("BEGIN");
    for (let i = 0; i < MAX_ENTRIES; i++) {
      ops.save(
        { kind: "fact", title: `entry number ${i} with a long descriptive title`, body: "x" },
        "/w",
      );
    }
    getDb().conn.run("COMMIT");
    const inventory = memoryInventory(getDb, dbPath, "/w");
    expect(inventory).not.toBeNull();
    expect((inventory as string).length).toBeLessThanOrEqual(INVENTORY_MAX_CHARS);
    close();
  });

  it("lists lessons before more recent non-lesson entries, without duplicates", () => {
    const { ops, dbPath, getDb, close } = store();
    ops.save({ kind: "lesson", title: "old lesson: retry with batch", body: "x" }, "/w");
    for (let i = 0; i < 40; i++) {
      ops.save({ kind: "fact", title: `noise note ${i}`, body: "x" }, "/w");
    }
    ops.save({ kind: "lesson", title: "new lesson: check first", body: "x" }, "/w");

    const inventory = memoryInventory(getDb, dbPath, "/w") as string;
    expect(inventory.indexOf("new lesson")).toBeLessThan(inventory.indexOf("noise note 39"));
    expect(inventory.indexOf("old lesson")).toBeLessThan(inventory.indexOf("noise note 39"));
    expect(inventory.indexOf("new lesson")).toBeLessThan(inventory.indexOf("old lesson"));
    expect(inventory.match(/new lesson/g)).toHaveLength(1);
    close();
  });

  it("announces lessons first in the header", () => {
    const { ops, dbPath, getDb, close } = store();
    ops.save({ kind: "lesson", title: "a lesson", body: "x" }, "/w");

    const inventory = memoryInventory(getDb, dbPath, "/w") as string;
    expect(inventory).toMatch(/lessons first/i);
    close();
  });
});

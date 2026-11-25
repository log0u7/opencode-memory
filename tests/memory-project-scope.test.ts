import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openMemoryDb } from "../src/lib/db.js";
import { memoryInventory } from "../src/lib/memory-ops.js";
import { exportPortable, importPortable } from "../src/lib/portable.js";
import { syncImport } from "../src/lib/sync.js";
import { getById, saveEntry, search } from "../src/lib/store.js";
import type { EntryInput } from "../src/types/entry.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "opencode-memory-project-scope-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function input(overrides: Partial<EntryInput> = {}): EntryInput {
  return {
    scope: "/work/project",
    kind: "lesson",
    title: "Retry with backoff",
    body: "Wrap flaky calls in a retry with backoff.",
    tags: [],
    expires_at: null,
    ...overrides,
  };
}

function lines(file: string): string[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0);
}

/** memoryInventory refuses a missing store file: touch one for the :memory: db. */
function touch(dbPath: string): void {
  writeFileSync(dbPath, "");
}

describe("project-scoped injection", () => {
  it("keeps an entry scoped to project A out of a project B injection", () => {
    const db = openMemoryDb(":memory:");
    const dbPath = join(dir, "a.db");
    touch(dbPath);
    saveEntry(db, input({ project: "proj-a" }));

    expect(memoryInventory(() => db, dbPath, "/work/project", { project: "proj-b" })).toBeNull();
  });

  it("injects an entry scoped to project A in a project A session", () => {
    const db = openMemoryDb(":memory:");
    const dbPath = join(dir, "a.db");
    touch(dbPath);
    saveEntry(db, input({ project: "proj-a" }));

    const text = memoryInventory(() => db, dbPath, "/work/project", { project: "proj-a" });
    expect(text).toContain("Retry with backoff");
  });

  it("injects unscoped (global) entries in every project: the backward-compatible default", () => {
    const db = openMemoryDb(":memory:");
    const dbPath = join(dir, "a.db");
    touch(dbPath);
    saveEntry(db, input());

    expect(memoryInventory(() => db, dbPath, "/work/project", { project: "proj-a" })).toContain(
      "Retry with backoff",
    );
    expect(memoryInventory(() => db, dbPath, "/work/project", { project: "proj-b" })).toContain(
      "Retry with backoff",
    );
  });

  it("carries the project through the superseded tombstone", () => {
    const db = openMemoryDb(":memory:");
    const first = saveEntry(db, input({ project: "proj-a" })).entry;
    saveEntry(db, input({ project: "proj-a", supersedes: first.id }));
    expect(getById(db, first.id)?.entry.project).toBe("proj-a");
  });
});

describe("cross-scope search", () => {
  it("searches across projects by default", () => {
    const db = openMemoryDb(":memory:");
    saveEntry(db, input({ project: "proj-a" }));

    // A session of project B still recalls project A's knowledge by query.
    expect(search(db, { query: "backoff", scope: "/work/project" })).toHaveLength(1);
  });

  it("filters by project when asked", () => {
    const db = openMemoryDb(":memory:");
    saveEntry(db, input({ title: "Scoped knowledge", project: "proj-a" }));
    saveEntry(db, input({ title: "Other knowledge", project: "proj-b" }));

    const inA = search(db, { query: "knowledge", scope: "/work/project", project: "proj-a" });
    expect(inA.map((entry) => entry.title)).toEqual(["Scoped knowledge"]);
    const inB = search(db, { query: "knowledge", scope: "/work/project", project: "proj-b" });
    expect(inB.map((entry) => entry.title)).toEqual(["Other knowledge"]);
  });
});

describe("portable round-trip keeps the project", () => {
  it("exports and imports the project scope verbatim", () => {
    const db = openMemoryDb(":memory:");
    saveEntry(db, input({ project: "proj-a" }));
    const file = join(dir, "export.jsonl");
    expect(exportPortable(db, "/work/project", file)).toBe(1);
    expect(lines(file)[0]).toContain('"project":"proj-a"');

    const fresh = openMemoryDb(":memory:");
    expect(importPortable(fresh, file).imported).toBe(1);
    expect(search(fresh, { query: "backoff", scope: "/work/project" })[0]?.project).toBe("proj-a");
  });

  it("drops the project on a cross-host import: machine-wide knowledge stays global", () => {
    const db = openMemoryDb(":memory:");
    saveEntry(db, input({ project: "proj-a" }));
    const file = join(dir, "outbox.jsonl");
    exportPortable(db, "/work/project", file, { originHost: "peer-host" });

    const fresh = openMemoryDb(":memory:");
    importPortable(fresh, file);
    const hits = search(fresh, { query: "backoff", scope: "/work/project" });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.project).toBeUndefined();
    expect(hits[0]?.scope).toBe("global");
  });

  it("syncImport keeps the origin project: never injected while no project matches", () => {
    const db = openMemoryDb(":memory:");
    saveEntry(db, input({ project: "proj-a" }));
    const file = join(dir, "export.jsonl");
    exportPortable(db, "/work/project", file);

    const inbox = join(dir, "inbox");
    mkdirSync(inbox, { recursive: true });
    writeFileSync(join(inbox, "peer.jsonl"), lines(file).join("\n") + "\n");

    const fresh = openMemoryDb(":memory:");
    const report = syncImport(fresh, { inboxDir: inbox });
    expect(report.imported).toBe(1);
    expect(search(fresh, { query: "backoff", scope: "/work/project" })[0]?.project).toBe("proj-a");
  });
});

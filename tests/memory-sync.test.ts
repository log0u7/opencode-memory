import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openMemoryDb, type MemoryDb } from "../src/lib/db.js";
import { createMemoryOps } from "../src/lib/memory-ops.js";
import { exportPortable, importPortable, PORTABLE_FILE_NAME } from "../src/lib/portable.js";
import {
  defaultMeshInboxDir,
  defaultMeshOutboxDir,
  syncExport,
  syncImport,
} from "../src/lib/sync.js";
import { allLive, endorseEntry, listShareable, saveEntry } from "../src/lib/store.js";

let dir: string;
let db: MemoryDb;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "opencode-memory-sync-"));
  db = openMemoryDb(join(dir, "memory.db"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function save(
  options: { scope?: string; source?: string; shareable?: boolean; title?: string } = {},
) {
  return saveEntry(db, {
    scope: options.scope ?? "/w",
    kind: "fact",
    title: options.title ?? "share this one",
    body: "b",
    tags: [],
    expires_at: null,
    ...(options.source !== undefined ? { source: options.source } : {}),
    ...(options.shareable !== undefined ? { shareable: options.shareable } : {}),
  }).entry;
}

describe("listShareable", () => {
  it("keeps peer-endorsed and author-published entries, drops unendorsed ones", () => {
    const plain = save({ source: "agent-a", title: "plain" });
    const published = save({ source: "agent-a", shareable: true, title: "published" });
    const endorsed = save({ source: "agent-a", title: "endorsed" });
    endorseEntry(db, { id: endorsed.id, endorser: "agent-b" });

    const ids = listShareable(db, "/w").map((entry) => entry.id);
    expect(ids).not.toContain(plain.id);
    expect(ids).toContain(published.id);
    expect(ids).toContain(endorsed.id);
  });

  it("is scope-bounded and returns live rows only", () => {
    save({ scope: "/other", source: "agent-a", shareable: true, title: "elsewhere" });
    expect(listShareable(db, "/w")).toEqual([]);
    const entry = save({ source: "agent-a", shareable: true });
    expect(listShareable(db, "/w").map((e) => e.id)).toEqual([entry.id]);
  });
});

describe("shareable export", () => {
  it("exports only the endorsed entries when the filter is on", () => {
    save({ source: "agent-a", title: "plain" });
    const published = save({ source: "agent-a", shareable: true, title: "published" });
    const endorsed = save({ source: "agent-a", title: "endorsed" });
    endorseEntry(db, { id: endorsed.id, endorser: "agent-b" });

    const file = join(dir, "shareable.jsonl");
    expect(exportPortable(db, "/w", file, { shareable: true })).toBe(2);
    const lines = readFileSync(file, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines.map((line) => JSON.parse(line).id).sort()).toEqual(
      [published.id, endorsed.id].sort(),
    );

    // The unfiltered export still carries the whole scope (3 live entries).
    expect(exportPortable(db, "/w", join(dir, "all.jsonl"))).toBe(3);
  });

  it("round-trips through import and stays idempotent", () => {
    save({ source: "agent-a", shareable: true, title: "published" });
    const endorsed = save({ source: "agent-a", title: "endorsed" });
    endorseEntry(db, { id: endorsed.id, endorser: "agent-b" });

    const file = join(dir, "shareable.jsonl");
    exportPortable(db, "/w", file, { shareable: true });

    const other = openMemoryDb(join(dir, "peer.db"));
    const first = importPortable(other, file);
    expect(first).toEqual({ imported: 2, skipped: 0 });
    // Re-importing the same shareable export inserts nothing new.
    expect(importPortable(other, file)).toEqual({ imported: 0, skipped: 2 });
    expect(allLive(other, "/w")).toHaveLength(2);
  });

  it("reports the shareable filter through the ops layer", () => {
    save({ source: "agent-a", title: "plain" });
    save({ source: "agent-a", shareable: true, title: "published" });
    const ops = createMemoryOps(() => db);
    const file = join(dir, "out.jsonl");
    expect(ops.exportEntries({ shareable: true, path: file }, "/w")).toBe(
      `exported 1 shareable entries to ${file}`,
    );
    expect(ops.exportEntries({ path: file }, "/w")).toBe(`exported 2 entries to ${file}`);
  });
});

describe("import report", () => {
  it("counts skipped lines separately from inserted ones", () => {
    const source = openMemoryDb(join(dir, "source.db"));
    saveEntry(source, {
      scope: "/w",
      kind: "fact",
      title: "one",
      body: "b",
      tags: [],
      expires_at: null,
    });
    saveEntry(source, {
      scope: "/w",
      kind: "fact",
      title: "two",
      body: "b",
      tags: [],
      expires_at: null,
    });
    const file = join(dir, PORTABLE_FILE_NAME);
    exportPortable(source, "/w", file);

    expect(importPortable(db, file)).toEqual({ imported: 2, skipped: 0 });
    expect(importPortable(db, file)).toEqual({ imported: 0, skipped: 2 });
  });
});

describe("syncImport", () => {
  const inbox = () => join(dir, "inbox");

  function writeInbox(name: string, lines: string[]): string {
    mkdirSync(inbox(), { recursive: true });
    const path = join(inbox(), name);
    writeFileSync(path, `${lines.join("\n")}\n`);
    return path;
  }

  function entryLine(id: string, scope = "/w"): string {
    return JSON.stringify({
      id,
      scope,
      kind: "fact",
      title: `title ${id}`,
      body: "body",
      tags: [],
      created_at: 1000,
      updated_at: 1000,
      expires_at: null,
      source: "peer-host",
    });
  }

  it("imports every inbox file, renames them, and is a no-op once drained", () => {
    writeInbox("node-a.jsonl", [entryLine("a1"), entryLine("a2")]);
    writeInbox("node-b.jsonl", [entryLine("b1")]);

    const report = syncImport(db, { inboxDir: inbox() });
    expect(report).toEqual({ files: 2, imported: 3, skipped: 0, failed: 0 });
    expect(allLive(db, "/w")).toHaveLength(3);
    expect(readdirSync(inbox()).sort()).toEqual(["node-a.jsonl.imported", "node-b.jsonl.imported"]);

    // The renamed files are never re-read: a second pass finds nothing.
    expect(syncImport(db, { inboxDir: inbox() })).toEqual({
      files: 0,
      imported: 0,
      skipped: 0,
      failed: 0,
    });
  });

  it("leaves a broken file in place and counts it as failed", () => {
    writeInbox("good.jsonl", [entryLine("g1")]);
    writeInbox("broken.jsonl", ["{not json"]);

    const report = syncImport(db, { inboxDir: inbox() });
    expect(report).toEqual({ files: 2, imported: 1, skipped: 0, failed: 1 });
    expect(readdirSync(inbox()).sort()).toEqual(["broken.jsonl", "good.jsonl.imported"]);
  });

  it("treats a missing inbox as an empty one", () => {
    expect(syncImport(db, { inboxDir: join(dir, "absent") })).toEqual({
      files: 0,
      imported: 0,
      skipped: 0,
      failed: 0,
    });
  });

  it("keeps the mesh dataDir convention with the mesh plugin", () => {
    // opencode-mesh resolves its dataDir to $XDG_DATA_HOME/opencode-mesh (default
    // ~/.local/share): the inbox sits one level deeper. The env override path must
    // match the mesh's own resolution so both sides can be pointed at the same tree.
    expect(defaultMeshInboxDir()).toMatch(/opencode-mesh[\\/]memory-sync[\\/]inbox$/);
    const custom = join(dir, "xdg");
    const previous = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = custom;
    try {
      expect(defaultMeshInboxDir()).toBe(join(custom, "opencode-mesh", "memory-sync", "inbox"));
    } finally {
      if (previous === undefined) {
        delete process.env.XDG_DATA_HOME;
      } else {
        process.env.XDG_DATA_HOME = previous;
      }
    }
  });
});

describe("syncExport", () => {
  function meshTree(): string {
    const dataHome = join(dir, "xdg-data");
    mkdirSync(join(dataHome, "opencode-mesh"), { recursive: true });
    return dataHome;
  }

  it("writes only shareable entries to the mesh outbox", () => {
    const dataHome = meshTree();
    save({ source: "agent-a", shareable: true, title: "published" });
    save({ source: "agent-a", title: "endorsed by a peer" });
    endorseEntry(db, {
      id: save({ source: "agent-a", title: "endorsed later" }).id,
      endorser: "peer",
    });
    save({ title: "stays local" });
    const outbox = join(dataHome, "opencode-mesh", "memory-sync", "outbox");
    const report = syncExport(db, { outboxDir: outbox, scope: "/w" });
    expect(report.exported).toBe(2);
    expect(report.path).toBe(join(outbox, "shareable.jsonl"));
    const lines = readFileSync(join(outbox, "shareable.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines.every((line) => JSON.parse(line).title !== "stays local")).toBe(true);
  });

  it("rewrites the whole file: un-endorsed or superseded entries leave the next push", () => {
    const dataHome = meshTree();
    const kept = save({ source: "agent-a", shareable: true, title: "kept" });
    const gone = save({ source: "agent-a", shareable: true, title: "gone" });
    const outbox = join(dataHome, "opencode-mesh", "memory-sync", "outbox");
    syncExport(db, { outboxDir: outbox, scope: "/w" });
    // supersede 'gone': a superseded row is not LIVE, so it must leave the next push
    saveEntry(db, {
      scope: "/w",
      kind: "fact",
      title: "gone v2",
      body: "b",
      tags: [],
      expires_at: null,
      supersedes: gone.id,
    });
    syncExport(db, { outboxDir: outbox, scope: "/w" });
    const titles = readFileSync(join(outbox, "shareable.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).title);
    expect(titles).toContain("kept");
    expect(titles).not.toContain("gone");
    expect(titles).not.toContain("gone v2"); // only current rows travel
    expect(kept.id).toBeTruthy();
  });

  it("writes nothing when the mesh has never run on this machine", () => {
    const outbox = join(dir, "no-mesh", "opencode-mesh", "memory-sync", "outbox");
    save({ source: "agent-a", shareable: true });
    const report = syncExport(db, { outboxDir: outbox, scope: "/w" });
    expect(report.exported).toBe(0);
    expect(report.path).toBeNull();
    let exists = true;
    try {
      readdirSync(outbox);
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);
  });

  it("keeps the outbox convention symmetric with the inbox", () => {
    const previous = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = join(dir, "xdg");
    try {
      expect(defaultMeshOutboxDir()).toBe(
        join(dir, "xdg", "opencode-mesh", "memory-sync", "outbox"),
      );
    } finally {
      if (previous === undefined) {
        delete process.env.XDG_DATA_HOME;
      } else {
        process.env.XDG_DATA_HOME = previous;
      }
    }
  });
});

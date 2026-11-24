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
import {
  allLive,
  endorseEntry,
  getById,
  listShareable,
  listShareableAll,
  saveEntry,
  search as memory_search,
} from "../src/lib/store.js";

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
    expect(report).toEqual({ files: 2, imported: 3, skipped: 0, failed: 0, oversized: 0 });
    expect(allLive(db, "/w")).toHaveLength(3);
    expect(readdirSync(inbox()).sort()).toEqual(["node-a.jsonl.imported", "node-b.jsonl.imported"]);

    // The renamed files are never re-read: a second pass finds nothing.
    expect(syncImport(db, { inboxDir: inbox() })).toEqual({
      files: 0,
      imported: 0,
      skipped: 0,
      failed: 0,
      oversized: 0,
    });
  });

  it("leaves a broken file in place and counts it as failed", () => {
    writeInbox("good.jsonl", [entryLine("g1")]);
    writeInbox("broken.jsonl", ["{not json"]);

    const report = syncImport(db, { inboxDir: inbox() });
    expect(report).toEqual({ files: 2, imported: 1, skipped: 0, failed: 1, oversized: 0 });
    expect(readdirSync(inbox()).sort()).toEqual(["broken.jsonl", "good.jsonl.imported"]);
  });

  it("treats a missing inbox as an empty one", () => {
    expect(syncImport(db, { inboxDir: join(dir, "absent") })).toEqual({
      files: 0,
      imported: 0,
      skipped: 0,
      failed: 0,
      oversized: 0,
    });
  });

  it("refuses an oversized file with a warning and renames it to .oversized", () => {
    writeInbox("huge.jsonl", [entryLine("h1"), "x".repeat(1024 * 1024)]);
    writeInbox("fits.jsonl", [entryLine("f1")]);

    const report = syncImport(db, { inboxDir: inbox() });
    expect(report).toEqual({ files: 2, imported: 1, skipped: 0, failed: 0, oversized: 1 });
    // The oversized file is out of the loop for good: renamed, never re-parsed.
    expect(readdirSync(inbox()).sort()).toEqual(["fits.jsonl.imported", "huge.jsonl.oversized"]);
    expect(allLive(db, "/w").map((entry) => entry.id)).toEqual(["f1"]);
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
    const report = syncExport(db, { outboxDir: outbox });
    expect(report.exported).toBe(2);
    expect(report.path).toBe(join(outbox, "shareable.jsonl"));
    const lines = readFileSync(join(outbox, "shareable.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines.every((line) => JSON.parse(line).title !== "stays local")).toBe(true);
  });

  it("rewrites the whole file: the tombstoned row leaves, the endorsed replacement stays", () => {
    const dataHome = meshTree();
    const kept = save({ source: "agent-a", shareable: true, title: "kept" });
    const gone = save({ source: "agent-a", shareable: true, title: "gone" });
    const outbox = join(dataHome, "opencode-mesh", "memory-sync", "outbox");
    syncExport(db, { outboxDir: outbox });
    // supersede 'gone': the tombstoned row is not LIVE, so it must leave the next
    // push, while the replacement carries the superseded row's endorsements (refining
    // a shared entry must not drop it from the outbox).
    saveEntry(db, {
      scope: "/w",
      kind: "fact",
      title: "gone v2",
      body: "b",
      tags: [],
      expires_at: null,
      supersedes: gone.id,
    });
    syncExport(db, { outboxDir: outbox });
    const titles = readFileSync(join(outbox, "shareable.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).title);
    expect(titles).toContain("kept");
    expect(titles).not.toContain("gone");
    expect(titles).toContain("gone v2"); // the replacement carries the endorsement
    expect(kept.id).toBeTruthy();
  });

  it("writes nothing when the mesh has never run on this machine", () => {
    const outbox = join(dir, "no-mesh", "opencode-mesh", "memory-sync", "outbox");
    save({ source: "agent-a", shareable: true });
    const report = syncExport(db, { outboxDir: outbox });
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

/**
 * The 0.20.2 cross-host trust boundary: peer entries (stamped `origin_host` by the
 * outbox export) land in `global` so local reads surface them; the outbox is
 * machine-wide; hostile or broken lines are refused at the import gate.
 */
describe("cross-host import trust boundary", () => {
  const inbox = () => join(dir, "inbox");

  function peerLine(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      id: "peer-1",
      scope: "/peer/project",
      kind: "fact",
      title: "cross host needle",
      body: "body",
      tags: [],
      created_at: Date.now() - 1000,
      updated_at: Date.now() - 1000,
      expires_at: null,
      source: "agent-on-peer",
      origin_host: "peer-host",
      ...overrides,
    });
  }

  function writeInbox(name: string, lines: string[]): string {
    mkdirSync(inbox(), { recursive: true });
    const path = join(inbox(), name);
    writeFileSync(path, `${lines.join("\n")}\n`);
    return path;
  }

  it("serves a peer entry of a foreign scope through a local memory_search", () => {
    // The scope on the line is a path that exists on the PEER, not here: verbatim
    // storage buried the entry in a scope this host never reads. The origin_host
    // marker remaps it to `global`, which every scope's reads include.
    writeInbox("node-a.jsonl", [peerLine()]);
    expect(syncImport(db, { inboxDir: inbox() })).toMatchObject({ imported: 1 });

    expect(
      memory_search(db, { query: "needle", scope: "/local/project" }).map((e) => e.id),
    ).toEqual(["peer-1"]);
    expect(allLive(db, "global").map((e) => e.id)).toEqual(["peer-1"]);
  });

  it("keeps a local (no origin_host) import verbatim in its own scope", () => {
    // The 0.13.0 same-machine round-trip: no marker, no remap.
    writeInbox("local.jsonl", [peerLine({ id: "local-1", origin_host: undefined })]);
    expect(syncImport(db, { inboxDir: inbox() })).toMatchObject({ imported: 1 });

    expect(allLive(db, "/peer/project").map((e) => e.id)).toEqual(["local-1"]);
    expect(memory_search(db, { query: "needle", scope: "/local/project" })).toEqual([]);
  });

  it("keeps two scopes' shareables in the outbox across sweeps of different scopes", () => {
    // The outbox is machine-wide: a sweep from project A must not erase what
    // project B pushed, and one file carries both scopes' shareables.
    const dataHome = join(dir, "xdg-data");
    mkdirSync(join(dataHome, "opencode-mesh"), { recursive: true });
    save({ scope: "/proj-a", source: "agent-a", shareable: true, title: "from proj a" });
    save({ scope: "/proj-b", source: "agent-a", shareable: true, title: "from proj b" });
    const ops = createMemoryOps(() => db);

    const previous = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = dataHome;
    try {
      ops.sweep({}, "/proj-a");
      ops.sweep({}, "/proj-b");
    } finally {
      if (previous === undefined) {
        delete process.env.XDG_DATA_HOME;
      } else {
        process.env.XDG_DATA_HOME = previous;
      }
    }

    const file = join(dataHome, "opencode-mesh", "memory-sync", "outbox", "shareable.jsonl");
    const titles = readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).title);
    expect(titles.sort()).toEqual(["from proj a", "from proj b"]);
  });

  it("stamps origin_host on every outbox export line", () => {
    const dataHome = join(dir, "xdg-data");
    mkdirSync(join(dataHome, "opencode-mesh"), { recursive: true });
    save({ source: "agent-a", shareable: true, title: "published" });
    const outbox = join(dataHome, "opencode-mesh", "memory-sync", "outbox");
    syncExport(db, { outboxDir: outbox });

    const lines = readFileSync(join(outbox, "shareable.jsonl"), "utf8").trim().split("\n");
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      const parsed = JSON.parse(line) as { origin_host?: unknown };
      expect(typeof parsed.origin_host).toBe("string");
      expect((parsed.origin_host as string).length).toBeGreaterThan(0);
      // The store never persists the marker: it is transport provenance only.
      expect(
        getById(db, (JSON.parse(line) as { id: string }).id)?.entry.origin_host,
      ).toBeUndefined();
    }
  });

  it("rejects future created_at and updated_at, naming the field", () => {
    const future = Date.now() + 10 * 60 * 1000;
    writeInbox("future-created.jsonl", [peerLine({ id: "fc", created_at: future })]);
    writeInbox("future-updated.jsonl", [peerLine({ id: "fu", updated_at: future })]);

    expect(() => importPortable(db, join(inbox(), "future-created.jsonl"))).toThrowError(
      /created_at/,
    );
    expect(() => importPortable(db, join(inbox(), "future-updated.jsonl"))).toThrowError(
      /updated_at/,
    );
    expect(allLive(db, "global")).toEqual([]);
    // Inside the 5 minute skew allowance a peer clock ahead of ours is accepted.
    writeInbox("skew-ok.jsonl", [peerLine({ id: "skew", created_at: Date.now() + 60_000 })]);
    expect(importPortable(db, join(inbox(), "skew-ok.jsonl"))).toEqual({
      imported: 1,
      skipped: 0,
    });
  });

  it("rejects an expires_at beyond ten years", () => {
    const elevenYears = 11 * 365 * 24 * 60 * 60 * 1000;
    const nineYears = 9 * 365 * 24 * 60 * 60 * 1000;
    writeInbox("far-expiry.jsonl", [peerLine({ id: "far", expires_at: Date.now() + elevenYears })]);

    expect(() => importPortable(db, join(inbox(), "far-expiry.jsonl"))).toThrowError(/expires_at/);
    writeInbox("near-expiry.jsonl", [peerLine({ id: "near", expires_at: Date.now() + nineYears })]);
    expect(importPortable(db, join(inbox(), "near-expiry.jsonl"))).toEqual({
      imported: 1,
      skipped: 0,
    });
  });

  it("rejects an oversized scope and an oversized source", () => {
    writeInbox("fat-scope.jsonl", [peerLine({ id: "fs", scope: "x".repeat(513) })]);
    writeInbox("fat-source.jsonl", [peerLine({ id: "fr", source: "y".repeat(257) })]);

    expect(() => importPortable(db, join(inbox(), "fat-scope.jsonl"))).toThrowError(
      /scope must be at most 512/,
    );
    expect(() => importPortable(db, join(inbox(), "fat-source.jsonl"))).toThrowError(
      /source must be at most 256/,
    );
    expect(allLive(db, "global")).toEqual([]);
  });

  it("never re-imports a peer's endorsed_by (anti-amplification pin)", () => {
    // An imported row keeps NO endorsement: shareability is vouched on THIS machine,
    // so received knowledge can never ride the next export back out.
    writeInbox("endorsed.jsonl", [
      peerLine({ id: "amp", endorsed_by: ["peer-agent", "other-peer"] }),
    ]);
    expect(syncImport(db, { inboxDir: inbox() })).toMatchObject({ imported: 1 });

    const stored = getById(db, "amp")?.entry;
    expect(stored?.scope).toBe("global");
    expect(stored?.endorsed_by).toBeUndefined();
    expect(listShareableAll(db)).toEqual([]);
  });
});

describe("housekeeping pass through ops.sweep", () => {
  // 0.20.1: memory_sweep runs the SAME pass as the boot/daily cadence — sweep plus
  // the mesh sync twins. Before, a manual sweep left the outbox empty until the
  // next daily tick.

  function meshDataHome(): string {
    const dataHome = join(dir, "xdg-data");
    mkdirSync(join(dataHome, "opencode-mesh"), { recursive: true });
    return dataHome;
  }

  function withXdg<T>(dataHome: string, fn: () => T): T {
    const previous = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = dataHome;
    try {
      return fn();
    } finally {
      if (previous === undefined) {
        delete process.env.XDG_DATA_HOME;
      } else {
        process.env.XDG_DATA_HOME = previous;
      }
    }
  }

  function peerLine(id: string, scope = "/w"): string {
    return JSON.stringify({
      id,
      scope,
      kind: "fact",
      title: `from peer ${id}`,
      body: "body",
      tags: [],
      created_at: 1000,
      updated_at: 1000,
      expires_at: null,
      source: "peer-host",
    });
  }

  it("a manual sweep exports shareable entries to the outbox", () => {
    const dataHome = meshDataHome();
    save({ source: "agent-a", shareable: true, title: "published by sweep" });
    save({ title: "stays local" });
    const ops = createMemoryOps(() => db);

    const out = withXdg(dataHome, () => ops.sweep({}, "/w"));

    expect(out).toContain("swept:");
    const outboxFile = join(dataHome, "opencode-mesh", "memory-sync", "outbox", "shareable.jsonl");
    const titles = readFileSync(outboxFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).title);
    expect(titles).toEqual(["published by sweep"]);
  });

  it("a manual sweep imports the mesh inbox files", () => {
    const dataHome = meshDataHome();
    const inbox = join(dataHome, "opencode-mesh", "memory-sync", "inbox");
    mkdirSync(inbox, { recursive: true });
    writeFileSync(join(inbox, "node-a.jsonl"), `${peerLine("p1")}\n${peerLine("p2")}\n`);
    const ops = createMemoryOps(() => db);

    withXdg(dataHome, () => ops.sweep({}, "/w"));

    const ids = allLive(db, "/w").map((entry) => entry.id);
    expect(ids).toContain("p1");
    expect(ids).toContain("p2");
    expect(readdirSync(inbox).sort()).toEqual(["node-a.jsonl.imported"]);
  });
});

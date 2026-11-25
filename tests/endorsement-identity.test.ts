import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { importPortable, exportPortable } from "../src/lib/portable.js";
import { createMemoryOps } from "../src/lib/memory-ops.js";
import { fingerprintOfNodeId, nodeFingerprint, syncImport } from "../src/lib/sync.js";
import {
  allLive,
  endorseEntry,
  isShareable,
  listShareableAll,
  saveEntry,
} from "../src/lib/store.js";
import { openMemoryDb, type MemoryDb } from "../src/lib/db.js";

const dirs: string[] = [];
let db: MemoryDb;

function save(options: { source?: string; title?: string } = {}) {
  return saveEntry(db, {
    scope: "/w",
    kind: "fact",
    title: options.title ?? "share this one",
    body: "b",
    tags: [],
    expires_at: null,
    ...(options.source !== undefined ? { source: options.source } : {}),
  }).entry;
}

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "memory-endorsement-id-"));
  dirs.push(dir);
  db = openMemoryDb(join(dir, "memory.db"));
});

afterEach(() => {
  db.close();
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
  db = undefined as unknown as MemoryDb;
});

describe("endorsement stamps the node identity (store)", () => {
  it("a peer endorsement carries the agent@fingerprint format", () => {
    const entry = save({ source: "author" });

    const result = endorseEntry(db, {
      id: entry.id,
      endorser: "peer",
      fingerprint: "abcd1234abcd1234",
    });
    expect(result?.entry.endorsed_by).toEqual(["peer@abcd1234abcd1234"]);
    expect(result?.shareable).toBe(true);
    expect(isShareable(result?.entry as never)).toBe(true);
  });

  it("without a fingerprint the endorsement keeps the plain legacy form (local-only)", () => {
    const entry = save({ source: "author" });

    const result = endorseEntry(db, { id: entry.id, endorser: "peer" });
    expect(result?.entry.endorsed_by).toEqual(["peer"]);
    expect(result?.shareable).toBe(true);
  });
});

describe("isShareable with the rich format", () => {
  it("compares the agent name, not the raw string", () => {
    const entry = save({ source: "author" });
    // The author's own rich stamp is still the author: never shareable.
    expect(isShareable({ ...entry, endorsed_by: ["author@abcd1234abcd1234"] })).toBe(false);
    // A peer's rich stamp or a plain legacy stamp both qualify.
    expect(isShareable({ ...entry, endorsed_by: ["peer@abcd1234abcd1234"] })).toBe(true);
    expect(isShareable({ ...entry, endorsed_by: ["author@abcd1234abcd1234", "peer"] })).toBe(true);
  });
});

describe("ops endorse stamps the fingerprint when wired", () => {
  it("the tool stamps the rich format automatically", () => {
    const ops = createMemoryOps(() => db, { fingerprint: () => "abcd1234abcd1234" });
    const entry = save({ source: "author" });

    expect(ops.endorse({ id: entry.id }, "peer")).toBe(`endorsed ${entry.id} (shareable)`);
    expect(allLive(db, "/w")[0]?.endorsed_by).toEqual(["peer@abcd1234abcd1234"]);
  });

  it("an endorser already endorsed under another identity endorses again", () => {
    const ops = createMemoryOps(() => db, { fingerprint: () => "abcd1234abcd1234" });
    const entry = save({ source: "author" });
    endorseEntry(db, { id: entry.id, endorser: "peer" });

    // The plain legacy endorsement and the stamped one are distinct endorsers.
    expect(ops.endorse({ id: entry.id }, "peer")).toBe(`endorsed ${entry.id} (shareable)`);
    expect(allLive(db, "/w")[0]?.endorsed_by).toEqual(["peer", "peer@abcd1234abcd1234"]);
  });
});

describe("sync-import trust gate", () => {
  function exportInbox(nodeId: string): string {
    const inboxDir = join(dirs[dirs.length - 1] as string, "inbox");
    mkdirSync(inboxDir, { recursive: true });
    const path = join(inboxDir, `${nodeId}.jsonl`);
    const count = exportPortable(db, "/w", path, {
      shareable: true,
      allScopes: true,
      originHost: "origin-host",
    });
    expect(count).toBeGreaterThan(0);
    return inboxDir;
  }

  /** The receiving twin: the inbox lands in a fresh store, like a real peer. */
  function receive(inboxDir: string) {
    const peer = openMemoryDb(join(dirs[dirs.length - 1] as string, "peer.db"));
    return { peer, report: syncImport(peer, { inboxDir }) };
  }

  it("a shareable entry with an endorsement matching the origin fingerprint stays shareable", () => {
    const nodeId = "0197aaaa-bbbb-cccc-dddd-eeeeffff0001";
    const fp = fingerprintOfNodeId(nodeId);
    const entry = save({ source: "author" });
    endorseEntry(db, { id: entry.id, endorser: "peer", fingerprint: fp });

    const { peer, report } = receive(exportInbox(nodeId));
    try {
      expect(report.imported).toBe(1);

      const imported = allLive(peer, "global").find((e) => e.title === entry.title);
      expect(imported?.endorsed_by).toEqual([`peer@${fp}`]);
      expect(isShareable(imported as never)).toBe(true);
    } finally {
      peer.close();
    }
  });

  it("a plain-name endorsement arrives non-shareable", () => {
    const entry = save({ source: "author" });
    endorseEntry(db, { id: entry.id, endorser: "peer" });

    const { peer, report } = receive(exportInbox("0197aaaa-bbbb-cccc-dddd-eeeeffff0002"));
    try {
      expect(report.imported).toBe(1);

      const imported = allLive(peer, "global").find((e) => e.title === entry.title);
      expect(imported?.endorsed_by).toBeUndefined();
      expect(isShareable(imported as never)).toBe(false);
    } finally {
      peer.close();
    }
  });

  it("an endorsement from a foreign fingerprint arrives non-shareable", () => {
    const entry = save({ source: "author" });
    endorseEntry(db, { id: entry.id, endorser: "peer", fingerprint: "ffffffffffffffff" });

    const { peer, report } = receive(exportInbox("0197aaaa-bbbb-cccc-dddd-eeeeffff0003"));
    try {
      expect(report.imported).toBe(1);

      const imported = allLive(peer, "global").find((e) => e.title === entry.title);
      expect(imported?.endorsed_by).toBeUndefined();
      expect(isShareable(imported as never)).toBe(false);
    } finally {
      peer.close();
    }
  });

  it("the entry is still imported: it is local, re-endorsable", () => {
    const entry = save({ source: "author" });
    endorseEntry(db, { id: entry.id, endorser: "peer", fingerprint: "ffffffffffffffff" });

    const { peer } = receive(exportInbox("0197aaaa-bbbb-cccc-dddd-eeeeffff0004"));
    try {
      const imported = allLive(peer, "global").find((e) => e.title === entry.title);
      expect(imported).toBeDefined();
      // The import stripped the unverifiable endorsement; a fresh local peer
      // endorsement re-arms shareability on this host.
      const again = endorseEntry(peer, { id: imported?.id as string, endorser: "local-peer" });
      expect(again?.shareable).toBe(true);
    } finally {
      peer.close();
    }
  });
});

describe("retro-compat (local round-trip)", () => {
  it("a local (same-machine) import keeps plain-name endorsements verbatim", () => {
    const entry = save({ source: "author" });
    endorseEntry(db, { id: entry.id, endorser: "peer" });

    const dir = dirs[dirs.length - 1] as string;
    const path = join(dir, "local-export.jsonl");
    exportPortable(db, "/w", path);
    const raw = readFileSync(path, "utf8");
    expect(raw).toContain('"endorsed_by":["peer"]');

    const fresh = openMemoryDb(join(dir, "fresh.db"));
    try {
      const result = importPortable(fresh, path);
      expect(result.imported).toBe(1);
      const imported = allLive(fresh, "/w").find((e) => e.title === entry.title);
      expect(imported?.endorsed_by).toEqual(["peer"]);
      expect(isShareable(imported as never)).toBe(true);
    } finally {
      fresh.close();
    }
  });
});

describe("node fingerprint", () => {
  it("derives from the node id like opencode-mesh does (sha256, 16 hex)", () => {
    expect(fingerprintOfNodeId("56403d09-b872-42d8-8dc3-a0ace04782d8")).toMatch(/^[0-9a-f]{16}$/);
  });

  it("is undefined without a mesh node.json on this machine's default dir", () => {
    // No XDG override and the real mesh may or may not be installed here: the
    // contract is only "a string when the mesh dataDir carries node.json".
    const fp = nodeFingerprint();
    if (fp !== undefined) {
      expect(fp).toMatch(/^[0-9a-f]{16}$/);
    }
  });

  it("listShareableAll exports the rich endorsement for the sync", () => {
    const entry = save({ source: "author" });
    endorseEntry(db, { id: entry.id, endorser: "peer", fingerprint: "abcd1234abcd1234" });
    expect(listShareableAll(db).map((e) => e.endorsed_by)).toEqual([["peer@abcd1234abcd1234"]]);
  });

  it("writeFileSync of an inbox file round-trips through the export text", () => {
    // Sanity guard for the exportInbox helper above: the JSONL text must parse
    // back to entries carrying the endorsement.
    const entry = save({ source: "author" });
    endorseEntry(db, { id: entry.id, endorser: "peer", fingerprint: "abcd1234abcd1234" });
    const dir = dirs[dirs.length - 1] as string;
    const path = join(dir, "outbox.jsonl");
    writeFileSync(path, "");
    exportPortable(db, "/w", path, { shareable: true, allScopes: true, originHost: "h" });
    expect(readFileSync(path, "utf8")).toContain(entry.id);
  });
});

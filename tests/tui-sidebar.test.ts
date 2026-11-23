import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openMemoryDb } from "../src/lib/db.js";
import { sweepHousekeeping } from "../src/lib/housekeeping.js";
import { buildSidebarSnapshot } from "../src/lib/tui-snapshot.js";
import { HOT_THRESHOLD } from "../src/lib/store.js";
import { formatAgeHuman, formatMemorySidebar, noStoreSidebar } from "../src/rpc.js";

const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

type Row = {
  scope?: string;
  kind?: string;
  title?: string;
  body?: string;
  created_at?: number;
  updated_at?: number;
  expires_at?: number | null;
  deleted_at?: number | null;
  status?: string;
  heat?: number;
  endorsed_by?: string[] | null;
  paths?: string[] | null;
  commit_sha?: string | null;
};

/** Direct row insert: the sidebar snapshot counts every lifecycle state, which
 * save() would normalize away (rewrites, sweeps of expired rows). */
function insert(db: ReturnType<typeof openMemoryDb>, overrides: Row = {}): string {
  const id = `${overrides.title ?? "note"}-${Math.random().toString(36).slice(2, 8)}`;
  db.conn.run(
    `INSERT INTO entries (id, scope, kind, title, body, tags, created_at, updated_at, expires_at,
       source, deleted_at, paths, commit_sha, supersedes, status, superseded_at, heat, endorsed_by)
     VALUES (?, ?, ?, ?, ?, '[]', ?, ?, ?, NULL, ?, ?, ?, NULL, ?, NULL, ?, ?)`,
    [
      id,
      overrides.scope ?? "/w",
      overrides.kind ?? "fact",
      overrides.title ?? "note",
      overrides.body ?? "body",
      overrides.created_at ?? NOW,
      overrides.updated_at ?? NOW,
      overrides.expires_at ?? null,
      overrides.deleted_at ?? null,
      overrides.paths === undefined ? null : JSON.stringify(overrides.paths),
      overrides.commit_sha ?? null,
      overrides.status ?? "current",
      overrides.heat ?? 0,
      overrides.endorsed_by === undefined ? null : JSON.stringify(overrides.endorsed_by),
    ],
  );
  return id;
}

describe("buildSidebarSnapshot: counts", () => {
  it("counts live, trashed, kinds, hot, shareable and scope machine-wide", () => {
    const db = openMemoryDb(":memory:");
    // Scope /w: three usable rows (one hot lesson), one trashed, one expired.
    insert(db, { kind: "fact", title: "f1" });
    insert(db, { kind: "decision", title: "d1" });
    insert(db, { kind: "lesson", title: "l1", heat: HOT_THRESHOLD });
    insert(db, { kind: "fact", title: "trash", deleted_at: NOW });
    insert(db, { kind: "fact", title: "old", expires_at: NOW - 1 });
    // Global scope counts toward the asking scope.
    insert(db, { scope: "global", kind: "fact", title: "g1" });
    // Other scope: counts machine-wide, not in scope.
    insert(db, { scope: "/other", kind: "preference", title: "p1" });
    // Endorsed: one in scope, one outside.
    insert(db, { kind: "finding", title: "sh1", endorsed_by: ["peer"] });
    insert(db, { scope: "/other", kind: "fact", title: "sh2", endorsed_by: ["peer"] });
    // Superseded rows are neither live nor trashed.
    insert(db, { kind: "fact", title: "sup", status: "superseded" });

    const snap = buildSidebarSnapshot(db, { scope: "/w", now: NOW });
    expect(snap.store).toBe(true);
    expect(snap.live).toBe(7); // f1, d1, l1, g1, p1, sh1, sh2
    expect(snap.trashed).toBe(1);
    expect(snap.hot).toBe(1);
    expect(snap.shareable).toBe(2);
    expect(snap.scope).toBe(5); // f1, d1, l1, g1, sh1
    const counts = new Map(snap.kinds.map((k) => [k.kind, k.count]));
    expect(counts.get("fact")).toBe(3); // f1, g1, sh2
    expect(counts.get("decision")).toBe(1);
    expect(counts.get("lesson")).toBe(1);
    expect(counts.get("preference")).toBe(1);
    expect(counts.get("finding")).toBe(1);
    // Count descending, kind ascending on ties.
    expect(snap.kinds[0]).toEqual({ kind: "fact", count: 3 });
  });

  it("reports no metadata row as a null last sweep and 0 cooled", () => {
    const db = openMemoryDb(":memory:");
    insert(db, { title: "f1" });
    const snap = buildSidebarSnapshot(db, { scope: "/w", now: NOW });
    expect(snap.last_sweep_ms).toBeNull();
    expect(snap.cooled).toBe(0);
  });

  it("reads the last sweep timestamp the housekeeping sweep stamped", () => {
    const db = openMemoryDb(":memory:");
    insert(db, { title: "f1" });
    sweepHousekeeping(db, { scope: "/w", now: NOW - 5 * 60_000 });
    const snap = buildSidebarSnapshot(db, { scope: "/w", now: NOW, cooled: 2 });
    expect(snap.last_sweep_ms).toBe(NOW - 5 * 60_000);
    expect(snap.cooled).toBe(2);
  });
});

describe("buildSidebarSnapshot: staleness and sync files", () => {
  let repo: string;
  let inbox: string;

  function git(args: string[]): string {
    return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  }

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "tui-sidebar-repo-"));
    git(["init", "-q"]);
    mkdirSync(dirname(join(repo, "src/a.ts")), { recursive: true });
    writeFileSync(join(repo, "src/a.ts"), "export {};\n");
    git(["add", "."]);
    git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "init"]);
    inbox = mkdtempSync(join(tmpdir(), "tui-sidebar-inbox-"));
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(inbox, { recursive: true, force: true });
  });

  it("counts anchored entries whose files moved, in the asking scope only", () => {
    const db = openMemoryDb(":memory:");
    const sha = git(["rev-parse", "HEAD"]).trim();
    insert(db, { title: "anchored", paths: ["src/a.ts"], commit_sha: sha });
    insert(db, { title: "other scope", scope: "/other", paths: ["src/a.ts"], commit_sha: sha });
    insert(db, { title: "unanchored", paths: ["src/a.ts"] });

    const fresh = buildSidebarSnapshot(db, { scope: "/w", now: NOW, directory: repo });
    expect(fresh.stale).toBe(0);

    writeFileSync(join(repo, "src/a.ts"), "export const changed = true;\n");
    const stale = buildSidebarSnapshot(db, { scope: "/w", now: NOW, directory: repo });
    expect(stale.stale).toBe(1);
  });

  it("counts pending inbox files and mesh presence from the sync dirs", () => {
    const db = openMemoryDb(":memory:");
    insert(db, { title: "f1" });
    writeFileSync(join(inbox, "peer-a.jsonl"), "{}\n");
    writeFileSync(join(inbox, "peer-b.jsonl"), "{}\n");
    writeFileSync(join(inbox, "peer-a.jsonl.imported"), "{}\n");

    const withMesh = buildSidebarSnapshot(db, {
      scope: "/w",
      now: NOW,
      inboxDir: inbox,
      meshDataDir: repo, // any existing dir proves "installed"
    });
    expect(withMesh.sync_incoming).toBe(2);
    expect(withMesh.mesh_installed).toBe(true);

    const withoutMesh = buildSidebarSnapshot(db, { scope: "/w", now: NOW });
    expect(withoutMesh.sync_incoming).toBe(0);
    expect(withoutMesh.mesh_installed).toBe(false);
  });
});

describe("formatMemorySidebar", () => {
  const base = { ...noStoreSidebar(), store: true as const };

  it("falls back to a single line when there is no store", () => {
    expect(formatMemorySidebar(noStoreSidebar(), true)).toEqual(["Memory (no store)"]);
    expect(formatMemorySidebar(noStoreSidebar(), false)).toEqual(["Memory (no store)"]);
  });

  it("renders the collapsed two-line shape with the hot marker", () => {
    const snap = { ...base, live: 10, stale: 3, shareable: 5, hot: 2 };
    expect(formatMemorySidebar(snap, true, NOW)).toEqual([
      "▶ Memory ● 2 hot",
      "10 entries · 3 stale · 5 to share",
    ]);
  });

  it("drops the hot marker and the stale segment when they are zero", () => {
    const snap = { ...base, live: 10, stale: 0, shareable: 5, hot: 0 };
    expect(formatMemorySidebar(snap, true, NOW)).toEqual(["▶ Memory", "10 entries · 5 to share"]);
  });

  it("renders the expanded machine-wide breakdown", () => {
    const snap = {
      ...base,
      live: 508,
      trashed: 4,
      scope: 165,
      stale: 3,
      hot: 0,
      shareable: 5,
      kinds: [
        { kind: "fact", count: 270 },
        { kind: "lesson", count: 165 },
        { kind: "decision", count: 73 },
      ],
      last_sweep_ms: NOW - 3 * 3600_000,
      cooled: 12,
      sync_incoming: 2,
      mesh_installed: true,
    };
    expect(formatMemorySidebar(snap, false, NOW)).toEqual([
      "▼ Memory (machine-wide)",
      "508 live · 4 trashed · 165 in scope",
      "facts 270 · lessons 165 · decisions 73",
      "last sweep: 3h · 12 cooled · 3 stale",
      "sync: 2 incoming · 5 outgoing",
    ]);
  });

  it("pluralizes only plural counts and omits empty optional lines", () => {
    const snap = {
      ...base,
      live: 1,
      trashed: 0,
      scope: 1,
      stale: 0,
      kinds: [{ kind: "fact", count: 1 }],
      last_sweep_ms: null,
      mesh_installed: false,
    };
    expect(formatMemorySidebar(snap, false, NOW)).toEqual([
      "▼ Memory (machine-wide)",
      "1 live · 0 trashed · 1 in scope",
      "fact 1",
    ]);
  });

  it("formats human sweep ages across unit boundaries", () => {
    expect(formatAgeHuman(59_000)).toBe("59s");
    expect(formatAgeHuman(60_000)).toBe("1m");
    expect(formatAgeHuman(90 * 60_000)).toBe("1h");
    expect(formatAgeHuman(25 * 3600_000)).toBe("1d");
  });
});

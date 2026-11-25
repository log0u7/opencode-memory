import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openMemoryDb } from "../src/lib/db.js";
import { sweepHousekeeping } from "../src/lib/housekeeping.js";
import { buildSidebarSnapshot } from "../src/lib/tui-snapshot.js";
import { HOT_THRESHOLD } from "../src/lib/store.js";
import {
  MemoryRpc,
  formatAgeHuman,
  formatMemorySidebarCollapsed,
  formatMemorySidebarExpanded,
  noStoreSidebar,
  type SidebarSegment,
} from "../src/rpc.js";

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

/** The rendered text of one segment line, for readable assertions. */
function renderLine(line: SidebarSegment[] | undefined): string {
  return (line ?? []).map((seg) => seg.text).join("");
}

describe("sidebar wire schema", () => {
  it("declares every field buildSidebarSnapshot returns, including store_bytes", () => {
    // The host validates the output against the wire schema and strips unknown
    // fields: store_bytes was built but undeclared, arrived as undefined and
    // the collapsed header rendered "NaN kB" (seen live on 0.21.1).
    const props = MemoryRpc.methods.sidebar.output.properties;
    expect(props.store_bytes).toEqual({ type: "number", description: "Store file size on disk" });
    expect(MemoryRpc.methods.sidebar.output.required).toContain("store_bytes");
    const db = openMemoryDb(":memory:");
    insert(db, { title: "n1" });
    const snap = buildSidebarSnapshot(db, { scope: "/w", now: NOW });
    for (const key of Object.keys(snap)) {
      expect(props).toHaveProperty(key);
    }
  });
});

describe("formatMemorySidebarCollapsed", () => {
  const base = { ...noStoreSidebar(), store: true as const };

  it("falls back to a single bold line when there is no store", () => {
    expect(formatMemorySidebarCollapsed(noStoreSidebar())).toEqual([
      [{ text: "Memory (no store)", tone: "entity" }],
    ]);
  });

  it("renders the quota-style one-liner in the unified grammar: ▶ Memory ·N Rec ·size ·N Hots", () => {
    const snap = { ...base, live: 729, stale: 3, shareable: 5, hot: 2, store_bytes: 3_454_368 };
    const [line] = formatMemorySidebarCollapsed(snap);
    // The unified panel grammar (2026-11-25): compact separators (" ·" — the
    // space rides before the dot), the labels capitalized, no glyphs in fold
    // (the labels carry the signals), "Rec" never pluralizes (the
    // abbreviation rule), "Hot/Hots" follows the mode's title case.
    expect(renderLine(line)).toBe("▶ Memory ·729 Rec ·3.3 MB ·2 Hots");
    expect(line).toEqual([
      { text: "▶ Memory", tone: "entity" },
      { text: " ·", tone: "value" },
      { text: "729", tone: "qualifier" },
      { text: " Rec", tone: "value" },
      { text: " ·", tone: "value" },
      { text: "3.3", tone: "qualifier" },
      { text: " MB", tone: "value" },
      { text: " ·", tone: "value" },
      { text: "2 Hots", tone: "qualifier" },
    ]);
  });

  it("singularizes Rec and Hot for exactly one entry", () => {
    const snap = { ...base, live: 1, hot: 1, store_bytes: 1_048_576 };
    const [line] = formatMemorySidebarCollapsed(snap);
    expect(renderLine(line)).toBe("▶ Memory ·1 Rec ·1.0 MB ·1 Hot");
  });

  it("drops the hot segment when it is zero", () => {
    const snap = { ...base, live: 10, stale: 0, shareable: 5, hot: 0, store_bytes: 1_048_576 };
    expect(formatMemorySidebarCollapsed(snap)).toEqual([
      [
        { text: "▶ Memory", tone: "entity" },
        { text: " ·", tone: "value" },
        { text: "10", tone: "qualifier" },
        { text: " Rec", tone: "value" },
        { text: " ·", tone: "value" },
        { text: "1.0", tone: "qualifier" },
        { text: " MB", tone: "value" },
      ],
    ]);
  });
});

describe("formatMemorySidebarExpanded (v4)", () => {
  const base = { ...noStoreSidebar(), store: true as const };

  it("renders header, hot+sweep, counts, kinds, size and sync lines with tone tiers", () => {
    const snap = {
      ...base,
      live: 368,
      trashed: 118,
      hot: 2,
      last_sweep_ms: NOW - 2 * 3600_000,
      kinds: [
        { kind: "fact", count: 270 },
        { kind: "lesson", count: 165 },
      ],
      store_bytes: 3_145_728,
      mesh_installed: true,
      sync_incoming: 0,
      shareable: 3,
    };
    expect(formatMemorySidebarExpanded(snap, NOW)).toEqual([
      [{ text: "▼ Memory", tone: "entity" }],
      [
        { text: "  ●  ", tone: "alert" },
        { text: "2 hots", tone: "qualifier" },
        { text: " · sweep 2h ago", tone: "value" },
      ],
      [
        { text: "  ▤  ", tone: "qualifier" },
        { text: "368", tone: "qualifier" },
        { text: " live", tone: "value" },
        { text: " · ", tone: "value" },
        { text: "118", tone: "qualifier" },
        { text: " trashed", tone: "value" },
      ],
      [
        { text: "  ≡  ", tone: "qualifier" },
        { text: "270", tone: "qualifier" },
        { text: " facts", tone: "value" },
        { text: " · ", tone: "value" },
        { text: "165", tone: "qualifier" },
        { text: " lessons", tone: "value" },
      ],
      [
        { text: "  ⌗  ", tone: "qualifier" },
        { text: "3.0", tone: "qualifier" },
        { text: " MB", tone: "value" },
      ],
      [
        { text: "  ⇄  ", tone: "qualifier" },
        { text: "sync in ", tone: "value" },
        { text: "0", tone: "qualifier" },
        { text: " · out ", tone: "value" },
        { text: "3", tone: "qualifier" },
      ],
    ]);
  });

  it("omits the hot line at 0 hot and the sweep tail without metadata", () => {
    const snap = {
      ...base,
      live: 3,
      trashed: 0,
      hot: 0,
      last_sweep_ms: null,
      kinds: [{ kind: "fact", count: 3 }],
      mesh_installed: false,
    };
    const lines = formatMemorySidebarExpanded(snap, NOW);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toEqual([{ text: "▼ Memory", tone: "entity" }]);
    expect(renderLine(lines[1])).toBe("  ▤  3 live · 0 trashed");
    expect(renderLine(lines[2])).toBe("  ≡  3 facts");
  });

  it("shows the hot line without a sweep tail when no sweep ran yet", () => {
    const snap = { ...base, live: 1, hot: 1, last_sweep_ms: null };
    const lines = formatMemorySidebarExpanded(snap, NOW);
    expect(lines).toHaveLength(3);
    expect(renderLine(lines[1])).toBe("  ●  1 hot");
  });

  it("pluralizes singular kind counts", () => {
    const snap = { ...base, live: 1, trashed: 0, kinds: [{ kind: "lesson", count: 1 }] };
    const lines = formatMemorySidebarExpanded(snap, NOW);
    expect(renderLine(lines[2])).toBe("  ≡  1 lesson");
  });

  it("packs kinds two per line, no truncation", () => {
    const kinds = ["lesson", "fact", "decision", "preference", "gotcha", "finding", "anchor"].map(
      (kind, i) => ({ kind, count: 10 - i }),
    );
    const snap = { ...base, live: 55, trashed: 0, kinds, hot: 0 };
    const lines = formatMemorySidebarExpanded(snap, NOW);
    expect(lines).toHaveLength(6); // header + counts + four kind lines (2 per line)
    expect(renderLine(lines[2])).toBe("  ≡  10 lessons · 9 facts");
    expect(renderLine(lines[3])).toBe("  ≡  8 decisions · 7 preferences");
    expect(renderLine(lines[4])).toBe("  ≡  6 gotchas · 5 findings");
    expect(renderLine(lines[5])).toBe("  ≡  4 anchors");
  });

  it("omits the size line when store_bytes is 0 or absent", () => {
    const snap = { ...base, live: 3, trashed: 0, kinds: [{ kind: "fact", count: 3 }] };
    const lines = formatMemorySidebarExpanded(snap, NOW);
    expect(lines).toHaveLength(3);
    expect(lines.some((line) => renderLine(line).includes("⌗"))).toBe(false);
  });

  it("renders the size line after kinds, in kB below 1 MiB", () => {
    const snap = { ...base, live: 2, trashed: 0, kinds: [], store_bytes: 512 * 1024 };
    const lines = formatMemorySidebarExpanded(snap, NOW);
    expect(lines).toHaveLength(3); // header + counts + size
    expect(renderLine(lines[2])).toBe("  ⌗  512 kB");
  });

  it("formats human sweep ages across unit boundaries", () => {
    expect(formatAgeHuman(59_000)).toBe("59s");
    expect(formatAgeHuman(60_000)).toBe("1m");
    expect(formatAgeHuman(90 * 60_000)).toBe("1h");
    expect(formatAgeHuman(25 * 3600_000)).toBe("1d");
  });
});

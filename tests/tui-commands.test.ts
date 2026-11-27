import { describe, expect, it } from "vitest";

import { openMemoryDb } from "../src/lib/db.js";
import { scopeBreakdown, topEntries } from "../src/lib/store.js";
import {
  MemoryRpc,
  formatMemoryStatusDialog,
  noStoreSidebar,
  type SidebarSegment,
} from "../src/rpc.js";

const NOW = 1_800_000_000_000;

type Row = {
  scope?: string;
  kind?: string;
  title?: string;
};

function insert(db: ReturnType<typeof openMemoryDb>, overrides: Row = {}): string {
  const id = `${overrides.title ?? "note"}-${Math.random().toString(36).slice(2, 8)}`;
  db.conn.run(
    `INSERT INTO entries (id, scope, kind, title, body, tags, created_at, updated_at, expires_at,
       source, deleted_at, paths, commit_sha, supersedes, status, superseded_at, heat, endorsed_by)
     VALUES (?, ?, ?, ?, 'body', '[]', ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, 'current', NULL, 0, '[]')`,
    [id, overrides.scope ?? "/w", overrides.kind ?? "fact", overrides.title ?? "note", NOW, NOW],
  );
  return id;
}

function render(line: SidebarSegment[]): string {
  return line.map((seg) => seg.text).join("");
}

describe("scopeBreakdown and topEntries", () => {
  it("counts live entries machine-wide per scope, excluding trashed and expired", () => {
    const db = openMemoryDb(":memory:");
    insert(db, { scope: "/w", title: "a" });
    insert(db, { scope: "/w", title: "b" });
    insert(db, { scope: "global", title: "g" });
    insert(db, { scope: "/other", title: "o" });
    db.conn.run(`UPDATE entries SET deleted_at = ? WHERE title = 'o'`, [NOW]);

    const rows = scopeBreakdown(db, { now: NOW });
    const counts = new Map(rows.map((r) => [r.scope, r.count]));
    expect(counts.get("/w")).toBe(2);
    expect(counts.get("global")).toBe(1);
    expect(counts.has("/other")).toBe(false);
  });

  it("returns the most recently updated live entries for the stats view", () => {
    const db = openMemoryDb(":memory:");
    insert(db, { title: "old", kind: "fact" });
    insert(db, { title: "new", kind: "lesson" });
    db.conn.run(`UPDATE entries SET updated_at = ? WHERE title = 'old'`, [NOW - 1000]);
    db.conn.run(`UPDATE entries SET updated_at = ? WHERE title = 'new'`, [NOW]);

    const rows = topEntries(db, { limit: 1, now: NOW });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "lesson", title: "new" });
    expect(rows[0]?.id).toBeTruthy();
  });
});

describe("formatMemoryStatusDialog", () => {
  const base = { ...noStoreSidebar(), store: true as const };

  it("renders the rich status sections with tone tiers", () => {
    const snap = {
      ...base,
      live: 742,
      trashed: 3,
      hot: 2,
      stale: 1,
      scope: 742,
      last_sweep_ms: NOW - 4 * 60_000,
      cooled: 12,
      shareable: 5,
      sync_incoming: 2,
      mesh_installed: true,
      store_bytes: 3_454_368,
    };
    const lines = formatMemoryStatusDialog(snap, NOW);
    expect(lines.map(render)).toEqual([
      "Store 3.3 MB · 742 records in scope",
      "Live 742 live · 3 trashed",
      "Heat 2 hots · 1 stale anchor",
      "Sweep 4m ago · 12 cooled",
      "Sync in 2 · out 5 shareable",
      "Kinds (none)",
    ]);
    // Tone tiers: the section labels are values, the numbers qualifiers.
    expect(lines[0]?.[0]).toEqual({ text: "Store ", tone: "value" });
    expect(lines[0]?.[1]).toEqual({ text: "3.3", tone: "qualifier" });
  });

  it("reports a never-run sweep and omits the sync line without mesh", () => {
    const snap = { ...base, live: 1, hot: 0, last_sweep_ms: null, mesh_installed: false };
    const lines = formatMemoryStatusDialog(snap, NOW);
    const text = lines.map(render).join("\n");
    expect(text).toContain("Sweep never");
    expect(text).not.toContain("Sync");
  });

  it("lists the kind breakdown with counts", () => {
    const snap = {
      ...base,
      live: 4,
      kinds: [
        { kind: "fact", count: 3 },
        { kind: "lesson", count: 1 },
      ],
    };
    const lines = formatMemoryStatusDialog(snap, NOW);
    const text = lines.map(render).join("\n");
    expect(text).toContain("3 facts · 1 lesson");
  });
});

describe("MemoryRpc stats wire schema", () => {
  it("declares scopes, top, total and store_bytes", () => {
    const props = MemoryRpc.methods.stats.output.properties;
    expect(props.scopes).toBeDefined();
    expect(props.top).toBeDefined();
    expect(props.total).toBeDefined();
    expect(props.store_bytes).toBeDefined();
  });
});

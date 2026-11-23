import { existsSync, readdirSync } from "node:fs";

import { getMeta, type MemoryDb } from "./db.js";
import { isEntryFresh } from "./git.js";
import { HOT_THRESHOLD } from "./store.js";
import type { MemorySidebarSnapshot } from "../rpc.js";

/**
 * Bound on the anchored entries probed for staleness per snapshot: every probe
 * spawns git subprocesses, and the sidebar refreshes on a poll plus every host
 * event. Entries beyond the cap (most recently updated first) are not probed
 * this tick. shortcut: a cap is a count floor, not a ceiling — real stores hold
 * hundreds of entries; cache per (commit, paths, directory) if they grow past it.
 */
export const SIDEBAR_STALE_CAP = 200;

/** Usable rows only: current, not trashed, not expired. Superseded tombstones
 * are neither live nor trashed — the sidebar counts what a read could return. */
const CURRENT_LIVE =
  "status = 'current' AND deleted_at IS NULL AND (expires_at IS NULL OR expires_at > ?)";

function count(db: MemoryDb, sql: string, params: unknown[]): number {
  return db.conn.get<{ n: number }>(sql, params)?.n ?? 0;
}

/** Pending sync files in one directory (.jsonl only; `.jsonl.imported` ones were
 * already consumed by a previous import pass). A missing directory is "nothing
 * there yet", not an error. */
function countJsonl(dir: string | undefined): number {
  if (dir === undefined) {
    return 0;
  }
  try {
    return readdirSync(dir).filter((name) => name.endsWith(".jsonl")).length;
  } catch {
    return 0;
  }
}

/**
 * One aggregated read over the whole store for the TUI sidebar: machine-wide
 * counts (live, trashed, kinds, hot, shareable) plus the asking scope's share,
 * the staleness of its anchored entries (isEntryFresh against the project
 * directory), the last sweep's timestamp (metadata row) and cooled count (from
 * the caller's in-memory report), and the mesh sync file counts. Everything is
 * computed here so the formatter in rpc.ts stays a pure function of the
 * snapshot.
 */
export function buildSidebarSnapshot(
  db: MemoryDb,
  options: {
    /** The asking project's scope: stale and scope counts read scope + `global`. */
    scope: string;
    now: number;
    /** Git root the anchored entries are checked against; undefined skips the
     * staleness pass (stale stays 0). */
    directory?: string;
    /** Entries the caller's last housekeeping report cooled (in-memory only). */
    cooled?: number;
    /** Mesh sync directories; both undefined on a mesh-less machine. */
    inboxDir?: string;
    meshDataDir?: string;
  },
): MemorySidebarSnapshot {
  const now = options.now;
  const live = count(db, `SELECT COUNT(*) AS n FROM entries WHERE ${CURRENT_LIVE}`, [now]);
  const trashed = count(db, "SELECT COUNT(*) AS n FROM entries WHERE deleted_at IS NOT NULL", []);
  const kinds = db.conn.all<{ kind: string; count: number }>(
    `SELECT kind, COUNT(*) AS count FROM entries WHERE ${CURRENT_LIVE}
     GROUP BY kind ORDER BY count DESC, kind ASC`,
    [now],
  );
  const hot = count(db, `SELECT COUNT(*) AS n FROM entries WHERE heat >= ? AND ${CURRENT_LIVE}`, [
    HOT_THRESHOLD,
    now,
  ]);
  const shareable = count(
    db,
    `SELECT COUNT(*) AS n FROM entries
     WHERE endorsed_by IS NOT NULL AND endorsed_by != '[]' AND ${CURRENT_LIVE}`,
    [now],
  );
  const scope = count(
    db,
    `SELECT COUNT(*) AS n FROM entries WHERE (scope = ? OR scope = 'global') AND ${CURRENT_LIVE}`,
    [options.scope, now],
  );

  let stale = 0;
  if (options.directory !== undefined) {
    const anchored = db.conn.all<{ paths: string; commit_sha: string }>(
      `SELECT paths, commit_sha FROM entries
       WHERE (scope = ? OR scope = 'global') AND paths IS NOT NULL AND paths != '[]'
         AND commit_sha IS NOT NULL AND ${CURRENT_LIVE}
       ORDER BY updated_at DESC LIMIT ?`,
      [options.scope, now, SIDEBAR_STALE_CAP],
    );
    for (const row of anchored) {
      let paths: string[] = [];
      try {
        const parsed: unknown = JSON.parse(row.paths);
        if (Array.isArray(parsed)) {
          paths = parsed.filter((p): p is string => typeof p === "string");
        }
      } catch {
        // A malformed paths blob is not an anchored entry.
      }
      if (paths.length === 0) {
        continue;
      }
      if (!isEntryFresh({ commit_sha: row.commit_sha, paths }, options.directory)) {
        stale += 1;
      }
    }
  }

  const lastSweep = getMeta(db, "last_sweep_at");
  const lastSweepMs = lastSweep === null ? null : Number(lastSweep);
  return {
    store: true,
    live,
    trashed,
    kinds,
    hot,
    stale,
    shareable,
    scope,
    last_sweep_ms: lastSweepMs !== null && Number.isFinite(lastSweepMs) ? lastSweepMs : null,
    cooled: options.cooled ?? 0,
    sync_incoming: countJsonl(options.inboxDir),
    mesh_installed: options.meshDataDir !== undefined && existsSync(options.meshDataDir),
  };
}

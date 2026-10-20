import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { openSqlite, type SqliteConn } from "./sqlite.js";

export type MemoryDb = {
  conn: SqliteConn;
  close(): void;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS entries (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER,
  source TEXT,
  deleted_at INTEGER
);
CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
  title, body, tags,
  content='entries', content_rowid='rowid'
);
CREATE TRIGGER IF NOT EXISTS entries_ai AFTER INSERT ON entries BEGIN
  INSERT INTO entries_fts(rowid, title, body, tags) VALUES (new.rowid, new.title, new.body, new.tags);
END;
CREATE TRIGGER IF NOT EXISTS entries_ad AFTER DELETE ON entries BEGIN
  INSERT INTO entries_fts(entries_fts, rowid, title, body, tags) VALUES ('delete', old.rowid, old.title, old.body, old.tags);
END;
CREATE TRIGGER IF NOT EXISTS entries_au AFTER UPDATE ON entries BEGIN
  INSERT INTO entries_fts(entries_fts, rowid, title, body, tags) VALUES ('delete', old.rowid, old.title, old.body, old.tags);
  INSERT INTO entries_fts(rowid, title, body, tags) VALUES (new.rowid, new.title, new.body, new.tags);
END;
CREATE INDEX IF NOT EXISTS entries_scope_title ON entries(scope, lower(trim(title)));
`;

/** Columns added after the first release. `CREATE TABLE IF NOT EXISTS` never adds a column
 * to an existing database, so each one is backfilled on open. */
const ADDED_COLUMNS = ["source TEXT", "deleted_at INTEGER"];

// SECURITY.md promises restrictive permissions whatever the user's umask is, so the
// directory and files are mode-enforced explicitly instead of left to the umask.
// POSIX only: chmodSync on Windows flips a read-only bit, which would corrupt usage.
// Directories the plugin did not create are left to their owner: the db file is
// 0600 anyway, so a loose parent only leaks file names.
const POSIX = process.platform !== "win32";

export function openMemoryDb(path: string): MemoryDb {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  }

  const conn = openSqlite(path);
  conn.run("PRAGMA journal_mode = WAL");
  conn.run("PRAGMA busy_timeout = 5000");
  conn.exec(SCHEMA);
  addMissingColumns(conn);

  if (POSIX && path !== ":memory:") {
    // Also fixes databases created earlier with a permissive umask.
    chmodSync(path, 0o600);
    for (const suffix of ["-wal", "-shm"]) {
      try {
        chmodSync(`${path}${suffix}`, 0o600);
      } catch (error) {
        // Only tolerate a sidecar that is not written yet (or already
        // checkpointed away); anything else is a real failure.
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
    }
  }

  return { conn, close: () => conn.close() };
}

/** Size the database occupies on disk, WAL sidecars excluded. The store has no size cap
 * and no eviction, so this is the only signal a caller gets that it is growing. */
export function databaseSizeBytes(db: MemoryDb): number {
  const pages = db.conn.get<{ page_count: number }>("PRAGMA page_count")?.page_count ?? 0;
  const pageSize = db.conn.get<{ page_size: number }>("PRAGMA page_size")?.page_size ?? 0;
  return pages * pageSize;
}

/** Backfills the columns added since a store was first created, so a database written by
 * an older release opens on the current schema with its rows intact. Idempotent: the
 * second open finds nothing to add. */
function addMissingColumns(conn: SqliteConn): void {
  const present = new Set(
    conn.all<{ name: string }>("PRAGMA table_info(entries)").map((column) => column.name),
  );
  for (const column of ADDED_COLUMNS) {
    const name = column.split(" ")[0] ?? "";
    if (!present.has(name)) {
      conn.run(`ALTER TABLE entries ADD COLUMN ${column}`);
    }
  }
}

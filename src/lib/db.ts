import { mkdirSync } from "node:fs";
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
  expires_at INTEGER
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
`;

export function openMemoryDb(path: string): MemoryDb {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }

  const conn = openSqlite(path);
  conn.run("PRAGMA journal_mode = WAL");
  conn.run("PRAGMA busy_timeout = 5000");
  conn.exec(SCHEMA);

  return { conn, close: () => conn.close() };
}

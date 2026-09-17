import { randomUUID } from "node:crypto";

import type { MemoryDb } from "./db.js";
import type { Entry, EntryInput } from "../types/entry.js";

const TITLE_MAX = 120;
const BODY_MAX = 8000;
const TAGS_MAX = 12;

const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\bghp_[A-Za-z0-9]{30,}\b/,
  /\bxoxb-\d{10,}-\d{10,}\b/,
];

export class SecretDetectedError extends Error {
  constructor() {
    super("entry body looks like a credential; secrets must never be stored in memory");
    this.name = "SecretDetectedError";
  }
}

export function validateEntry(input: EntryInput): void {
  if (input.title.length === 0 || input.title.length > TITLE_MAX) {
    throw new TypeError(`title must be 1..${TITLE_MAX} characters`);
  }
  if (input.body.length > BODY_MAX) {
    throw new TypeError(`body must be at most ${BODY_MAX} characters`);
  }
  if (input.tags.length > TAGS_MAX) {
    throw new TypeError(`at most ${TAGS_MAX} tags allowed`);
  }
  if (
    SECRET_PATTERNS.some(
      (pattern) => pattern.test(input.body) || input.tags.some((t) => pattern.test(t)),
    )
  ) {
    throw new SecretDetectedError();
  }
}

export function save(db: MemoryDb, input: EntryInput, options: { now?: number } = {}): Entry {
  validateEntry(input);
  const now = options.now ?? Date.now();
  const id = randomUUID();

  db.conn.run(
    "INSERT INTO entries (id, scope, kind, title, body, tags, created_at, updated_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      id,
      input.scope,
      input.kind,
      input.title,
      input.body,
      JSON.stringify(input.tags),
      now,
      now,
      input.expires_at,
    ],
  );

  return {
    id,
    scope: input.scope,
    kind: input.kind,
    title: input.title,
    body: input.body,
    tags: input.tags,
    created_at: now,
    updated_at: now,
    expires_at: input.expires_at,
  };
}

export function search(
  db: MemoryDb,
  query: { query: string; scope: string; limit?: number; now?: number },
): Entry[] {
  const limit = query.limit ?? 10;
  const now = query.now ?? Date.now();

  return db.conn
    .all<Row>(
      `SELECT e.* FROM entries_fts JOIN entries e ON e.rowid = entries_fts.rowid
       WHERE entries_fts MATCH ? AND (e.scope = ? OR e.scope = 'global')
         AND (e.expires_at IS NULL OR e.expires_at > ?)
       ORDER BY bm25(entries_fts) ASC, e.updated_at DESC
       LIMIT ?`,
      [escapeFtsQuery(query.query), query.scope, now, limit],
    )
    .map(rowToEntry);
}

export function list(
  db: MemoryDb,
  query: { scope: string; limit?: number; now?: number },
): Entry[] {
  const limit = query.limit ?? 20;
  const now = query.now ?? Date.now();

  return db.conn
    .all<Row>(
      `SELECT * FROM entries
       WHERE (scope = ? OR scope = 'global') AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY updated_at DESC, id ASC
       LIMIT ?`,
      [query.scope, now, limit],
    )
    .map(rowToEntry);
}

export function forget(db: MemoryDb, target: { id: string } | { query: string }): number {
  if ("id" in target) {
    db.conn.run("DELETE FROM entries WHERE id = ?", [target.id]);
    return db.conn.get<{ changes: number }>("SELECT changes() AS changes")?.changes ?? 0;
  }

  db.conn.run(
    `DELETE FROM entries WHERE id IN (
       SELECT e.id FROM entries_fts JOIN entries e ON e.rowid = entries_fts.rowid WHERE entries_fts MATCH ?
     )`,
    [escapeFtsQuery(target.query)],
  );
  return db.conn.get<{ changes: number }>("SELECT changes() AS changes")?.changes ?? 0;
}

type Row = {
  id: string;
  scope: string;
  kind: string;
  title: string;
  body: string;
  tags: string;
  created_at: number;
  updated_at: number;
  expires_at: number | null;
};

function rowToEntry(row: Row): Entry {
  return {
    id: row.id,
    scope: row.scope,
    kind: row.kind,
    title: row.title,
    body: row.body,
    tags: parseTags(row.tags),
    created_at: row.created_at,
    updated_at: row.updated_at,
    expires_at: row.expires_at,
  };
}

function parseTags(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}

// FTS5 queries treat punctuation as operators; wrap each whitespace-separated
// token in double quotes so arbitrary user/model input stays a literal search.
function escapeFtsQuery(raw: string): string {
  return raw
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => `"${token.replaceAll('"', '""')}"`)
    .join(" ");
}

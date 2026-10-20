import { randomUUID } from "node:crypto";

import type { MemoryDb } from "./db.js";
import type { Entry, EntryInput } from "../types/entry.js";

const TITLE_MAX = 120;
const BODY_MAX = 8000;
const TAGS_MAX = 12;
export const TAG_MAX = 64;
export const KIND_MAX = 64;
/** Hard ceiling on how many entries one read can return, whatever the caller asks. */
export const MAX_LIMIT = 50;
/** A rendered body is a preview, never the full text: it bounds a tool result. */
export const BODY_PREVIEW_MAX = 500;

export const DEFAULT_LIMIT = { search: 10, list: 20 };

/** Scope used when no worktree and no directory is known, so rows stay addressable. */
export const FALLBACK_SCOPE = "/";

/** How long a trashed entry stays restorable before a sweep drops it for good. A
 * recoverable delete is worthless if the trash itself grows without bound. */
export const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Live rows only: a trashed entry is invisible to every read until it is restored. */
const LIVE = "deleted_at IS NULL";

// High-confidence credential formats only: a generic "password =" rule would block
// ordinary prose. Extend with care, one false positive costs a legitimate save.
const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{20,}\b/, // OpenAI-style, also covers Anthropic sk-ant- keys
  /\bgh[posur]_[A-Za-z0-9]{30,}\b/, // GitHub PAT, OAuth, server-to-server, user-to-server, refresh
  /\bgithub_pat_[A-Za-z0-9_]{22,}\b/, // GitHub fine-grained PAT
  /\bxoxb-\d{10,}-\d{10,}\b/, // Slack bot token
  /\bxox[ap]-[0-9A-Za-z-]{10,}/, // Slack user / app token
  /https:\/\/hooks\.slack\.com\/services\/T[A-Za-z0-9]+/, // Slack incoming webhook
  /\bA(?:K|S)IA[0-9A-Z]{16}\b/, // AWS access key id, long-lived and temporary
  /\bgl(?:pat|rt)-[0-9A-Za-z_-]{20,}\b/, // GitLab PAT and rotate token
  /\bnpm_[A-Za-z0-9]{36}\b/, // npm granular token
  /\bAIza[0-9A-Za-z_-]{35}/, // Google API key
  /\bya29\.[0-9A-Za-z_-]{20,}\b/, // Google OAuth access token
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/, // JWT
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/, // PEM private key block header
];

export class SecretDetectedError extends Error {
  constructor() {
    super("entry body looks like a credential; secrets must never be stored in memory");
    this.name = "SecretDetectedError";
  }
}

/**
 * One canonical scope string for one location. Callers hand in a worktree, a
 * directory, or both, so an entry written by either plugin entry point is found
 * by the other.
 */
export function canonicalScope(...candidates: Array<string | undefined>): string {
  const first = candidates.find((c) => typeof c === "string" && c.trim().length > 0);
  if (first === undefined) {
    return FALLBACK_SCOPE;
  }
  return first.trim().replace(/\/+$/, "") || FALLBACK_SCOPE;
}

function validateEntry(input: EntryInput): void {
  if (input.title.length === 0 || input.title.length > TITLE_MAX) {
    throw new TypeError(`title must be 1..${TITLE_MAX} characters`);
  }
  if (input.body.length > BODY_MAX) {
    throw new TypeError(`body must be at most ${BODY_MAX} characters`);
  }
  if (input.kind.length === 0 || input.kind.length > KIND_MAX) {
    throw new TypeError(`kind must be 1..${KIND_MAX} characters`);
  }
  if (input.tags.length > TAGS_MAX) {
    throw new TypeError(`at most ${TAGS_MAX} tags allowed`);
  }
  // A tool result stays bounded, so a tag cannot smuggle an unbounded payload either.
  if (input.tags.some((tag) => tag.length > TAG_MAX)) {
    throw new TypeError(`each tag must be at most ${TAG_MAX} characters`);
  }
  if (SECRET_PATTERNS.some((pattern) => looksLikeSecret(input, pattern))) {
    throw new SecretDetectedError();
  }
}

function looksLikeSecret(input: EntryInput, pattern: RegExp): boolean {
  if (pattern.test(input.title) || pattern.test(input.kind) || pattern.test(input.body)) {
    return true;
  }
  return input.tags.some((t) => pattern.test(t));
}

/** A model-supplied limit is untrusted: SQLite reads a negative LIMIT as unbounded,
 * so anything below one falls back to the default, and anything above the store
 * ceiling is clamped. */
export function clampLimit(requested: number | undefined, fallback: number): number {
  if (requested === undefined || !Number.isFinite(requested) || requested < 1) {
    return fallback;
  }
  return Math.min(Math.trunc(requested), MAX_LIMIT);
}

function previewBody(body: string): string {
  if (body.length <= BODY_PREVIEW_MAX) {
    return body;
  }
  return `${body.slice(0, BODY_PREVIEW_MAX)}… [truncated]`;
}

/**
 * Model-facing rendering of a result set. Compact JSON and truncated bodies keep a
 * tool result inside a known size regardless of how much is stored.
 */
export function renderEntries(entries: Entry[]): string {
  return JSON.stringify(entries.map((entry) => ({ ...entry, body: previewBody(entry.body) })));
}

export function sweep(db: MemoryDb, options: { now?: number } = {}): number {
  const now = options.now ?? Date.now();
  db.conn.run("DELETE FROM entries WHERE expires_at IS NOT NULL AND expires_at <= ?", [now]);
  const expired = changesOf(db);
  db.conn.run("DELETE FROM entries WHERE deleted_at IS NOT NULL AND deleted_at <= ?", [
    now - TRASH_RETENTION_MS,
  ]);
  return expired + changesOf(db);
}

function changesOf(db: MemoryDb): number {
  return db.conn.get<{ changes: number }>("SELECT changes() AS changes")?.changes ?? 0;
}

/** Whether a save inserted a row or rewrote the one already holding that scope and
 * title, so a caller can tell the model what actually happened. */
export type SaveResult = { entry: Entry; created: boolean };

export function save(db: MemoryDb, input: EntryInput, options: { now?: number } = {}): Entry {
  return saveEntry(db, input, options).entry;
}

export function saveEntry(
  db: MemoryDb,
  input: EntryInput,
  options: { now?: number } = {},
): SaveResult {
  validateEntry(input);
  const scope = canonicalScope(input.scope);
  const now = options.now ?? Date.now();

  // Expired rows are dead weight in search, so drop them with the save.
  sweep(db, { now });

  // A repeated title in the same scope is the same knowledge: rewrite it instead of
  // stacking duplicates.
  // ponytail: SQLite lower() folds ASCII only, so a non-ASCII title re-saved in a
  // different case is not deduped; and the read-then-write is not transactional, so two
  // concurrent saves of the same title can both insert. Ceiling is a rare duplicate, not
  // data loss. Upgrade path: a normalized key column plus BEGIN IMMEDIATE.
  const existing = db.conn.get<{ id: string; created_at: number }>(
    `SELECT id, created_at FROM entries WHERE scope = ? AND lower(trim(title)) = ? AND ${LIVE}`,
    [scope, input.title.trim().toLowerCase()],
  );

  if (existing) {
    db.conn.run(
      "UPDATE entries SET kind = ?, body = ?, tags = ?, updated_at = ?, expires_at = ?, source = ? WHERE id = ?",
      [
        input.kind,
        input.body,
        JSON.stringify(input.tags),
        now,
        input.expires_at ?? null,
        input.source ?? null,
        existing.id,
      ],
    );
    return {
      entry: {
        id: existing.id,
        scope,
        kind: input.kind,
        title: input.title,
        body: input.body,
        tags: input.tags,
        created_at: existing.created_at,
        updated_at: now,
        expires_at: input.expires_at,
        ...(input.source !== undefined ? { source: input.source } : {}),
      },
      created: false,
    };
  }

  const id = randomUUID();
  db.conn.run(
    "INSERT INTO entries (id, scope, kind, title, body, tags, created_at, updated_at, expires_at, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      id,
      scope,
      input.kind,
      input.title,
      input.body,
      JSON.stringify(input.tags),
      now,
      now,
      input.expires_at,
      input.source ?? null,
    ],
  );

  return {
    entry: {
      id,
      scope,
      kind: input.kind,
      title: input.title,
      body: input.body,
      tags: input.tags,
      created_at: now,
      updated_at: now,
      expires_at: input.expires_at,
      ...(input.source !== undefined ? { source: input.source } : {}),
    },
    created: true,
  };
}

/**
 * Fused search. The strict pass runs first and the prefix pass only fills what is left of
 * the limit, so a query never loses the loose matches it used to discard: two entries
 * holding every token answer a limit of ten with two results today.
 *
 * A strict hit contains every token by construction, so it is definitionally stronger
 * than a prefix hit. Pinning strict above prefix is therefore the correct special case of
 * reciprocal rank fusion, without the score arithmetic.
 */
export function search(
  db: MemoryDb,
  query: { query: string; scope: string; limit?: number; now?: number },
): Entry[] {
  const scope = canonicalScope(query.scope);
  const limit = clampLimit(query.limit, DEFAULT_LIMIT.search);
  const now = query.now ?? Date.now();

  const hits: Entry[] = [];
  const seen = new Set<string>();
  for (const match of searchCandidates(query.query)) {
    for (const entry of ftsHits(db, match, scope, now, limit)) {
      if (!seen.has(entry.id)) {
        seen.add(entry.id);
        hits.push(entry);
      }
    }
    if (hits.length >= limit) {
      break;
    }
  }
  return hits.slice(0, limit);
}

function ftsHits(db: MemoryDb, match: string, scope: string, now: number, limit: number): Entry[] {
  return db.conn
    .all<Row>(
      `SELECT e.* FROM entries_fts JOIN entries e ON e.rowid = entries_fts.rowid
       WHERE entries_fts MATCH ? AND (e.scope = ? OR e.scope = 'global')
         AND (e.expires_at IS NULL OR e.expires_at > ?) AND e.${LIVE}
       ORDER BY bm25(entries_fts) ASC, e.updated_at DESC
       LIMIT ?`,
      [match, scope, now, limit],
    )
    .map(rowToEntry);
}

export function list(
  db: MemoryDb,
  query: { scope: string; limit?: number; now?: number; kind?: string },
): Entry[] {
  const scope = canonicalScope(query.scope);
  const limit = clampLimit(query.limit, DEFAULT_LIMIT.list);
  const now = query.now ?? Date.now();
  const kindFilter = query.kind === undefined ? "" : "AND kind = ? ";
  const kindArgs = query.kind === undefined ? [] : [query.kind];

  return db.conn
    .all<Row>(
      `SELECT * FROM entries
       WHERE (scope = ? OR scope = 'global') AND (expires_at IS NULL OR expires_at > ?) ${kindFilter}
         AND ${LIVE}
       ORDER BY updated_at DESC, id ASC
       LIMIT ?`,
      [scope, now, ...kindArgs, limit],
    )
    .map(rowToEntry);
}

export type ForgetTarget = { scope: string } & ({ id: string } | { query: string });

/** Counts by kind for one scope plus `global`, expired entries excluded. */
export function stats(
  db: MemoryDb,
  query: { scope: string; now?: number },
): Array<{ kind: string; count: number }> {
  const scope = canonicalScope(query.scope);
  const now = query.now ?? Date.now();
  return db.conn.all<{ kind: string; count: number }>(
    `SELECT kind, COUNT(*) AS count FROM entries
     WHERE (scope = ? OR scope = 'global') AND (expires_at IS NULL OR expires_at > ?) AND ${LIVE}
     GROUP BY kind ORDER BY count DESC, kind ASC`,
    [scope, now],
  );
}

/** Creation date of the oldest live entry in one scope plus `global`, or null when the
 * scope is empty: the store grows without bound, so age is the signal that knowledge is
 * rotting rather than accumulating. */
export function oldestCreated(db: MemoryDb, query: { scope: string; now?: number }): number | null {
  const scope = canonicalScope(query.scope);
  const now = query.now ?? Date.now();
  const row = db.conn.get<{ oldest: number | null }>(
    `SELECT MIN(created_at) AS oldest FROM entries
     WHERE (scope = ? OR scope = 'global') AND (expires_at IS NULL OR expires_at > ?) AND ${LIVE}`,
    [scope, now],
  );
  return row?.oldest ?? null;
}

/**
 * Query deletes stay inside one scope (plus the shared `global` scope): a fuzzy match
 * must never silently hit other projects' entries. Id deletes are machine-wide because
 * the id is globally unique: closed worktrees stay cleanable from any project.
 *
 * Both forms trash instead of dropping, so a wrong delete is recoverable, and both report
 * the entries they moved: a broad query can take many rows at once, and the caller has to
 * be able to say which ones. Only live rows count, so a second delete of the same target
 * is a no-op.
 */
export function forget(db: MemoryDb, target: ForgetTarget): Entry[] {
  const trashed =
    "id" in target
      ? db.conn.all<Row>(`SELECT * FROM entries WHERE id = ? AND ${LIVE}`, [target.id])
      : trashedByQuery(db, target);

  if (trashed.length === 0) {
    return [];
  }
  const now = Date.now();
  const ids = trashed.map((row) => row.id);
  db.conn.run(`UPDATE entries SET deleted_at = ? WHERE id IN (${ids.map(() => "?").join(", ")})`, [
    now,
    ...ids,
  ]);
  return trashed.map(rowToEntry);
}

/** Puts a trashed entry back into every read. Machine-wide by id, mirroring the delete it
 * undoes; `null` when the id is not in the trash. */
export function restore(db: MemoryDb, target: { id: string }): Entry | null {
  const row = db.conn.get<Row>(`SELECT * FROM entries WHERE id = ? AND deleted_at IS NOT NULL`, [
    target.id,
  ]);
  if (row === null) {
    return null;
  }
  db.conn.run("UPDATE entries SET deleted_at = NULL WHERE id = ?", [target.id]);
  return rowToEntry(row);
}

function trashedByQuery(db: MemoryDb, target: { query: string; scope: string }): Row[] {
  const scope = canonicalScope(target.scope);

  // Deleting is precision-first: only the strict all-token match, never the fuzzy
  // fallback. A wrong read costs the model a retry, a wrong delete used to be
  // unrecoverable; it now costs a restore.
  const match = strictMatch(target.query);
  if (match === null) {
    return [];
  }
  return db.conn.all<Row>(
    `SELECT e.* FROM entries_fts JOIN entries e ON e.rowid = entries_fts.rowid
     WHERE entries_fts MATCH ? AND (e.scope = ? OR e.scope = 'global') AND e.${LIVE}`,
    [match, scope],
  );
}

type Row = Omit<Entry, "tags" | "source"> & {
  tags: string;
  source: string | null;
  deleted_at: number | null;
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
    ...(row.source !== null ? { source: row.source } : {}),
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

/**
 * FTS5 candidates, most precise first, each quoted so arbitrary model input stays a
 * literal search. The strict AND match is fused ahead of the looser prefix OR match:
 * precision leads, recall fills what is left of the limit.
 */
function searchCandidates(raw: string): string[] {
  const strict = strictMatch(raw);
  const loose = prefixMatch(raw);
  return [strict, loose].filter((candidate): candidate is string => candidate !== null);
}

/** Every token must appear. Used alone by destructive paths, where a false positive
 * cannot be undone. */
function strictMatch(raw: string): string | null {
  const tokens = tokenize(raw);
  return tokens.length === 0 ? null : tokens.map((token) => `"${token}"`).join(" ");
}

/** Any token may match, each as a prefix. Read-only recall only. */
function prefixMatch(raw: string): string | null {
  const tokens = tokenize(raw);
  return tokens.length === 0 ? null : tokens.map((token) => `"${token}" *`).join(" OR ");
}

function tokenize(raw: string): string[] {
  return raw
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => token.replaceAll('"', ""));
}

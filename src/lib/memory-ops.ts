import { existsSync } from "node:fs";

import { databaseSizeBytes, type MemoryDb } from "./db.js";
import {
  forget,
  list,
  oldestCreated,
  renderEntries,
  saveEntry,
  search,
  SecretDetectedError,
  stats,
} from "./store.js";
import type { Entry } from "../types/entry.js";

// Optional properties accept undefined explicitly: the two SDK dialects hand raw
// tool arguments straight through, and the build enables exactOptionalPropertyTypes.
export type SaveArgs = {
  kind: string;
  title: string;
  body: string;
  tags?: string[] | undefined;
  expires_at?: number | null | undefined;
  source?: string | undefined;
};
export type SearchArgs = { query: string; limit?: number | undefined };
export type ListArgs = { limit?: number | undefined };
export type ForgetArgs = { id?: string | undefined; query?: string | undefined };

/** One shared behaviour behind both plugin entry points. Every operation returns the
 * model-facing text directly, so a caller cannot bypass caps or error handling. */
export type MemoryOps = {
  save: (args: SaveArgs, scope: string, source?: string) => string;
  search: (args: SearchArgs, scope: string) => string;
  list: (args: ListArgs, scope: string) => string;
  forget: (args: ForgetArgs, scope: string) => string;
  stats: (scope: string) => string;
};

export function createMemoryOps(getDb: () => MemoryDb): MemoryOps {
  return {
    save: (args, scope, source) =>
      run(() => {
        const { entry, created } = saveEntry(getDb(), {
          scope,
          kind: args.kind,
          title: args.title,
          body: args.body,
          tags: args.tags ?? [],
          expires_at: args.expires_at ?? null,
          ...(source !== undefined ? { source } : {}),
        });
        return `saved ${entry.id} (${entry.scope}, ${created ? "created" : "updated"})`;
      }),
    search: (args, scope) =>
      run(() => {
        const hits = search(getDb(), {
          query: args.query,
          scope,
          ...(args.limit !== undefined ? { limit: args.limit } : {}),
        });
        return hits.length === 0 ? "no matching memory entries" : renderEntries(hits);
      }),
    list: (args, scope) =>
      run(() => {
        const entries = list(getDb(), {
          scope,
          ...(args.limit !== undefined ? { limit: args.limit } : {}),
        });
        return entries.length === 0 ? "no memory entries" : renderEntries(entries);
      }),
    forget: (args, scope) =>
      run(() => {
        const removed =
          args.id !== undefined
            ? forget(getDb(), { id: args.id, scope })
            : args.query !== undefined
              ? forget(getDb(), { query: args.query, scope })
              : null;
        if (removed === null) {
          return "provide id or query";
        }
        if (removed.length === 0) {
          return "deleted 0 entries";
        }
        const plural = removed.length === 1 ? "y" : "ies";
        return `deleted ${removed.length} entr${plural}: ${renderRemoved(removed)}`;
      }),
    stats: (scope) =>
      run(() => {
        const counts = stats(getDb(), { scope });
        if (counts.length === 0) {
          return "no memory entries";
        }
        const total = counts.reduce((sum, row) => sum + row.count, 0);
        const oldest = oldestCreated(getDb(), { scope });
        const size = formatBytes(databaseSizeBytes(getDb()));
        const age = oldest === null ? "" : `, oldest: ${dayOf(oldest)}`;
        return `store: ${size}${age}, ${counts
          .map((row) => `${row.kind}: ${row.count}`)
          .join(", ")}, total: ${total}`;
      }),
  };
}

/** How many removed entries a delete report names before it summarizes the rest, so a
 * broad query delete stays a bounded tool result. */
const REMOVED_REPORT_MAX = 10;

function renderRemoved(entries: Entry[]): string {
  const listed = entries
    .slice(0, REMOVED_REPORT_MAX)
    .map((entry) => `${JSON.stringify(entry.title)} (${entry.id})`);
  const rest = entries.length - REMOVED_REPORT_MAX;
  return rest > 0 ? `${listed.join(", ")}, and ${rest} more` : listed.join(", ");
}

function formatBytes(bytes: number): string {
  const kb = bytes / 1024;
  return kb < 1024 ? `${kb.toFixed(1)} KB` : `${(kb / 1024).toFixed(1)} MB`;
}

/** How much of the store is summarised into a prompt, worst case. */
export const INVENTORY_MAX_CHARS = 1200;

const INVENTORY_HEADER = "Memory already stored for this project (lessons first, then newest):";

/** Tool descriptions shared by both entry points so the two hosts cannot drift. */
export const TOOL_DESCRIPTIONS = {
  save: "Save a durable entry to shared working memory (decisions, facts, preferences, gotchas, lessons). Never store credentials.",
  search:
    "Search shared working memory (all sessions on this machine). Results include this project's scope and global entries: entries matching every query token come first, then entries matching some token as a prefix fill the remaining slots.",
  list: "List recent memory entries for a scope (default: this project), newest first.",
  forget:
    "Delete memory entries by id (any scope: ids are globally unique), or all entries matching a query. Query deletes stay inside this project's scope (plus global entries); an entry saved under another scope needs its id, or that scope, to be removed.",
  stats:
    "Count memory entries by kind for this project (plus global entries), with a total. Use it to see how much memory already exists, for example how many lessons reflection has written.",
} as const;

/**
 * Produces at most one injection per session key, and only on the first request where
 * the producer has something: a session that starts before any entry exists still gets
 * its inventory as soon as one is available. Keys are capped so a long-lived host
 * cannot grow the set forever; an absent sessionID (v1 marks it optional) degrades to
 * one injection per plugin instance, never per request.
 */
export function oncePerSession() {
  const seen = new Set<string>();
  const MAX_KEYS = 512;
  const inject = (key: string | undefined, produce: () => string | null): string | null => {
    const k = key ?? "__instance__";
    if (seen.has(k)) {
      return null;
    }
    const produced = produce();
    if (produced === null) {
      return null;
    }
    seen.add(k);
    if (seen.size > MAX_KEYS) {
      seen.clear();
    }
    return produced;
  };
  return { inject, reset: () => seen.clear() };
}

/**
 * Bounded summary of recent entries, injected into the first request of a session and
 * into the compaction context. Lessons are promoted above recency noise so a stored
 * lesson survives a chatty store. `null` when there is nothing worth injecting, so a
 * caller pushes nothing at all.
 */
export function memoryInventory(
  getDb: () => MemoryDb,
  dbPath: string,
  scope: string,
): string | null {
  if (!existsSync(dbPath)) {
    return null;
  }

  const lessons = list(getDb(), { scope, limit: 50, kind: "lesson" });
  const others = list(getDb(), { scope, limit: 50 });
  if (lessons.length === 0 && others.length === 0) {
    return null;
  }

  const seen = new Set(lessons.map((entry) => entry.id));
  const ordered = [...lessons, ...others.filter((entry) => !seen.has(entry.id))];

  const lines = [INVENTORY_HEADER];
  let size = INVENTORY_HEADER.length;
  for (const entry of ordered) {
    const by = entry.source === undefined ? "" : `, by ${entry.source}`;
    const line = `- [${entry.kind}] ${entry.title} (updated ${dayOf(entry.updated_at)}${by})`;
    if (size + line.length + 1 > INVENTORY_MAX_CHARS) {
      break;
    }
    lines.push(line);
    size += line.length + 1;
  }
  return lines.join("\n");
}

function dayOf(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

// Tool results are shown to the model: caught errors become readable text, so a
// rejected save is guidance instead of a crashed tool call.
function run(fn: () => string): string {
  try {
    return fn();
  } catch (error) {
    if (error instanceof SecretDetectedError) {
      return "refused: the content looks like a credential; secrets must never be stored in memory";
    }
    if (error instanceof Error) {
      return `error: ${error.message}`;
    }
    throw error;
  }
}

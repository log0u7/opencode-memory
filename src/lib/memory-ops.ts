import { existsSync } from "node:fs";

import type { MemoryDb } from "./db.js";
import { forget, list, renderEntries, save, search, SecretDetectedError } from "./store.js";

// Optional properties accept undefined explicitly: the two SDK dialects hand raw
// tool arguments straight through, and the build enables exactOptionalPropertyTypes.
export type SaveArgs = {
  kind: string;
  title: string;
  body: string;
  tags?: string[] | undefined;
  expires_at?: number | null | undefined;
};
export type SearchArgs = { query: string; limit?: number | undefined };
export type ListArgs = { limit?: number | undefined };
export type ForgetArgs = { id?: string | undefined; query?: string | undefined };

/** One shared behaviour behind both plugin entry points. Every operation returns the
 * model-facing text directly, so a caller cannot bypass caps or error handling. */
export type MemoryOps = {
  save: (args: SaveArgs, scope: string) => string;
  search: (args: SearchArgs, scope: string) => string;
  list: (args: ListArgs, scope: string) => string;
  forget: (args: ForgetArgs, scope: string) => string;
};

export function createMemoryOps(getDb: () => MemoryDb): MemoryOps {
  return {
    save: (args, scope) =>
      run(() => {
        const entry = save(getDb(), {
          scope,
          kind: args.kind,
          title: args.title,
          body: args.body,
          tags: args.tags ?? [],
          expires_at: args.expires_at ?? null,
        });
        return `saved ${entry.id} (${entry.scope})`;
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
        if (args.id !== undefined) {
          const deleted = forget(getDb(), { id: args.id, scope });
          return `deleted ${deleted} entr${deleted === 1 ? "y" : "ies"}`;
        }
        if (args.query !== undefined) {
          const deleted = forget(getDb(), { query: args.query, scope });
          return `deleted ${deleted} entr${deleted === 1 ? "y" : "ies"}`;
        }
        return "provide id or query";
      }),
  };
}

/** How much of the store is summarised into a prompt, worst case. */
export const INVENTORY_MAX_CHARS = 1200;

const INVENTORY_HEADER = "Memory already stored for this project (newest first):";

/** Tool descriptions shared by both entry points so the two hosts cannot drift. */
export const TOOL_DESCRIPTIONS = {
  save: "Save a durable entry to shared working memory (decisions, facts, preferences, gotchas). Never store credentials.",
  search:
    "Search shared working memory (all sessions on this machine). Results include this project's scope and global entries.",
  list: "List recent memory entries for a scope (default: this project), newest first.",
  forget: "Delete memory entries by id, or all entries matching a query.",
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
 * into the compaction context. `null` when there is nothing worth injecting, so a
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

  const entries = list(getDb(), { scope, limit: 50 });
  if (entries.length === 0) {
    return null;
  }

  const lines = [INVENTORY_HEADER];
  let size = INVENTORY_HEADER.length;
  for (const entry of entries) {
    const line = `- [${entry.kind}] ${entry.title} (updated ${dayOf(entry.updated_at)})`;
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

import { Plugin } from "@opencode/plugin";

import { openMemoryDb, type MemoryDb } from "./lib/db.js";
import { forget, list, save, search, SecretDetectedError } from "./lib/store.js";
import {
  SYSTEM_GUIDANCE,
  COMPACTION_CONTEXT,
  defaultDbPath,
  type PluginOptions,
} from "./plugin.js";

const textPart = (text: string) => ({ type: "text" as const, text });

export const MemoryV2 = Plugin.define({
  id: "@log0u7/opencode-memory",
  async setup(ctx) {
    const options = ctx.options as PluginOptions;
    let db: MemoryDb | null = null;

    const getDb = (): MemoryDb => {
      if (!db) {
        db = openMemoryDb(defaultDbPath(options));
      }
      return db;
    };

    // Tool results are shown to the model: caught errors become readable text, so
    // a rejected save is guidance instead of a crashed tool call.
    const run = async (fn: () => string): Promise<string> => {
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
    };

    // v1 scoped entries per session worktree; the v2 tool context carries no
    // worktree, so entries default to the plugin location's directory.
    const defaultScope = ctx.location.directory;

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "memory_save",
        description:
          "Save a durable entry to shared working memory (decisions, facts, preferences, gotchas). Never store credentials.",
        input: {
          type: "object",
          properties: {
            kind: {
              type: "string",
              description: "Entry type, e.g. decision, fact, preference, gotcha",
            },
            title: { type: "string", description: "Short title (max 120 chars)" },
            body: { type: "string", description: "Entry content (max 8000 chars)" },
            scope: { type: "string", description: "Scope key; defaults to the project directory" },
            tags: { type: "array", items: { type: "string" }, description: "Optional tags" },
            expires_at: { type: "number", description: "Optional epoch ms expiry" },
          },
          required: ["kind", "title", "body"],
          additionalProperties: false,
        },
        async execute(args) {
          const a = args as {
            kind: string;
            title: string;
            body: string;
            scope?: string;
            tags?: string[];
            expires_at?: number;
          };
          return {
            content: await run(() => {
              const entry = save(getDb(), {
                scope: a.scope ?? defaultScope,
                kind: a.kind,
                title: a.title,
                body: a.body,
                tags: a.tags ?? [],
                expires_at: a.expires_at ?? null,
              });
              return `saved ${entry.id} (${entry.scope})`;
            }),
          };
        },
      });

      editor.add({
        name: "memory_search",
        description:
          "Search shared working memory (all sessions on this machine). Results include this project's scope and global entries.",
        input: {
          type: "object",
          properties: {
            query: { type: "string", description: "Free-text query" },
            scope: { type: "string", description: "Scope key; defaults to the project directory" },
            limit: { type: "number", description: "Max results (default 10)" },
          },
          required: ["query"],
          additionalProperties: false,
        },
        async execute(args) {
          const a = args as { query: string; scope?: string; limit?: number };
          return {
            content: await run(() => {
              const hits = search(getDb(), {
                query: a.query,
                scope: a.scope ?? defaultScope,
                ...(a.limit !== undefined ? { limit: a.limit } : {}),
              });
              if (hits.length === 0) {
                return "no matching memory entries";
              }
              return JSON.stringify(hits, null, 2);
            }),
          };
        },
      });

      editor.add({
        name: "memory_list",
        description:
          "List recent memory entries for a scope (default: the project directory), newest first.",
        input: {
          type: "object",
          properties: {
            scope: { type: "string", description: "Scope key; defaults to the project directory" },
            limit: { type: "number", description: "Max results (default 20)" },
          },
          additionalProperties: false,
        },
        async execute(args) {
          const a = args as { scope?: string; limit?: number };
          return {
            content: await run(() => {
              const entries = list(getDb(), {
                scope: a.scope ?? defaultScope,
                ...(a.limit !== undefined ? { limit: a.limit } : {}),
              });
              if (entries.length === 0) {
                return "no memory entries";
              }
              return JSON.stringify(entries, null, 2);
            }),
          };
        },
      });

      editor.add({
        name: "memory_forget",
        description: "Delete memory entries by id, or all entries matching a query.",
        input: {
          type: "object",
          properties: {
            id: { type: "string", description: "Entry id to delete" },
            query: { type: "string", description: "Delete every entry matching this query" },
          },
          additionalProperties: false,
        },
        async execute(args) {
          const a = args as { id?: string; query?: string };
          return {
            content: await run(() => {
              if (a.id !== undefined) {
                const deleted = forget(getDb(), { id: a.id });
                return `deleted ${deleted} entr${deleted === 1 ? "y" : "ies"}`;
              }
              if (a.query !== undefined) {
                const deleted = forget(getDb(), { query: a.query });
                return `deleted ${deleted} entr${deleted === 1 ? "y" : "ies"}`;
              }
              return "provide id or query";
            }),
          };
        },
      });
    });

    // experimental.chat.system.transform -> context hook (edit event.system)
    await ctx.session.hook("context", (event) => {
      event.system.push(textPart(SYSTEM_GUIDANCE));
    });

    // experimental.session.compacting -> compaction hook
    await ctx.session.hook("compaction", (event) => {
      event.system.push(textPart(COMPACTION_CONTEXT));
    });

    const cleanup = async () => {
      db?.close();
      db = null;
    };
    return cleanup;
  },
});

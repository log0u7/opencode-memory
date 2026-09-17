import type { Hooks, Plugin } from "@opencode-ai/plugin";

import { openMemoryDb, type MemoryDb } from "./lib/db.js";
import { forget, list, save, search, SecretDetectedError } from "./lib/store.js";
import { tool } from "@opencode-ai/plugin";

type PluginOptions = {
  dbPath?: string;
};

const SYSTEM_GUIDANCE = `You have persistent working memory shared with all OpenCode sessions on this machine.
At the start of a non-trivial task, run memory_search for relevant decisions and facts about this project.
When you make a durable decision or learn a lasting fact, call memory_save (kinds: decision, fact, preference, gotcha).
Never store credentials, tokens, or API keys in memory; the store refuses them.`;

const COMPACTION_CONTEXT =
  "The session is being compacted. After compaction, call memory_save for every durable decision still relevant " +
  "(kind=decision) and any newly learned facts (kind=fact), so other sessions keep this knowledge.";

function defaultDbPath(): string {
  const dataHome = process.env.XDG_DATA_HOME ?? `${process.env.HOME ?? ""}/.local/share`;
  return `${dataHome}/opencode-memory/memory.db`;
}

export const MemoryPlugin: Plugin = async (_input, options?: PluginOptions) => {
  let db: MemoryDb | null = null;

  const getDb = (): MemoryDb => {
    if (!db) {
      db = openMemoryDb(dbPath(options));
    }
    return db;
  };

  const hooks: Hooks = {
    tool: {
      memory_save: tool({
        description:
          "Save a durable entry to shared working memory (decisions, facts, preferences, gotchas). Never store credentials.",
        args: {
          kind: tool.schema
            .string()
            .describe("Entry type, e.g. decision, fact, preference, gotcha"),
          title: tool.schema.string().describe("Short title (max 120 chars)"),
          body: tool.schema.string().describe("Entry content (max 8000 chars)"),
          scope: tool.schema
            .string()
            .optional()
            .describe("Scope key; defaults to this session's worktree"),
          tags: tool.schema.array(tool.schema.string()).optional().describe("Optional tags"),
          expires_at: tool.schema.number().optional().describe("Optional epoch ms expiry"),
        },
        execute: (args, context) =>
          run(() => {
            const entry = save(getDb(), {
              scope: args.scope ?? context.worktree,
              kind: args.kind,
              title: args.title,
              body: args.body,
              tags: args.tags ?? [],
              expires_at: args.expires_at ?? null,
            });
            return `saved ${entry.id} (${entry.scope})`;
          }),
      }),

      memory_search: tool({
        description:
          "Search shared working memory (all sessions on this machine). Results include this project's scope and global entries.",
        args: {
          query: tool.schema.string().describe("Free-text query"),
          scope: tool.schema
            .string()
            .optional()
            .describe("Scope key; defaults to this session's worktree"),
          limit: tool.schema.number().optional().describe("Max results (default 10)"),
        },
        execute: (args, context) =>
          run(() => {
            const hits = search(getDb(), {
              query: args.query,
              scope: args.scope ?? context.worktree,
              ...(args.limit !== undefined ? { limit: args.limit } : {}),
            });
            if (hits.length === 0) {
              return "no matching memory entries";
            }
            return JSON.stringify(hits, null, 2);
          }),
      }),

      memory_list: tool({
        description:
          "List recent memory entries for a scope (default: this session's worktree), newest first.",
        args: {
          scope: tool.schema
            .string()
            .optional()
            .describe("Scope key; defaults to this session's worktree"),
          limit: tool.schema.number().optional().describe("Max results (default 20)"),
        },
        execute: (args, context) =>
          run(() => {
            const entries = list(getDb(), {
              scope: args.scope ?? context.worktree,
              ...(args.limit !== undefined ? { limit: args.limit } : {}),
            });
            if (entries.length === 0) {
              return "no memory entries";
            }
            return JSON.stringify(entries, null, 2);
          }),
      }),

      memory_forget: tool({
        description: "Delete memory entries by id, or all entries matching a query.",
        args: {
          id: tool.schema.string().optional().describe("Entry id to delete"),
          query: tool.schema.string().optional().describe("Delete every entry matching this query"),
        },
        execute: (args, _context) =>
          run(() => {
            if (args.id !== undefined) {
              const deleted = forget(getDb(), { id: args.id });
              return `deleted ${deleted} entr${deleted === 1 ? "y" : "ies"}`;
            }
            if (args.query !== undefined) {
              const deleted = forget(getDb(), { query: args.query });
              return `deleted ${deleted} entr${deleted === 1 ? "y" : "ies"}`;
            }
            return "provide id or query";
          }),
      }),
    },
  };

  return {
    ...hooks,
    "experimental.chat.system.transform": async (_input, output) => {
      output.system.push(SYSTEM_GUIDANCE);
    },
    "experimental.session.compacting": async (_input, output) => {
      output.context.push(COMPACTION_CONTEXT);
    },
    dispose: async () => {
      db?.close();
      db = null;
    },
  };
};

// Tool results are shown to the model: caught errors become readable text, so
// a rejected save is guidance instead of a crashed tool call.
async function run(fn: () => string): Promise<string> {
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

function dbPath(options: PluginOptions | undefined): string {
  if (typeof options?.dbPath === "string" && options.dbPath.length > 0) {
    return options.dbPath;
  }
  return defaultDbPath();
}

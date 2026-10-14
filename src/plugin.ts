import type { Hooks, Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";

import { openMemoryDb, type MemoryDb } from "./lib/db.js";
import {
  TOOL_DESCRIPTIONS,
  createMemoryOps,
  memoryInventory,
  oncePerSession,
} from "./lib/memory-ops.js";
import { canonicalScope } from "./lib/store.js";

export type PluginOptions = {
  dbPath?: string;
};

export const SYSTEM_GUIDANCE = `You have persistent working memory shared with all OpenCode sessions on this machine.
Recent entries are listed above when present; run memory_search for anything older or more specific.
When you make a durable decision or learn a lasting fact, call memory_save (kinds: decision, fact, preference, gotcha).
Never store credentials, tokens, or API keys in memory; the store refuses them.`;

export const COMPACTION_CONTEXT =
  "The session is being compacted. After compaction, call memory_save for every durable decision still relevant " +
  "(kind=decision) and any newly learned facts (kind=fact), so other sessions keep this knowledge.";

export function defaultDbPath(options?: PluginOptions): string {
  if (typeof options?.dbPath === "string" && options.dbPath.length > 0) {
    return options.dbPath;
  }
  const dataHome = process.env.XDG_DATA_HOME ?? `${process.env.HOME ?? ""}/.local/share`;
  return `${dataHome}/opencode-memory/memory.db`;
}

/**
 * Scope of a session: the v1 tool context carries a worktree, so that is the canonical
 * key. `directory` is the fallback so the same project does not get two scopes.
 */
export function defaultScope(worktree?: string, directory?: string): string {
  return canonicalScope(worktree, directory);
}

export const MemoryPlugin: Plugin = async (input, options?: PluginOptions) => {
  const dbPath = defaultDbPath(options);
  let db: MemoryDb | null = null;
  const getDb = (): MemoryDb => (db ??= openMemoryDb(dbPath));
  const ops = createMemoryOps(getDb);
  // Request and compaction hooks carry no directory: the instance scope is the project.
  const projectScope = defaultScope(input.worktree, input.directory);
  const injected = oncePerSession();

  const hooks: Hooks = {
    tool: {
      memory_save: tool({
        description: TOOL_DESCRIPTIONS.save,
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
        execute: async (args, context) =>
          ops.save(args, defaultScope(args.scope ?? context.worktree ?? context.directory)),
      }),

      memory_search: tool({
        description: TOOL_DESCRIPTIONS.search,
        args: {
          query: tool.schema.string().describe("Free-text query"),
          scope: tool.schema
            .string()
            .optional()
            .describe("Scope key; defaults to this session's worktree"),
          limit: tool.schema.number().optional().describe("Max results (default 10)"),
        },
        execute: async (args, context) =>
          ops.search(
            { query: args.query, ...(args.limit !== undefined ? { limit: args.limit } : {}) },
            defaultScope(args.scope ?? context.worktree ?? context.directory),
          ),
      }),

      memory_list: tool({
        description: TOOL_DESCRIPTIONS.list,
        args: {
          scope: tool.schema
            .string()
            .optional()
            .describe("Scope key; defaults to this session's worktree"),
          limit: tool.schema.number().optional().describe("Max results (default 20)"),
        },
        execute: async (args, context) =>
          ops.list(
            args.limit !== undefined ? { limit: args.limit } : {},
            defaultScope(args.scope ?? context.worktree ?? context.directory),
          ),
      }),

      memory_forget: tool({
        description: TOOL_DESCRIPTIONS.forget,
        args: {
          id: tool.schema.string().optional().describe("Entry id to delete"),
          query: tool.schema.string().optional().describe("Delete every entry matching a query"),
        },
        execute: async (args, context) =>
          ops.forget(args, defaultScope(context.worktree, context.directory)),
      }),
    },
  };

  return {
    ...hooks,
    "experimental.chat.system.transform": async (input, output) => {
      output.system.push(SYSTEM_GUIDANCE);
      const inventory = injected.inject(input.sessionID, () =>
        memoryInventory(getDb, dbPath, projectScope),
      );
      if (inventory !== null) {
        output.system.push(inventory);
      }
    },
    "experimental.session.compacting": async (_input, output) => {
      output.context.push(COMPACTION_CONTEXT);
      const inventory = memoryInventory(getDb, dbPath, projectScope);
      if (inventory !== null) {
        output.context.push(inventory);
      }
    },
    dispose: async () => {
      injected.reset();
      db?.close();
      db = null;
    },
  };
};

import { Plugin } from "@opencode/plugin";

import { openMemoryDb, type MemoryDb } from "./lib/db.js";
import {
  TOOL_DESCRIPTIONS,
  createMemoryOps,
  memoryInventory,
  oncePerSession,
} from "./lib/memory-ops.js";
import {
  SYSTEM_GUIDANCE,
  COMPACTION_CONTEXT,
  defaultScope,
  defaultDbPath,
  type PluginOptions,
} from "./plugin.js";

const textPart = (text: string) => ({ type: "text" as const, text });

export const MemoryV2 = Plugin.define({
  id: "@log0u7/opencode-memory",
  async setup(ctx) {
    const options = ctx.options as PluginOptions;
    const dbPath = defaultDbPath(options);
    let db: MemoryDb | null = null;
    const getDb = (): MemoryDb => (db ??= openMemoryDb(dbPath));
    const ops = createMemoryOps(getDb);

    // Request and compaction hooks carry no directory: the instance scope is the project.
    const projectScope = defaultScope(undefined, ctx.location.directory);
    const injected = oncePerSession();

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "memory_save",
        description: TOOL_DESCRIPTIONS.save,
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
            content: ops.save(a, defaultScope(undefined, a.scope ?? ctx.location.directory)),
          };
        },
      });

      editor.add({
        name: "memory_search",
        description: TOOL_DESCRIPTIONS.search,
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
            content: ops.search(
              { query: a.query, ...(a.limit !== undefined ? { limit: a.limit } : {}) },
              defaultScope(undefined, a.scope ?? ctx.location.directory),
            ),
          };
        },
      });

      editor.add({
        name: "memory_list",
        description: TOOL_DESCRIPTIONS.list,
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
            content: ops.list(
              a.limit !== undefined ? { limit: a.limit } : {},
              defaultScope(undefined, a.scope ?? ctx.location.directory),
            ),
          };
        },
      });

      editor.add({
        name: "memory_forget",
        description: TOOL_DESCRIPTIONS.forget,
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
          return { content: ops.forget(a, defaultScope(undefined, ctx.location.directory)) };
        },
      });
    });

    // The v1 system transform maps to the v2 context hook: guidance first, then the
    // once-per-session inventory.
    await ctx.session.hook("context", (event) => {
      event.system.push(textPart(SYSTEM_GUIDANCE));
      const inventory = injected.inject(event.sessionID, () =>
        memoryInventory(getDb, dbPath, projectScope),
      );
      if (inventory !== null) {
        event.system.push(textPart(inventory));
      }
    });

    // experimental.session.compacting -> compaction hook
    await ctx.session.hook("compaction", (event) => {
      event.system.push(textPart(COMPACTION_CONTEXT));
      const inventory = memoryInventory(getDb, dbPath, projectScope);
      if (inventory !== null) {
        event.system.push(textPart(inventory));
      }
    });

    const cleanup = async () => {
      injected.reset();
      db?.close();
      db = null;
    };
    return cleanup;
  },
});

import { Plugin } from "@opencode/plugin";

import { openMemoryDb, type MemoryDb } from "./lib/db.js";
import {
  TOOL_DESCRIPTIONS,
  createMemoryOps,
  memoryInventory,
  oncePerSession,
} from "./lib/memory-ops.js";
import { createReflection, parseReflectionConfig } from "./lib/reflection.js";
import {
  SYSTEM_GUIDANCE,
  COMPACTION_CONTEXT,
  defaultScope,
  defaultDbPath,
  type PluginOptions,
} from "./plugin.js";

const textPart = (text: string) => ({ type: "text" as const, text });

/** Session tail as plain text: user messages verbatim, assistant text parts joined. */
async function transcriptV2(ctx: Plugin.Context, sessionID: string): Promise<string> {
  const messages = await ctx.session.context({ sessionID });
  const lines: string[] = [];
  for (const message of messages) {
    if (message.type === "user") {
      lines.push(`user: ${message.text}`);
    } else if (message.type === "assistant") {
      const text = message.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join(" ")
        .trim();
      if (text) {
        lines.push(`assistant: ${text}`);
      }
    }
  }
  return lines.join("\n");
}

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
              description: "Entry type, e.g. decision, fact, preference, gotcha, lesson",
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

    const reflection = parseReflectionConfig(options.reflection);
    if (!reflection) {
      return cleanup;
    }
    const onIdle = createReflection(reflection, {
      isSubagent: async (sessionID) => {
        const session = await ctx.session.get({ sessionID });
        return !!session.parentID;
      },
      transcript: (sessionID) => transcriptV2(ctx, sessionID),
      generate: async (prompt) => {
        const model = modelRefV2(reflection.model);
        const result = await ctx.generate.text({ prompt, ...(model ? { model } : {}) });
        return result.text;
      },
      saveLesson: (title, body) => {
        ops.save({ kind: "lesson", title, body }, projectScope);
      },
    });
    // The host keeps the event stream alive through this controller; aborting it stops
    // the idle loop without touching the tool or session hooks.
    const controller = new AbortController();
    void (async () => {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        if (event.type === "session.idle") {
          onIdle(event.data.sessionID);
        }
      }
    })().catch(() => {});
    return async () => {
      controller.abort();
      await cleanup();
    };
  },
});

function modelRefV2(model?: string | undefined): { providerID: string; id: string } | undefined {
  if (!model) {
    return undefined;
  }
  const [providerID, id] = model.split("/", 2);
  return providerID && id ? { providerID, id } : undefined;
}

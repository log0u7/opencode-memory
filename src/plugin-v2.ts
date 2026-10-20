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

/** Reconnect backoff for the v2 event stream: short first retry, capped growth. */
const RECONNECT_MIN_MS = 250;
const RECONNECT_MAX_MS = 5000;

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
    let disposed = false;
    // After cleanup the store is closed for good: a late path (tool call, in-flight
    // reflection) must not silently reopen a connection that nobody closes again.
    const getDb = (): MemoryDb => {
      if (disposed) {
        throw new Error("memory store is closed");
      }
      db ??= openMemoryDb(dbPath);
      return db;
    };
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
        async execute(args, context) {
          const a = args as {
            kind: string;
            title: string;
            body: string;
            scope?: string;
            tags?: string[];
            expires_at?: number;
          };
          return {
            content: ops.save(
              a,
              defaultScope(undefined, a.scope ?? ctx.location.directory),
              context.agent,
            ),
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

      editor.add({
        name: "memory_stats",
        description: TOOL_DESCRIPTIONS.stats,
        input: {
          type: "object",
          properties: {
            scope: { type: "string", description: "Scope key; defaults to the project directory" },
          },
          additionalProperties: false,
        },
        async execute(args) {
          const a = args as { scope?: string };
          return { content: ops.stats(defaultScope(undefined, a.scope ?? ctx.location.directory)) };
        },
      });
    });

    // The v1 system transform maps to the v2 context hook: guidance first, then the
    // once-per-session inventory.
    await ctx.session.hook("context", (event) => {
      event.system.push(textPart(SYSTEM_GUIDANCE));
      if (disposed) {
        return;
      }
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
      if (disposed) {
        return;
      }
      const inventory = memoryInventory(getDb, dbPath, projectScope);
      if (inventory !== null) {
        event.system.push(textPart(inventory));
      }
    });

    const cleanup = async () => {
      disposed = true;
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
      generate: async (prompt, _sessionID, signal) => {
        const model = modelRefV2(reflection.model);
        const result = await ctx.generate.text({ prompt, ...(model ? { model } : {}) }, { signal });
        return result.text;
      },
      saveLesson: (title, body) => {
        ops.save({ kind: "lesson", title, body }, projectScope, "reflection");
      },
    });
    // The host keeps the event stream alive through this controller; aborting it stops
    // the idle loop without touching the tool or session hooks. A stream that errors is
    // retried with a capped backoff instead of ending the loop for good.
    const controller = new AbortController();
    void (async () => {
      let delay = RECONNECT_MIN_MS;
      while (!controller.signal.aborted) {
        let failed = false;
        try {
          for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
            if (event.type === "session.idle") {
              onIdle(event.data.sessionID);
            }
          }
        } catch {
          failed = true;
        }
        if (!failed || controller.signal.aborted) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay = Math.min(delay * 2, RECONNECT_MAX_MS);
      }
    })();
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

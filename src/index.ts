/**
 * OpenCode Memory Plugin
 *
 * Shared working memory for all OpenCode sessions on a machine.
 *
 * @packageDocumentation
 */

import { MemoryV2 } from "./plugin-v2.js";

type V1Plugin = typeof import("./plugin.js").MemoryPlugin;

/**
 * Dual entrypoint: v1 hosts call `server()`, v2 hosts call `setup()`
 * (see https://opencode.ai/v2/docs/build/plugins/migrate-v1).
 *
 * The v1 implementation imports `@opencode-ai/plugin`, which only v1 hosts
 * resolve. It must stay out of the static import graph or v2 hosts reject the
 * whole package at load time, so `server()` loads it lazily; a v2 host never
 * calls `server()` and therefore never resolves it.
 */
export const pluginModule = {
  ...MemoryV2,
  async server(...args: Parameters<V1Plugin>): Promise<Awaited<ReturnType<V1Plugin>>> {
    const { MemoryPlugin } = await import("./plugin.js");
    return MemoryPlugin(...args);
  },
} satisfies { id: string; server: V1Plugin; setup: (typeof MemoryV2)["setup"] };

export default pluginModule;

export type { Entry, EntryInput, EntryKind } from "./types/entry.js";

export type { MemoryPlugin } from "./plugin.js";

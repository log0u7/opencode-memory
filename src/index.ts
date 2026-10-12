/**
 * OpenCode Memory Plugin
 *
 * Shared working memory for all OpenCode sessions on a machine.
 *
 * @packageDocumentation
 */

import { MemoryV2 } from "./plugin-v2.js";
import { MemoryPlugin } from "./plugin.js";

/**
 * Dual entrypoint: v1 hosts call `server()`, v2 hosts call `setup()`
 * (see https://opencode.ai/v2/docs/build/plugins/migrate-v1).
 */
export const pluginModule = {
  ...MemoryV2,
  server: MemoryPlugin,
} satisfies { id: string; server: typeof MemoryPlugin; setup: (typeof MemoryV2)["setup"] };

export default pluginModule;

export type { Entry, EntryInput, EntryKind } from "./types/entry.js";

export { MemoryPlugin } from "./plugin.js";

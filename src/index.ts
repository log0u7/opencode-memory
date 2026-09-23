/**
 * OpenCode Memory Plugin
 *
 * Shared working memory for all OpenCode sessions on a machine.
 *
 * @packageDocumentation
 */

import { MemoryPlugin } from "./plugin.js";

const pluginModule = {
  id: "@log0u7/opencode-memory",
  server: MemoryPlugin,
} satisfies { id: string; server: typeof MemoryPlugin };

export default pluginModule;

export type { Entry, EntryInput, EntryKind } from "./types/entry.js";

export { MemoryPlugin } from "./plugin.js";

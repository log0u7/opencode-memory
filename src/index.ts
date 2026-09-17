/**
 * OpenCode Memory Plugin
 *
 * Shared working memory for all OpenCode sessions on a machine.
 *
 * @packageDocumentation
 */

import { MemoryPlugin } from "./plugin.js";

type V1PluginModule = {
  id: string;
  server: typeof MemoryPlugin;
};

const pluginModule = {
  id: "@log0u7/opencode-memory",
  server: MemoryPlugin,
} satisfies V1PluginModule;

export default pluginModule;

export type { Entry, EntryInput, EntryKind } from "./types/entry.js";

export { MemoryPlugin } from "./plugin.js";

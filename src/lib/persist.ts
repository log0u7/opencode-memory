// Workaround for anomalyco/opencode#62634: the host composes TUI storage keys
// as `plugin.<id>.<key>` and its segment() validation rejects scoped npm ids,
// so TUI-side storage.store() throws for any @scope/name plugin. Until the
// host fix (PR #62638) ships, the setup side persists durable state itself
// through the raw storage domain, under a key whose id segment is escaped
// injectively (every distinct id maps to a distinct segment, so no collision).

const SAFE = /^[a-zA-Z0-9._-]+$/;
const SAFE_CHAR = /^[a-zA-Z0-9._-]$/;

export function escapeSegment(id: string): string {
  if (SAFE.test(id)) {
    return id;
  }
  let out = "";
  for (const ch of id) {
    if (SAFE_CHAR.test(ch)) {
      out += ch;
    } else if (ch === "_") {
      out += "__";
    } else {
      for (const unit of ch) {
        out += `_${unit.codePointAt(0)!.toString(16).padStart(4, "0")}`;
      }
    }
  }
  return out;
}

export type RawStorage = {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
};

export type DurableStore = {
  /** The composed, host-safe storage key (exposed for tests). */
  key(): string;
  load<T>(): Promise<T | null>;
  save<T>(value: T): Promise<void>;
};

export function createDurableStore(raw: RawStorage, pluginId: string, name: string): DurableStore {
  const fullKey = `plugin.${escapeSegment(pluginId)}.${name}`;
  return {
    key: () => fullKey,
    async load<T>(): Promise<T | null> {
      try {
        const value = await raw.get(fullKey);
        return (value as T | undefined | null) ?? null;
      } catch {
        // Unreadable host storage: behave like an empty store.
        return null;
      }
    },
    async save<T>(value: T): Promise<void> {
      await raw.set(fullKey, value);
    },
  };
}

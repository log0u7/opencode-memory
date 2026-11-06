import { Rpc } from "@opencode/plugin/rpc";

// The TUI footer reads one compact snapshot per tick over RPC. The pure helpers
// (snapshotFromStats, formatMemoryLine) are testable without a renderer; the
// definition itself carries the wire schema.

export type MemorySnapshot = {
  /** Live entries in the caller's scope plus `global`, expired excluded. */
  total: number;
  /** Store file size on disk, bytes. */
  store_bytes: number;
  /** Top kinds as pre-rendered "kind: count" strings, count descending, max 3. */
  top_kinds: string[];
};

export function snapshotFromStats(
  counts: ReadonlyArray<{ kind: string; count: number }>,
  storeBytes: number,
): MemorySnapshot {
  return {
    total: counts.reduce((sum, row) => sum + row.count, 0),
    store_bytes: storeBytes,
    top_kinds: counts.slice(0, 3).map((row) => `${row.kind}: ${row.count}`),
  };
}

/** One footer line: "memory: 23 entries · 1.1 MB · decision: 12, fact: 8". Null for
 * an empty store, so the slot stays hidden instead of advertising nothing. */
export function formatMemoryLine(s: MemorySnapshot): string | null {
  if (s.total === 0) {
    return null;
  }
  const size =
    s.store_bytes >= 1_048_576
      ? `${(s.store_bytes / 1_048_576).toFixed(1)} MB`
      : `${Math.max(1, Math.round(s.store_bytes / 1024))} kB`;
  const kinds = s.top_kinds.length > 0 ? ` · ${s.top_kinds.join(", ")}` : "";
  return `memory: ${s.total} entries · ${size}${kinds}`;
}

export const MemoryRpc = Rpc.define({
  id: "memory",
  methods: {
    snapshot: {
      input: { type: "object", properties: {}, additionalProperties: false },
      output: {
        type: "object",
        properties: {
          total: { type: "number", description: "Live entries in scope plus global" },
          store_bytes: { type: "number", description: "Store file size on disk" },
          top_kinds: {
            type: "array",
            items: { type: "string" },
            description: "Top kinds as 'kind: count', count descending, max 3",
          },
        },
        required: ["total", "store_bytes", "top_kinds"],
        additionalProperties: false,
      },
    },
  },
  events: {},
});

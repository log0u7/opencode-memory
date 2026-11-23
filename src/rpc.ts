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
  /** Full kind breakdown, same format, every kind (superset of top_kinds). */
  all_kinds: string[];
};

export function snapshotFromStats(
  counts: ReadonlyArray<{ kind: string; count: number }>,
  storeBytes: number,
): MemorySnapshot {
  return {
    total: counts.reduce((sum, row) => sum + row.count, 0),
    store_bytes: storeBytes,
    top_kinds: counts.slice(0, 3).map((row) => `${row.kind}: ${row.count}`),
    all_kinds: counts.map((row) => `${row.kind}: ${row.count}`),
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

/** Dialog lines: the header (entries + size) then one line per kind. */
export function formatMemoryDialog(s: MemorySnapshot): string[] {
  const size =
    s.store_bytes >= 1_048_576
      ? `${(s.store_bytes / 1_048_576).toFixed(1)} MB`
      : `${Math.max(1, Math.round(s.store_bytes / 1024))} kB`;
  return [`memory: ${s.total} entries · ${size}`, ...s.all_kinds];
}

export type MemorySidebarSnapshot = {
  /** False when the store file does not exist yet: the sidebar falls back to a
   * single "Memory (no store)" line. */
  store: boolean;
  /** Usable entries machine-wide: current, not trashed, not expired. */
  live: number;
  /** Rows in the trash (recoverable through memory_restore for 30 days). */
  trashed: number;
  /** Full kind breakdown machine-wide, count descending. */
  kinds: Array<{ kind: string; count: number }>;
  /** Entries at or above the heat threshold: the priority signal. */
  hot: number;
  /** Anchored entries of the asking scope whose files moved since their commit. */
  stale: number;
  /** Endorsed entries machine-wide: the content side of cross-host sync, and
   * what the next outbox push would carry. */
  shareable: number;
  /** Live entries in the asking scope plus `global`. */
  scope: number;
  /** Epoch ms of the last housekeeping sweep, or null when none ran yet. */
  last_sweep_ms: number | null;
  /** Entries the last sweep cooled. In-memory per process: 0 after a restart
   * until the next sweep runs. */
  cooled: number;
  /** Peer JSONL files waiting in the mesh inbox (pending import). */
  sync_incoming: number;
  /** Whether the mesh data dir exists: the transport side of sync. */
  mesh_installed: boolean;
};

/** Zeroed snapshot for "no store yet" (and for a disposed plugin): the sidebar
 * renders the one-line fallback instead of inventing counts. */
export function noStoreSidebar(): MemorySidebarSnapshot {
  return {
    store: false,
    live: 0,
    trashed: 0,
    kinds: [],
    hot: 0,
    stale: 0,
    shareable: 0,
    scope: 0,
    last_sweep_ms: null,
    cooled: 0,
    sync_incoming: 0,
    mesh_installed: false,
  };
}

/** Human age for the sweep line: seconds under a minute, then minutes, hours, days. */
export function formatAgeHuman(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function plural(kind: string, count: number): string {
  return count === 1 ? kind : `${kind}s`;
}

/**
 * Sidebar lines for one snapshot. Line 0 is the clickable header the component
 * renders bold; the rest are muted body lines. Collapsed: the header plus one
 * muted counts line (stale segment dropped when 0). Expanded: the machine-wide
 * breakdown. No store: the single fallback line whatever the mode.
 */
export function formatMemorySidebar(
  s: MemorySidebarSnapshot,
  collapsed: boolean,
  now: number = Date.now(),
): string[] {
  if (!s.store) {
    return ["Memory (no store)"];
  }
  if (collapsed) {
    const header = s.hot > 0 ? `▶ Memory ● ${s.hot} hot` : "▶ Memory";
    const parts = [`${s.live} entries`];
    if (s.stale > 0) {
      parts.push(`${s.stale} stale`);
    }
    parts.push(`${s.shareable} to share`);
    return [header, parts.join(" · ")];
  }
  const lines = [
    "▼ Memory (machine-wide)",
    `${s.live} live · ${s.trashed} trashed · ${s.scope} in scope`,
  ];
  const kinds = s.kinds
    .filter((row) => row.count > 0)
    .map((row) => `${plural(row.kind, row.count)} ${row.count}`);
  if (kinds.length > 0) {
    lines.push(kinds.join(" · "));
  }
  if (s.last_sweep_ms !== null) {
    const age = formatAgeHuman(Math.max(0, now - s.last_sweep_ms));
    lines.push(`last sweep: ${age} · ${s.cooled} cooled · ${s.stale} stale`);
  }
  if (s.mesh_installed) {
    lines.push(`sync: ${s.sync_incoming} incoming · ${s.shareable} outgoing`);
  }
  return lines;
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
          all_kinds: {
            type: "array",
            items: { type: "string" },
            description: "Full kind breakdown as 'kind: count', count descending",
          },
        },
        required: ["total", "store_bytes", "top_kinds", "all_kinds"],
        additionalProperties: false,
      },
    },
    // The sidebar's aggregated snapshot: one compact read per tick, built by
    // buildSidebarSnapshot in lib/tui-snapshot.ts.
    sidebar: {
      input: { type: "object", properties: {}, additionalProperties: false },
      output: {
        type: "object",
        properties: {
          store: { type: "boolean", description: "False when the store file does not exist yet" },
          live: { type: "number", description: "Usable entries machine-wide" },
          trashed: { type: "number", description: "Rows in the trash" },
          kinds: {
            type: "array",
            items: {
              type: "object",
              properties: { kind: { type: "string" }, count: { type: "number" } },
              required: ["kind", "count"],
              additionalProperties: false,
            },
            description: "Kind breakdown machine-wide, count descending",
          },
          hot: { type: "number", description: "Entries at or above the heat threshold" },
          stale: {
            type: "number",
            description: "Anchored entries whose files moved since their commit (asking scope)",
          },
          shareable: { type: "number", description: "Endorsed entries machine-wide" },
          scope: { type: "number", description: "Live entries in the asking scope plus global" },
          last_sweep_ms: {
            type: ["number", "null"],
            description: "Epoch ms of the last housekeeping sweep",
          },
          cooled: {
            type: "number",
            description: "Entries cooled by the last sweep this process ran",
          },
          sync_incoming: {
            type: "number",
            description: "Peer JSONL files waiting in the mesh inbox",
          },
          mesh_installed: { type: "boolean", description: "Whether the mesh data dir exists" },
        },
        required: [
          "store",
          "live",
          "trashed",
          "kinds",
          "hot",
          "stale",
          "shareable",
          "scope",
          "last_sweep_ms",
          "cooled",
          "sync_incoming",
          "mesh_installed",
        ],
        additionalProperties: false,
      },
    },
    // Sidebar collapse state, persisted by the setup side through the raw
    // storage domain: the TUI-side storage.store() throws for scoped plugin
    // ids (anomalyco/opencode#62634).
    sidebar_state: {
      input: { type: "object", properties: {}, additionalProperties: false },
      output: {
        type: "object",
        properties: {
          collapsed: { type: "boolean", description: "Sidebar collapsed state" },
        },
        required: ["collapsed"],
        additionalProperties: false,
      },
    },
    set_sidebar_state: {
      input: {
        type: "object",
        properties: {
          collapsed: { type: "boolean", description: "Sidebar collapsed state" },
        },
        required: ["collapsed"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          collapsed: { type: "boolean", description: "Sidebar collapsed state" },
        },
        required: ["collapsed"],
        additionalProperties: false,
      },
    },
  },
  events: {},
});

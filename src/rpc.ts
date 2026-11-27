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

/** Human store size parts: one decimal in MB from 1 MiB up, whole kB below.
 * Returned as [value, unit] so callers can tone the number and the label apart. */
export function storeSizeParts(bytes: number): [value: string, unit: string] {
  return bytes >= 1_048_576
    ? [(bytes / 1_048_576).toFixed(1), "MB"]
    : [`${Math.max(1, Math.round(bytes / 1024))}`, "kB"];
}

/** One footer line as tone segments — count in qualifier, labels and the
 * separator in value: "742 Records · 3.3 MB" ("1 Record" singular). Null for
 * an empty store, so the slot stays hidden instead of advertising nothing. The
 * kind breakdown lives in the sidebar and memory_stats — the footer stays one
 * compact fact. The host already labels the slot "Memory", so the line carries
 * no prefix. */
export function formatMemoryLine(s: MemorySnapshot): SidebarSegment[] | null {
  if (s.total === 0) {
    return null;
  }
  const [sizeNum, sizeUnit] = storeSizeParts(s.store_bytes);
  return [
    { text: `${s.total}`, tone: "qualifier" },
    { text: s.total === 1 ? " Record" : " Records", tone: "value" },
    { text: " · ", tone: "value" },
    { text: sizeNum, tone: "qualifier" },
    { text: ` ${sizeUnit}`, tone: "value" },
  ];
}

export type MemorySidebarSnapshot = {
  /** False when the store file does not exist yet: the sidebar falls back to a
   * single "Memory (no store)" line. */
  store: boolean;
  /** The SQLite file size in bytes: the collapsed header shows it compactly. */
  store_bytes: number;
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
    store_bytes: 0,
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

/** Tone tiers of the quota-style sidebar grammar, mapped to the theme in
 * tui.tsx: entity = text + bold, qualifier = text, value = textMuted, alert =
 * the theme's warning/error color (text when it exposes none). */
export type SidebarTone = "entity" | "qualifier" | "value" | "alert";

export type SidebarSegment = { text: string; tone: SidebarTone };

/** Kinds packed per expanded line before the overflow spills onto a new one. */

/** Word-boundary truncation (the mesh panel's rule): cut at the last space
 * that fits the budget, never mid-word; a single word longer than the whole
 * budget has no boundary to cut at: hard cut. */
function truncateAtWord(text: string, budget: number): string {
  if (text.length <= budget) return text;
  // The ellipsis rides INSIDE the budget: a hard cut at the full budget would
  // render budget+1 chars and clip the marker itself.
  const cut = text.slice(0, Math.max(1, budget - 1));
  const space = cut.lastIndexOf(" ");
  return (space > 0 ? cut.slice(0, space) : cut) + "…";
}

/** One kind row as segments: the count in qualifier, the label in value. */
function kindSegments(row: { kind: string; count: number }): SidebarSegment[] {
  return [
    { text: `${row.count}`, tone: "qualifier" },
    { text: ` ${plural(row.kind, row.count)}`, tone: "value" },
  ];
}

const kindMark: SidebarSegment = { text: "  ≡  ", tone: "qualifier" };
const kindSeparator: SidebarSegment = { text: " · ", tone: "value" };

/** Rendered length of a segment line (the width budget applies to it). */
function lineLength(line: SidebarSegment[]): number {
  return line.reduce((sum, seg) => sum + seg.text.length, 0);
}

/** Kinds packed per expanded line before the overflow spills onto a new one.
 * The panel must not overflow (0.26.0): a packed pair that exceeds the width
 * budget drops to one kind per line, and a label that still overflows truncates
 * at the last word boundary (the `300 fa · 1 les` incident stays dead). */
function kindLines(
  kinds: Array<{ kind: string; count: number }>,
  width: number,
): SidebarSegment[][] {
  const pack = (rows: Array<{ kind: string; count: number }>): SidebarSegment[] => [
    kindMark,
    ...rows.flatMap((row, j) => {
      const segs = kindSegments(row);
      return j > 0 ? [kindSeparator, ...segs] : segs;
    }),
  ];
  // Pass 1: pack pairs, split to singles when the pair overflows.
  const chunks: Array<Array<{ kind: string; count: number }>> = [];
  for (let i = 0; i < kinds.length; i += 2) {
    const pair = kinds.slice(i, i + 2);
    if (pair.length === 2 && lineLength(pack(pair)) > width) {
      chunks.push(pair.slice(0, 1), pair.slice(1, 2));
    } else {
      chunks.push(pair);
    }
  }
  // Pass 2: every line fits the budget — a label that still overflows
  // truncates at the last word boundary (never mid-word, the separator and
  // the counts are fixed and short).
  return chunks.map((chunk) => {
    const line = pack(chunk);
    if (lineLength(line) <= width) return line;
    return line.map((seg) => {
      const isLabel = seg !== kindSeparator && seg.tone === "value" && seg.text.startsWith(" ");
      if (!isLabel) return seg;
      const budget = Math.max(1, width - lineLength(line) + seg.text.length);
      return { ...seg, text: truncateAtWord(seg.text, budget) };
    });
  });
}

/**
 * Expanded sidebar (v4, quota-style): segment lines, tone per segment. Line 0
 * is the clickable bold header carrying the store size (the mesh `Mesh: <id>`
 * pattern, 0.26.0) — the dedicated size line is gone (the duplicate). No blank
 * lines: an inapplicable line is omitted entirely (hot at 0, sweep without
 * metadata, sync without mesh).
 */
export function formatMemorySidebarExpanded(
  s: MemorySidebarSnapshot,
  now: number = Date.now(),
  opts?: { width?: number },
): SidebarSegment[][] {
  const width = opts?.width ?? 32;
  const header: SidebarSegment[] = [{ text: "▼ Memory", tone: "entity" }];
  if (s.store_bytes > 0) {
    const [sizeNum, sizeUnit] = storeSizeParts(s.store_bytes);
    header.push(
      { text: ": ", tone: "value" },
      { text: sizeNum, tone: "qualifier" },
      { text: ` ${sizeUnit}`, tone: "value" },
    );
  }
  const lines: SidebarSegment[][] = [header];
  if (s.hot > 0) {
    const line: SidebarSegment[] = [
      { text: "  ●  ", tone: "alert" },
      { text: `${s.hot} ${plural("hot", s.hot)}`, tone: "qualifier" },
    ];
    if (s.last_sweep_ms !== null) {
      const age = formatAgeHuman(Math.max(0, now - s.last_sweep_ms));
      line.push(
        { text: " · sweep ", tone: "value" },
        { text: age, tone: "qualifier" },
        { text: " ago", tone: "value" },
      );
    }
    lines.push(line);
  }
  lines.push([
    { text: "  ▤  ", tone: "qualifier" },
    { text: `${s.live}`, tone: "qualifier" },
    { text: " live", tone: "value" },
    { text: " · ", tone: "value" },
    { text: `${s.trashed}`, tone: "qualifier" },
    { text: " trashed", tone: "value" },
  ]);
  const kinds = s.kinds.filter((row) => row.count > 0);
  lines.push(...kindLines(kinds, width));
  if (s.mesh_installed) {
    lines.push([
      { text: "  ⇄  ", tone: "qualifier" },
      { text: "sync in ", tone: "value" },
      { text: `${s.sync_incoming}`, tone: "qualifier" },
      { text: " · out ", tone: "value" },
      { text: `${s.shareable}`, tone: "qualifier" },
    ]);
  }
  return lines;
}

/**
 * Collapsed sidebar: the unified panel grammar (2026-11-25, shared with the
 * mesh panel): `▶ <Entity> ·<n> <Label>[s] ·...` — compact separators (the
 * space rides before the dot), capitalized labels with the count-appropriate
 * plural, no glyphs in fold (the labels carry the signals; "Rec" never
 * pluralizes — the abbreviation rule). The title carries the state toggle
 * (`▶` against the expanded `▼`) and is the only bold (entity) segment; the
 * whole line is the clickable header. "Memory (no store)" for an empty
 * store, so the slot stays hidden instead of advertising nothing.
 */
export function formatMemorySidebarCollapsed(s: MemorySidebarSnapshot): SidebarSegment[][] {
  if (!s.store) {
    return [[{ text: "Memory (no store)", tone: "entity" }]];
  }
  const [sizeNum, sizeUnit] = storeSizeParts(s.store_bytes);
  const line: SidebarSegment[] = [
    { text: "▶ Memory", tone: "entity" },
    { text: " ·", tone: "value" },
    { text: `${s.live}`, tone: "qualifier" },
    { text: " Rec", tone: "value" },
    { text: " ·", tone: "value" },
    { text: sizeNum, tone: "qualifier" },
    { text: ` ${sizeUnit}`, tone: "value" },
  ];
  if (s.hot > 0) {
    line.push(
      { text: " ·", tone: "value" },
      { text: `${s.hot}`, tone: "qualifier" },
      { text: ` ${plural("Hot", s.hot)}`, tone: "value" },
    );
  }
  return [line];
}

/** The rich /memory status dialog (0.26.0): one labeled section per line, the
 * same tone grammar as the sidebar (labels and separators in value, numbers in
 * qualifier, nothing bold: the dialog header carries the bold title). No blank
 * lines: an inapplicable line is omitted (sync without mesh, kinds at zero
 * render as "(none)"). */
export function formatMemoryStatusDialog(
  s: MemorySidebarSnapshot,
  now: number = Date.now(),
): SidebarSegment[][] {
  const line = (label: string, segs: SidebarSegment[]): SidebarSegment[] => [
    { text: `${label} `, tone: "value" },
    ...segs,
  ];
  const lines: SidebarSegment[][] = [];
  const [sizeNum, sizeUnit] = storeSizeParts(s.store_bytes);
  lines.push(
    line("Store", [
      { text: sizeNum, tone: "qualifier" },
      { text: ` ${sizeUnit}`, tone: "value" },
      { text: " · ", tone: "value" },
      { text: `${s.scope}`, tone: "qualifier" },
      { text: " records in scope", tone: "value" },
    ]),
  );
  lines.push(
    line("Live", [
      { text: `${s.live}`, tone: "qualifier" },
      { text: " live", tone: "value" },
      { text: " · ", tone: "value" },
      { text: `${s.trashed}`, tone: "qualifier" },
      { text: " trashed", tone: "value" },
    ]),
  );
  const heat: SidebarSegment[] = [
    { text: `${s.hot}`, tone: "qualifier" },
    { text: ` ${plural("hot", s.hot)}`, tone: "value" },
    { text: " · ", tone: "value" },
    { text: `${s.stale}`, tone: "qualifier" },
    { text: ` stale ${plural("anchor", s.stale)}`, tone: "value" },
  ];
  lines.push(line("Heat", heat));
  const sweepAge =
    s.last_sweep_ms === null ? "never" : formatAgeHuman(Math.max(0, now - s.last_sweep_ms));
  const sweepTail: SidebarSegment[] =
    s.last_sweep_ms === null
      ? []
      : [
          { text: " ago", tone: "value" },
          { text: " · ", tone: "value" },
          { text: `${s.cooled}`, tone: "qualifier" },
          { text: " cooled", tone: "value" },
        ];
  lines.push(line("Sweep", [{ text: sweepAge, tone: "qualifier" }, ...sweepTail]));
  if (s.mesh_installed) {
    lines.push(
      line("Sync", [
        { text: "in ", tone: "value" },
        { text: `${s.sync_incoming}`, tone: "qualifier" },
        { text: " · out ", tone: "value" },
        { text: `${s.shareable}`, tone: "qualifier" },
        { text: " shareable", tone: "value" },
      ]),
    );
  }
  const kinds = s.kinds.filter((row) => row.count > 0);
  const kindSegs: SidebarSegment[] = [];
  if (kinds.length === 0) {
    kindSegs.push({ text: "(none)", tone: "value" });
  } else {
    kinds.forEach((row, i) => {
      if (i > 0) {
        kindSegs.push({ text: " · ", tone: "value" });
      }
      kindSegs.push(
        { text: `${row.count}`, tone: "qualifier" },
        { text: ` ${plural(row.kind, row.count)}`, tone: "value" },
      );
    });
  }
  lines.push(line("Kinds", kindSegs));
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
          store_bytes: { type: "number", description: "Store file size on disk" },
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
          "store_bytes",
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
    // The /memory stats view (0.26.0): scopes machine-wide, the most recently
    // updated entries, the store totals.
    stats: {
      input: { type: "object", properties: {}, additionalProperties: false },
      output: {
        type: "object",
        properties: {
          total: { type: "number", description: "Live entries machine-wide" },
          store_bytes: { type: "number", description: "Store file size on disk" },
          scopes: {
            type: "array",
            items: {
              type: "object",
              properties: { scope: { type: "string" }, count: { type: "number" } },
              required: ["scope", "count"],
              additionalProperties: false,
            },
            description: "Live entries per scope, count descending",
          },
          top: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                kind: { type: "string" },
                title: { type: "string" },
              },
              required: ["id", "kind", "title"],
              additionalProperties: false,
            },
            description: "Most recently updated live entries, max 3",
          },
        },
        required: ["total", "store_bytes", "scopes", "top"],
        additionalProperties: false,
      },
    },
    // The /memory continue bridge (0.26.0): the transform command is gone, the
    // TUI dispatches here. Same behavior: export the transcript if needed and
    // inject the retrieval pointer into the asking session.
    continue: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string", description: "The session the pointer lands in" },
          target: { type: "string", description: "The session id to continue" },
        },
        required: ["sessionID", "target"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          ok: { type: "boolean", description: "Whether the pointer was injected" },
          message: { type: "string", description: "Human report for the toast" },
        },
        required: ["ok", "message"],
        additionalProperties: false,
      },
    },
    // The /memory cleanup bridge (0.26.0): the retention sweep of exported
    // transcripts, dry run unless apply.
    cleanup: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string", description: "Session to report into (prompt injection)" },
          apply: { type: "boolean", description: "Delete the eligible files instead of reporting" },
        },
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          report: { type: "string", description: "The sweep report (human text)" },
        },
        required: ["report"],
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

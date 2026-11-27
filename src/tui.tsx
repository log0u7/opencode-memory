/** @jsxImportSource @opentui/solid */

import { Plugin } from "@opencode/plugin/tui";
import type { JSX } from "@opentui/solid";
import { For, Show, createSignal, untrack } from "solid-js";

type Context = Plugin.Context;
type Theme = Context["theme"];

import {
  MemoryRpc,
  formatMemoryLine,
  formatMemorySidebarCollapsed,
  formatMemorySidebarExpanded,
  formatMemoryStatusDialog,
  type MemorySidebarSnapshot,
  type MemorySnapshot,
  type SidebarSegment,
  type SidebarTone,
} from "./rpc.js";
import { createSidebarState, type SidebarStateRpc } from "./sidebar-state.js";

const REFRESH_MS = 30_000;
/** quota-style event refresh: debounced immediate refresh after activity. */
const EVENT_DEBOUNCE_MS = 150;

function themedFooter(theme: Theme, label: () => SidebarSegment[] | null): JSX.Element {
  return (
    <box flexDirection="row" gap={1}>
      <text fg={theme.text.base} wrapMode="none">
        <b>Memory</b>
      </text>
      <Show when={label()} keyed>
        {(segments) => (
          <box flexDirection="row" gap={0}>
            <For each={segments}>
              {(seg) => (
                <text fg={toneFg(theme, seg.tone)} wrapMode="none">
                  {seg.text}
                </text>
              )}
            </For>
          </box>
        )}
      </Show>
    </box>
  );
}

function dialogBody(theme: Theme, snapshot: MemorySidebarSnapshot): JSX.Element {
  const lines = formatMemoryStatusDialog(snapshot, Date.now());
  return segmentDialog(theme, [
    [{ text: "Memory · shared working memory", tone: "entity" }],
    ...lines,
  ]);
}

/** One tone-colored segment row per line (the dialog twin of sidebarBody). */
function segmentDialog(theme: Theme, lines: SidebarSegment[][]): JSX.Element {
  return (
    <box gap={0} paddingLeft={2} paddingRight={2} paddingBottom={1}>
      <For each={lines}>
        {(line) => (
          <box flexDirection="row" gap={0}>
            <For each={line}>
              {(seg) => (
                <text fg={toneFg(theme, seg.tone)} wrapMode="none">
                  {seg.tone === "entity" ? <b>{seg.text}</b> : seg.text}
                </text>
              )}
            </For>
          </box>
        )}
      </For>
    </box>
  );
}

/** A small focused dialog: one bold section title, then segment lines. */
function sectionDialog(theme: Theme, title: string, lines: SidebarSegment[][]): JSX.Element {
  return segmentDialog(theme, [[{ text: title, tone: "entity" }], ...lines]);
}

/** The theme's attention color for the hot glyph: warning or error when the
 * theme exposes one, plain text otherwise. */
function alertFg(theme: Theme): string {
  const palette = theme as {
    warning?: { base?: string };
    error?: { base?: string };
    text: { base: string };
  };
  return palette.warning?.base ?? palette.error?.base ?? theme.text.base;
}

/** Quota tone tiers to theme colors: entity and qualifier render in text,
 * values in muted, the alert glyph in the attention color. */
function toneFg(theme: Theme, tone: SidebarTone): string {
  if (tone === "value") {
    return theme.text.muted;
  }
  if (tone === "alert") {
    return alertFg(theme);
  }
  return theme.text.base;
}

/** The sidebar body: bold clickable header line, then one row of text segments
 * per line so each tone tier gets its own color. The header goes through the
 * same segment grammar: the collapsed one-liner mixes the bold title with
 * qualifier/value counts. wrapMode="none" everywhere: long lines clip instead
 * of wrapping. */
function sidebarBodyStyled(
  theme: Theme,
  lines: SidebarSegment[][],
  onToggle: () => void,
): JSX.Element {
  return (
    <box gap={0}>
      <box flexDirection="row">
        <For each={lines[0] ?? []}>
          {(seg) => (
            <text fg={toneFg(theme, seg.tone)} wrapMode="none" onMouseDown={onToggle}>
              {seg.tone === "entity" ? <b>{seg.text}</b> : seg.text}
            </text>
          )}
        </For>
      </box>
      <For each={lines.slice(1)}>
        {(line) => (
          <box flexDirection="row" gap={0}>
            <For each={line}>
              {(seg) => (
                <text fg={toneFg(theme, seg.tone)} wrapMode="none">
                  {seg.tone === "entity" ? <b>{seg.text}</b> : seg.text}
                </text>
              )}
            </For>
          </box>
        )}
      </For>
    </box>
  );
}

export default Plugin.define({
  id: "@log0u7/opencode-memory.tui",
  setup(context: Context) {
    const theme = context.theme;

    // Durable collapse state when the host allows it (scoped plugin ids hit a
    // host-side segment validation error — anomalyco/opencode#62634); RPC
    // fallback persists through the setup side; pure in-memory as last resort.
    // The RPC client output is untyped (Promise<unknown>): narrow to the
    // sidebar-state subset we consume.
    const stateRpc = context.client.rpc(MemoryRpc) as unknown as SidebarStateRpc;
    const [store, mutate] = createSidebarState(context.storage, stateRpc);
    const [snapshot, setSnapshot] = createSignal<MemorySidebarSnapshot | null>(null);
    const toggleCollapsed = () => {
      // Formatting is pure: flipping the store re-renders the sidebar from the
      // snapshot already in hand, no refetch needed.
      void mutate((draft) => {
        draft.collapsed = !draft.collapsed;
      });
    };

    // Live footer + sidebar: poll both server-side snapshots over RPC. On a v1
    // host (no RPC) or while the setup side is unreachable, both stay hidden.
    const [label, setLabel] = createSignal<SidebarSegment[] | null>(null);
    // The asking session for /memory continue and cleanup: captured from the
    // sidebar slot render (the slot is the only place the host passes it).
    const [currentSession, setCurrentSession] = createSignal<string | null>(null);
    const memory = context.client.rpc(MemoryRpc);
    const refresh = async () => {
      try {
        const next = (await memory.snapshot({})) as MemorySnapshot;
        setLabel(formatMemoryLine(next));
      } catch {
        // server unreachable or v1 host: hide the footer, keep the last dialog data
        setLabel(null);
      }
      try {
        setSnapshot((await memory.sidebar({})) as MemorySidebarSnapshot);
      } catch {
        setSnapshot(null);
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), REFRESH_MS);

    // Debounced event-driven refresh: saving, restoring or expiring an entry
    // changes the store contents. The stream stays open; polling is the fallback.
    let debounce: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => void refresh(), EVENT_DEBOUNCE_MS);
    };
    const events = context.client.event.subscribe();
    void (async () => {
      try {
        for await (const _event of events) {
          schedule();
        }
      } catch {
        // stream ended or errored: polling fallback stays active.
      }
    })();

    const unregister = context.ui.slot({
      append: "home.footer.status",
      render: () => themedFooter(theme, label),
    });

    // The state is machine-wide, not per session: no session switch handling,
    // the same snapshot serves every tab.
    const unregisterSidebar = context.ui.slot({
      append: "sidebar.content",
      render: (slot) => {
        // Written untracked: the write must not re-run the render that reads
        // the same signal (Solid reactive loop).
        if (slot.sessionID && slot.sessionID !== untrack(currentSession)) {
          untrack(() => setCurrentSession(slot.sessionID));
        }
        const snap = snapshot();
        if (!snap) {
          return (
            <box flexDirection="row">
              <text fg={theme.text.base} wrapMode="none">
                <b>▶ Memory</b>
              </text>
            </box>
          );
        }
        if (!snap.store || store.collapsed) {
          return sidebarBodyStyled(theme, formatMemorySidebarCollapsed(snap), toggleCollapsed);
        }
        return sidebarBodyStyled(
          theme,
          formatMemorySidebarExpanded(snap, Date.now()),
          toggleCollapsed,
        );
      },
    });

    // Keymap layers are disposed with the plugin; no manual disposer here.
    const MEMORY_USAGE =
      "usage: /memory [status|kinds|sync|trash|stats|continue <sessionID>|cleanup [apply]]";
    const toast = (message: string, variant: "info" | "warning" = "info") =>
      context.ui.toast.show({ title: "Memory", message, variant });
    const unreachable = () => toast("Server unreachable");
    const showStatus = async () => {
      await refresh();
      const snap = snapshot();
      if (!snap) {
        unreachable();
        return;
      }
      context.ui.dialog.show(() => dialogBody(theme, snap));
      context.ui.dialog.set({ size: "medium" });
    };
    // Slice views: one focused section per subcommand, built from the sidebar
    // snapshot already in hand (refreshed first, the data is cheap to refetch).
    const freshSidebar = async (): Promise<MemorySidebarSnapshot | null> => {
      await refresh();
      return snapshot();
    };
    const kindsLines = (s: MemorySidebarSnapshot): SidebarSegment[][] => {
      const kinds = s.kinds.filter((row) => row.count > 0);
      if (kinds.length === 0) {
        return [[{ text: "(no kinds)", tone: "value" }]];
      }
      const segs: SidebarSegment[] = [];
      kinds.forEach((row, i) => {
        if (i > 0) {
          segs.push({ text: " · ", tone: "value" });
        }
        segs.push(
          { text: `${row.count}`, tone: "qualifier" },
          { text: ` ${row.kind}${row.count === 1 ? "" : "s"}`, tone: "value" },
        );
      });
      return [segs];
    };
    const syncLines = (s: MemorySidebarSnapshot): SidebarSegment[][] => {
      if (!s.mesh_installed) {
        return [[{ text: "mesh not installed", tone: "value" }]];
      }
      return [
        [
          { text: "in ", tone: "value" },
          { text: `${s.sync_incoming}`, tone: "qualifier" },
          { text: " · out ", tone: "value" },
          { text: `${s.shareable}`, tone: "qualifier" },
          { text: " shareable", tone: "value" },
        ],
      ];
    };
    const trashLines = (s: MemorySidebarSnapshot): SidebarSegment[][] => [
      [
        { text: `${s.trashed}`, tone: "qualifier" },
        { text: ` ${s.trashed === 1 ? "row" : "rows"} in the trash`, tone: "value" },
      ],
      [{ text: "recoverable 30 days via memory_restore", tone: "value" }],
    ];
    const textLines = (text: string): SidebarSegment[][] =>
      text.split("\n").map((row) => [{ text: row, tone: "value" as const }] as SidebarSegment[]);
    const showStats = async () => {
      try {
        const result = (await memory.stats({})) as {
          total: number;
          store_bytes: number;
          scopes: Array<{ scope: string; count: number }>;
          top: Array<{ id: string; kind: string; title: string }>;
        };
        const lines: SidebarSegment[][] = [];
        if (result.scopes.length === 0) {
          lines.push([{ text: "(empty store)", tone: "value" }]);
        } else {
          for (const row of result.scopes.slice(0, 6)) {
            lines.push([
              { text: row.scope, tone: "qualifier" },
              { text: ` ${row.count}`, tone: "value" },
            ]);
          }
          if (result.scopes.length > 6) {
            lines.push([{ text: `+${result.scopes.length - 6} more scopes`, tone: "value" }]);
          }
        }
        for (const entry of result.top) {
          lines.push([
            { text: `${entry.kind}`, tone: "qualifier" },
            { text: ` ${entry.title.slice(0, 40)}`, tone: "value" },
          ]);
        }
        context.ui.dialog.show(() => sectionDialog(theme, "Memory · stats", lines));
        context.ui.dialog.set({ size: "medium" });
      } catch {
        unreachable();
      }
    };
    const showContinue = async (target: string | undefined) => {
      if (!target) {
        toast("usage: /memory continue <sessionID>", "warning");
        return;
      }
      const sessionID = currentSession();
      if (!sessionID) {
        toast("no open session to inject the pointer into", "warning");
        return;
      }
      try {
        const result = (await memory.continue({ sessionID, target })) as {
          ok: boolean;
          message: string;
        };
        toast(result.message, result.ok ? "info" : "warning");
      } catch {
        unreachable();
      }
    };
    const showCleanup = async (apply: boolean) => {
      const sessionID = currentSession();
      const run = async () => {
        try {
          const result = (await memory.cleanup({
            ...(sessionID ? { sessionID } : {}),
            apply,
          })) as { report: string };
          context.ui.dialog.show(() =>
            sectionDialog(
              theme,
              `Memory · cleanup${apply ? " (applied)" : " (dry run)"}`,
              textLines(result.report),
            ),
          );
          context.ui.dialog.set({ size: "medium" });
          void refresh();
        } catch {
          unreachable();
        }
      };
      if (!apply) {
        await run();
        return;
      }
      const confirmed = await context.ui.dialog.confirm({
        title: "Memory",
        message: "Delete the eligible transcripts? This is irreversible.",
        label: { confirm: "Delete", cancel: "Cancel" },
      });
      if (confirmed) {
        await run();
      }
    };
    const dispatch = async (input: string | undefined) => {
      const words = (input ?? "").trim().split(/\s+/).filter(Boolean);
      const [cmd, arg] = words;
      switch (cmd ?? "") {
        case "":
        case "status":
          await showStatus();
          return;
        case "kinds": {
          const snap = await freshSidebar();
          if (!snap) {
            unreachable();
            return;
          }
          context.ui.dialog.show(() => sectionDialog(theme, "Memory · kinds", kindsLines(snap)));
          context.ui.dialog.set({ size: "medium" });
          return;
        }
        case "sync": {
          const snap = await freshSidebar();
          if (!snap) {
            unreachable();
            return;
          }
          context.ui.dialog.show(() => sectionDialog(theme, "Memory · sync", syncLines(snap)));
          context.ui.dialog.set({ size: "medium" });
          return;
        }
        case "trash": {
          const snap = await freshSidebar();
          if (!snap) {
            unreachable();
            return;
          }
          context.ui.dialog.show(() => sectionDialog(theme, "Memory · trash", trashLines(snap)));
          context.ui.dialog.set({ size: "medium" });
          return;
        }
        case "stats":
          await showStats();
          return;
        case "continue":
          await showContinue(arg);
          return;
        case "cleanup":
          await showCleanup(arg === "apply" || arg === "run" || arg === "yes");
          return;
        default:
          toast(MEMORY_USAGE, "warning");
      }
    };
    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "memory.status",
          title: "Memory",
          group: "Memory",
          slash: { name: "memory", arguments: true },
          palette: true,
          run: async (input?: string) => {
            await dispatch(input);
          },
        },
        {
          id: "memory.toggleSidebar",
          title: "Toggle memory sidebar",
          group: "Memory",
          run: async () => {
            toggleCollapsed();
          },
        },
      ],
    }));

    return () => {
      clearTimeout(debounce);
      clearInterval(timer);
      unregister();
      unregisterSidebar();
    };
  },
});

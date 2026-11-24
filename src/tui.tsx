/** @jsxImportSource @opentui/solid */

import { Plugin } from "@opencode/plugin/tui";
import type { JSX } from "@opentui/solid";
import { For, Show, createSignal } from "solid-js";

type Context = Plugin.Context;
type Theme = Context["theme"];

import {
  MemoryRpc,
  formatMemoryDialog,
  formatMemoryLine,
  formatMemorySidebarCollapsed,
  formatMemorySidebarExpanded,
  type MemorySidebarSnapshot,
  type MemorySnapshot,
  type SidebarSegment,
  type SidebarTone,
} from "./rpc.js";
import { createSidebarState, type SidebarStateRpc } from "./sidebar-state.js";

const REFRESH_MS = 30_000;
/** quota-style event refresh: debounced immediate refresh after activity. */
const EVENT_DEBOUNCE_MS = 150;

function themedFooter(theme: Theme, label: () => string | null): JSX.Element {
  return (
    <box flexDirection="row" gap={1}>
      <text fg={theme.text.base} wrapMode="none">
        <b>Memory</b>
      </text>
      <Show when={label()} keyed>
        {(text) => (
          <text fg={theme.text.muted} wrapMode="none">
            {text}
          </text>
        )}
      </Show>
    </box>
  );
}

function dialogBody(theme: Theme, snapshot: MemorySnapshot): JSX.Element {
  const lines = formatMemoryDialog(snapshot);
  return (
    <box gap={1} paddingLeft={2} paddingRight={2} paddingBottom={1}>
      <text fg={theme.text.base}>
        <b>Memory — shared working memory</b>
      </text>
      <For each={lines.slice(1)}>{(line) => <text fg={theme.text.muted}>{line}</text>}</For>
    </box>
  );
}

/** The sidebar body for plain-string lines (collapsed mode and the no-store
 * fallback): line 0 is the clickable header (bold), the rest are muted counts
 * lines built by the pure formatMemorySidebarCollapsed. */
function sidebarBody(
  theme: Theme,
  header: string,
  body: string[],
  onToggle: () => void,
): JSX.Element {
  return (
    <box gap={0}>
      <box flexDirection="row">
        <text fg={theme.text.base} wrapMode="none" onMouseDown={onToggle}>
          <b>{header}</b>
        </text>
      </box>
      <For each={body}>
        {(line) => (
          <text fg={theme.text.muted} wrapMode="none">
            {line}
          </text>
        )}
      </For>
    </box>
  );
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

/** The expanded v4 sidebar body: bold clickable header, then one row of text
 * segments per line so each tone tier gets its own color. wrapMode="none"
 * everywhere: long lines clip instead of wrapping. */
function sidebarBodyStyled(
  theme: Theme,
  lines: SidebarSegment[][],
  onToggle: () => void,
): JSX.Element {
  const header = lines[0]?.map((seg) => seg.text).join("") ?? "";
  return (
    <box gap={0}>
      <box flexDirection="row">
        <text fg={theme.text.base} wrapMode="none" onMouseDown={onToggle}>
          <b>{header}</b>
        </text>
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
    context.ui.toast.show({ message: "opencode-memory loaded", variant: "info", duration: 2000 });

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
    const [label, setLabel] = createSignal<string | null>(null);
    const [dialogSnapshot, setDialogSnapshot] = createSignal<MemorySnapshot | null>(null);
    const memory = context.client.rpc(MemoryRpc);
    const refresh = async () => {
      try {
        const next = (await memory.snapshot({})) as MemorySnapshot;
        setDialogSnapshot(next);
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
      render: () => {
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
          const lines = formatMemorySidebarCollapsed(snap);
          return sidebarBody(theme, lines[0] ?? "", lines.slice(1), toggleCollapsed);
        }
        return sidebarBodyStyled(
          theme,
          formatMemorySidebarExpanded(snap, Date.now()),
          toggleCollapsed,
        );
      },
    });

    // Keymap layers are disposed with the plugin; no manual disposer here.
    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "memory.status",
          title: "Memory status",
          group: "Memory",
          slash: { name: "memory" },
          palette: true,
          run: async () => {
            await refresh();
            const current = dialogSnapshot();
            if (!current) {
              context.ui.toast.show({
                title: "Memory",
                message: "Server unreachable",
                variant: "info",
              });
              return;
            }
            context.ui.dialog.show(() => dialogBody(theme, current));
            context.ui.dialog.set({ size: "medium" });
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

/** @jsxImportSource @opentui/solid */

import { Plugin } from "@opencode/plugin/tui";
import type { JSX } from "@opentui/solid";
import { For, Show, createSignal } from "solid-js";

type Context = Plugin.Context;
type Theme = Context["theme"];

import { MemoryRpc, formatMemoryDialog, formatMemoryLine, type MemorySnapshot } from "./rpc.js";

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

export default Plugin.define({
  id: "@log0u7/opencode-memory.tui",
  setup(context: Context) {
    const theme = context.theme;
    context.ui.toast.show({ message: "opencode-memory loaded", variant: "info", duration: 2000 });

    // Live footer: poll the server-side snapshot over RPC. On a v1 host (no RPC)
    // or while the server is unreachable, the slot stays hidden.
    const [label, setLabel] = createSignal<string | null>(null);
    const [snapshot, setSnapshot] = createSignal<MemorySnapshot | null>(null);
    const memory = context.client.rpc(MemoryRpc);
    const refresh = async () => {
      try {
        const next = (await memory.snapshot({})) as MemorySnapshot;
        setSnapshot(next);
        setLabel(formatMemoryLine(next));
      } catch {
        // server unreachable or v1 host: hide the footer, keep the last dialog data
        setLabel(null);
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
            const current = snapshot();
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
      ],
    }));

    return () => {
      clearTimeout(debounce);
      clearInterval(timer);
      unregister();
    };
  },
});

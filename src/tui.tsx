/** @jsxImportSource @opentui/solid */

import { Plugin } from "@opencode/plugin/tui";
import { Show, createSignal } from "solid-js";
import { MemoryRpc, formatMemoryLine, type MemorySnapshot } from "./rpc.js";

const REFRESH_MS = 30_000;

export default Plugin.define({
  id: "@log0u7/opencode-memory.tui",
  setup(context) {
    context.ui.toast.show({ message: "opencode-memory loaded", variant: "info", duration: 2000 });

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
            context.ui.toast.show({
              title: "Memory",
              message: "Shared working memory is available",
              variant: "info",
            });
          },
        },
      ],
    }));

    // Live footer: poll the server-side snapshot over RPC. On a v1 host (no RPC)
    // or while the server is unreachable, the slot stays hidden.
    const [label, setLabel] = createSignal<string | null>(null);
    const memory = context.client.rpc(MemoryRpc);
    const refresh = async () => {
      try {
        setLabel(formatMemoryLine((await memory.snapshot({})) as MemorySnapshot));
      } catch {
        setLabel(null);
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), REFRESH_MS);

    const unregister = context.ui.slot({
      append: "home.footer.status",
      render: () => (
        <Show when={label()} keyed>
          {(text) => <text>{text}</text>}
        </Show>
      ),
    });

    return () => {
      clearInterval(timer);
      unregister();
    };
  },
});

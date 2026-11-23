import type { Plugin } from "@opencode/plugin/tui";
import { createStore, produce } from "solid-js/store";

type SidebarState = { collapsed: boolean };

/** RPC client subset used for the durable fallback (see below). */
export type SidebarStateRpc = {
  sidebar_state: (input: Record<string, never>) => Promise<{ collapsed: boolean }>;
  set_sidebar_state: (input: { collapsed: boolean }) => Promise<{ collapsed: boolean }>;
};

/** Collapse state for the memory sidebar: durable via the host's TUI storage when
 * available. The host composes storage keys as `plugin.<id>.<key>` and its
 * segment() validation rejects scoped npm ids (`@scope/name.tui`), so
 * `storage.store()` throws on first use for any plugin installed from a scoped
 * package (anomalyco/opencode#62634; upstream fix in PR #62638). The fallback
 * persists the state through the setup side over RPC (raw storage domain under
 * an escaped key, see src/lib/persist.ts), degrading to in-memory when no RPC
 * is available. Returns the same `[store, mutate]` shape as `storage.store`
 * either way. */
export function createSidebarState(
  storage: Plugin.Context["storage"],
  rpc?: SidebarStateRpc,
): readonly [
  { readonly collapsed: boolean },
  (mutation: (draft: SidebarState) => void) => Promise<void>,
] {
  try {
    return storage.store("memory-sidebar", { initial: { collapsed: true } });
  } catch {
    const [store, setStore] = createStore<SidebarState>({ collapsed: true });
    if (rpc) {
      // Adopt the persisted state once it arrives; the sidebar renders
      // expanded for the first frames, which is harmless.
      void rpc
        .sidebar_state({})
        .then((state) => {
          if (state.collapsed !== store.collapsed) {
            setStore(
              produce((draft) => {
                draft.collapsed = state.collapsed;
              }),
            );
          }
        })
        .catch(() => {});
    }
    return [
      store,
      (mutation: (draft: SidebarState) => void) => {
        setStore(produce(mutation));
        // Fire and forget: a failed save only loses one toggle.
        if (rpc) {
          void rpc.set_sidebar_state({ collapsed: store.collapsed }).catch(() => {});
        }
        return Promise.resolve();
      },
    ] as const;
  }
}

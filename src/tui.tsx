/** @jsxImportSource @opentui/solid */

import { Plugin } from "@opencode/plugin/tui";

const id = "@log0u7/opencode-memory";

export default Plugin.define({
  id: `${id}.tui`,
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

    return context.ui.slot({
      append: "home.footer.status",
      render: () => null,
    });
  },
});

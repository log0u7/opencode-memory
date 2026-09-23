# opencode-memory

[![CI](https://github.com/log0u7/opencode-memory/actions/workflows/ci.yml/badge.svg)](https://github.com/log0u7/opencode-memory/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@log0u7/opencode-memory)](https://www.npmjs.com/package/@log0u7/opencode-memory)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

Working memory for [OpenCode](https://opencode.ai): a shared SQLite store that all sessions on a machine read and write, so decisions, facts, and compaction summaries survive session boundaries.

Every session gets four tools (`memory_save`, `memory_search`, `memory_list`, `memory_forget`). Entries are scoped per project worktree (plus a `global` scope), searched with SQLite FTS5 (BM25 ranking with a recency boost). 100% local, no cloud, no API keys.

## Install

Register the plugin in `opencode.json` (project or global `~/.config/opencode/opencode.json`):

```json
{
  "plugin": ["@log0u7/opencode-memory"]
}
```

Restart OpenCode. That is it: the store lives at `~/.local/share/opencode-memory/memory.db` (honors `XDG_DATA_HOME`).

The package is installed automatically at startup into opencode's plugin cache (`~/.cache/opencode/packages/`); no global npm/pnpm/mise install is needed (opencode does not consult global installs for plugins). Pin a version if you want upgrades to be explicit:

```json
{
  "plugin": ["@log0u7/opencode-memory@0.1.1"]
}
```

Note (npm 12): the package ships no lifecycle install scripts and needs no `allowScripts` / allowlist on install.

## Usage

Nothing to do manually: the model is instructed to search memory at task start and save durable facts as they emerge. You can drive it explicitly:

```
memory_save(kind="decision", title="Use WAL mode", body="...", tags=["db"])
memory_search("postgres migration strategy")
memory_list()
memory_forget(id="...")
```

### Tools

| Tool | Args | Description |
|---|---|---|
| `memory_save` | `kind`, `title`, `body`, `scope?`, `tags?`, `expires_at?` | Save an entry. Default scope is the session worktree. |
| `memory_search` | `query`, `scope?`, `limit?` | Hybrid search: FTS5 BM25 + recency boost. |
| `memory_list` | `scope?`, `limit?` | Recent entries, newest first. |
| `memory_forget` | `id` or `query` | Delete one entry by id, or all matching a query. |

Entry `kind` is free-form; conventions that work well: `decision`, `fact`, `preference`, `gotcha`, `compaction`.

### Notes

- All sessions on the machine share one store (WAL mode, concurrent-safe).
- Entries that look like secrets (`sk-…`, `ghp_…`, `xoxb-…`) are refused.
- On session compaction, the plugin asks the compaction prompt to emit durable decisions so the model can persist them.

## Development

Requires Node >= 22 (mise: `mise install`) and pnpm (corepack).

```sh
pnpm install
pnpm verify      # biome + typecheck + vitest
pnpm build:check # tsc build + pack dry-run
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the workflow.

## License

[Apache-2.0](LICENSE)

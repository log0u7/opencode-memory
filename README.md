# opencode-memory

[![CI](https://github.com/log0u7/opencode-memory/actions/workflows/ci.yml/badge.svg)](https://github.com/log0u7/opencode-memory/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@log0u7/opencode-memory)](https://www.npmjs.com/package/@log0u7/opencode-memory)
[![Node.js](https://img.shields.io/node/v/@log0u7/opencode-memory?logo=node.js&logoColor=white)](https://www.npmjs.com/package/@log0u7/opencode-memory)
[![TypeScript](https://img.shields.io/github/package-json/dependency-version/log0u7/opencode-memory/dev/typescript?logo=typescript&logoColor=white)](https://github.com/log0u7/opencode-memory/blob/main/package.json)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

Working memory for [OpenCode](https://opencode.ai): a shared SQLite store that all sessions on a machine read and write, so decisions, facts, and compaction summaries survive session boundaries.

Every session gets four tools (`memory_save`, `memory_search`, `memory_list`, `memory_forget`). Entries are scoped per project worktree (plus a `global` scope), searched with SQLite FTS5 (BM25 ranking, strict match first with a prefix fallback). Recent entries are also injected into the prompt: once per session, and again during compaction. 100% local, no cloud, no API keys.

## Safety limits

- Results are capped: at most 50 entries per call, and each body is rendered as a 500-character preview. A tool result has a bounded size whatever the model asks for.
- `memory_save` rewrites an entry that repeats a scope and title instead of stacking duplicates, and purges expired rows.
- `memory_forget` only deletes inside the caller's scope (plus the shared `global` scope).
- Entries that look like secrets (`sk-…`, `ghp_…`, `xoxb-…`) are refused, in the title, kind, body and tags alike.

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
| `memory_search` | `query`, `scope?`, `limit?` | FTS5 BM25 search; strict match first, prefix OR fallback when nothing matches. |
| `memory_list` | `scope?`, `limit?` | Recent entries, newest first. |
| `memory_forget` | `id` or `query` | Delete one entry by id, or all matching a query. |

Entry `kind` is free-form; conventions that work well: `decision`, `fact`, `preference`, `gotcha`, `lesson`, `compaction`.

### Feedback loop

The agent is nudged to write memory itself: the system prompt asks for durable decisions, facts, preferences and gotchas as they emerge, and the compaction prompt repeats the instruction next to the store inventory. Reusable lessons (`kind=lesson`: a non-obvious approach that clearly failed or succeeded, and why) are injected first in later sessions, so known mistakes are not retried.

Optional LLM reflection, off by default: on `session.idle` the plugin sends the last `transcriptChars` of the session to one bounded LLM call and saves at most `maxLessons` distilled lessons through the same store (the secret guard applies). Subagent sessions are skipped and at most one reflection runs per session.

```json
{
  "plugin": [
    ["@log0u7/opencode-memory", { "reflection": { "enabled": true } }]
  ]
}
```

Options: `enabled` (default `false`), `model` (`"provider/model"`, default: the host's model), `maxLessons` (default 3, cap 10), `transcriptChars` (default 8000).

Cost per reflection: ~2k input tokens (the bounded transcript) and at most ~300 output tokens, at most once per session: roughly $0.001 with a small model, $0.01 with a frontier model (indicative). The nudges and injections are plain text: they cost nothing.

### Notes

- All sessions on the machine share one store (WAL mode, concurrent-safe).
- Entries that look like secrets (`sk-…`, `ghp_…`, `xoxb-…`) are refused, in the title, kind, body and tags.
- Every repeated `memory_save` of the same title in the same scope rewrites the entry, so the store does not grow with duplicates, and expired rows are purged on save.
- `memory_forget` by query never leaves the scope it is called from, so a project cannot fuzzily delete another project's entries; by id it deletes anywhere (ids are globally unique), which keeps closed worktrees cleanable.
- On the first request of a session, the most recent entries are injected into the system prompt as a bounded list (titles only), so the model does not have to remember to search. `memory_search` remains the tool for deeper lookups.
- On session compaction, the plugin lists the stored entries in the compaction context and asks the compaction prompt to emit durable decisions, so the model summarises from an inventory instead of recall.
- Injections stay bounded (~1200 characters worst case) and nothing is injected, nor any store file created, when memory is unused.

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

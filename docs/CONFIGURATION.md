# Configuration

Options for the `@log0u7/opencode-memory` plugin, set on the plugin entry in `opencode.json`:

```json
{
  "plugin": [
    ["@log0u7/opencode-memory", { "reflection": false }]
  ]
}
```

## Plugin options

| Option | Default | Effect |
| --- | --- | --- |
| `dbPath` | `$XDG_DATA_HOME`/`$HOME/.local/share/opencode-memory/memory.db` | SQLite store location (one store per machine). |
| `reflection` | on | Standing directive: the running model distills its lessons itself. `false` (or an object without `enabled: true`) switches it off. An object with `enabled: true` opts into the legacy LLM loop, see below. |
| `housekeeping` | `true` | Conservative sweep at boot and every 24h: dated entries past the TTL become tombstones, exact duplicates are dropped. |
| `sweepTtlDays` | `7` | Days after which a dated entry becomes sweepable. `0` or less falls back to the default instead of sweeping fresh entries. |
| `retrieval` | see below | Transcript retrieval and retention, see below. |
| `caveman` | `"auto"` | Terse guidance and terse entries when caveman is installed. `"auto"` detects it, `true` forces it, `false` disables it. See below. |

## Caveman

[caveman](https://github.com/JuliusBrussee/caveman) makes the agent answer in a compressed register. When it is present, the plugin uses a terse system guidance and compaction prompt, and asks the agent to write memory entries caveman-terse (no articles, filler or hedging; code, paths, identifiers, commands, numbers and error text stay exact). Every stored title and body is read again on each recall, so a shorter entry saves tokens in every later session. When caveman is absent, the plain guidance is used and nothing mentions caveman.

With `"auto"` (default), any of these signals counts as installed:

| Signal | Written by |
| --- | --- |
| `<config>/.caveman-active` (mode flag, removed by `/caveman off`) | upstream OpenCode plugin |
| `<!-- caveman-begin -->` block in `<config>/AGENTS.md`, or in the project's `AGENTS.md` / `.opencode/AGENTS.md` | upstream installer (`--only opencode`, `--with-init`) |
| a `plugin` entry containing `caveman` or `caveopen` in `<config>/opencode.json(c)` or the project's `opencode.json(c)` | upstream plugin and third-party ports (`opencode-caveman`, `@mumme-it/opencode-caveman`, `caveman-opencode-plugin`, `caveopen`...) |

`<config>` follows OpenCode's own resolution: `$OPENCODE_CONFIG_DIR`, else `$XDG_CONFIG_HOME/opencode`, else `~/.config/opencode`.

Detection runs once, when the plugin starts: the guidance is part of the cached prompt prefix and must not flip in the middle of a session. Restart OpenCode after installing or removing caveman. The upstream always-on rules in `AGENTS.md` stay loaded after `/caveman off`, so the terse memory guidance stays on as well; set `"caveman": false` to opt out.

## LLM reflection (legacy, opt-in)

`{ "reflection": { "enabled": true } }` replaces the directive with one bounded LLM call on `session.idle`:

| Option | Default | Effect |
| --- | --- | --- |
| `reflection.enabled` | `false` | Must be `true` to run the loop. |
| `reflection.model` | the host's model | Model for the distill call, as `"provider/model"` (a value without `/` is ignored). |
| `reflection.transcriptChars` | `8000` | Transcript tail sent to the call, clamped to 500-50000. |
| `reflection.timeoutMs` | `60000` | Call timeout, clamped to 1000-600000. |

## Retrieval (`retrieval`)

| Option | Default | Effect |
| --- | --- | --- |
| `retrieval.enabled` | `true` | Replace the compaction summary with a transcript pointer. |
| `retrieval.dir` | `~/.local/share/opencode-memory/transcripts` | Where session transcripts are stored. |
| `retrieval.inlineOutputMaxBytes` | `50000` | Per-output inline cap in bytes (minimum 128). |
| `retrieval.retentionDays` | `0` (off) | Delete transcripts older than this many days. |
| `retrieval.keepRecent` | `10` | Always keep this many newest transcripts per scope. |
| `retrieval.maxSessions` | `0` (off) | Hard cap on transcripts per scope. |
| `retrieval.autoSweep` | `true` | Run the retention sweep automatically when enabled. |

## Endorsement and cross-host sharing

No configuration: `shareable: true` on `memory_save` records the author's endorsement, `memory_endorse` adds a peer's, and entries carrying at least one endorsement are exported to the mesh outbox on every push. Refining an entry (same title, or an explicit `supersedes`) carries its endorsements to the replacement, so a shared entry stays shared across refinements.

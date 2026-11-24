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

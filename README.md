# Session Switcher — a Claude Mod

`/sessions` (or Ctrl+G) opens a paged, filterable list of your recent Claude Code
sessions, 10 per page, newest first.

Claude Code already has `--resume` with a searchable picker. What this adds is
**tags**, a sense of **shape** (when a session was actually busy), and switching
**across projects from inside a running session**.

Each row shows:
- an **activity strip**: 24 cells tracing when the session was busy, tinted by project
- the title (your custom title → the newest `ai-title` record → first real prompt)
- relative last-active time, project, git branch, and your `#tags`
- on the selected row: the opening prompt, prompt count, files edited

## Keys
| Key | Action |
|---|---|
| type | filter across title, prompt, project, branch, `#tag` |
| ↑ ↓ | move · ← → page |
| Enter | resume session (in its own directory) |
| Tab | rename/tag — e.g. `#auth #client-x Token refresh bug` |
| Esc | clear filter, then close |

## How it stays fast

Transcripts are big — this machine's store is 372 MB across 13 sessions, one file
of which is 226 MB. Reading them the obvious way (`readFile` + `split("\n")` +
`JSON.parse` per line) takes ~1 GB of heap on that one file alone and blocks the
overlay for the whole time.

Instead:

1. **stat first, cache on disk.** Every known file is `stat`ed on open (cheap) and
   only re-read if its mtime or size moved. `INDEX_VERSION` forces a re-parse when
   the extractor changes, so the cache can't serve stale titles forever. This is
   lifted from [trailant](../trailant)'s indexer.
2. **Append-only reads.** Transcripts only grow, so a session that gained 40 KB is
   read from byte `cached.size`, not byte 0. A file that shrank is re-read whole.
   `test/scanner.test.ts` pins the invariant: incremental re-index === full re-index.
3. **No `JSON.parse` in the hot loop.** Every field a row needs is pulled with a
   regex off the raw line. The only line ever parsed is the single opening user
   prompt. Attachment and tool-output lines — most of the bytes — are matched and
   discarded without being decoded.
4. **Head+tail sampling** above 64 MB, so a runaway session costs two bounded reads
   on first sight instead of a 226 MB one. Those rows say so in the detail line.
5. **The list opens on the cache and fills in.** `loadSessions()` touches no
   transcript; `syncSessions()` streams updated rows into the open overlay.

Measured on the real store: **1 ms** to open, **0.4 s** to index all 372 MB cold,
**0 ms** on reopen when nothing changed. First row on screen after 4 ms.

## Transcript facts this depends on
Verified against real files here, not assumed:
- The title lives in `type: "ai-title"` records as `aiTitle`, and they **regenerate
  mid-session** — the last one wins, not the first. There is no `ai_title` field.
- `type: "summary"` records are a legacy fallback that matched **zero** real
  sessions; kept only because it costs nothing.
- The first `type: "user"` record is usually **not** your prompt — it's a
  `<system-reminder>`, a slash-command banner or an IDE selection. Taking it at
  face value titles half your sessions with a wrapper blob.
- `cwd` on the record is authoritative; decoding the directory name is lossy
  (`/`, `.`, `:` and `\` all map to `-`).
- Sessions are `projects/<slug>/<id>.jsonl`, exactly one level deep. Sub-agent
  transcripts live in `<id>/subagents/` and are somebody else's session — here
  that's 254 files and 51 MB correctly excluded.
- Noise record types (`attachment`, `queue-operation`, `last-prompt`,
  `atis-latch`, `file-history-snapshot`) must not be counted as messages, and
  `"type":"user"` lines carrying a `tool_result` are a tool's reply, not a turn.

## Where it writes
`~/.config/claude-session-switcher/` — `index.json` (the cache) and `meta.json`
(your tags and titles). Deliberately **not** `~/.claude`, which is off-limits.
Both are written temp-then-rename, so a crash can't truncate your tags.
Change `HOME_DIR` in `src/cache.ts` to move them.

Claude Code *does* have session names (`~/.claude/sessions/*.json`, a user-set
`name` where `nameSource` isn't `"derived"`); it does not have tags. Tags, and
filtering by them, are what this adds. Because resuming a session mints a new
session id, each record also stores a fingerprint (project + opening prompt) and
lookup falls back to it — otherwise your tags orphan the first time you resume.

## Command naming, and not colliding with the CLI

`/sessions` is exactly the kind of generic name a future release could claim —
`--resume` already ships a searchable picker, so a built-in `/sessions` is a short
walk away. The mod therefore never hard-codes one name. `src/config.ts` lists
candidates and keeps the first the host accepts:

    session-switcher:sessions   → qualified; can't collide
    switcher                    → short alias
    sessions                    → generic; only if nothing owns it

If a name is taken, that registration fails and the next is tried; if all three are
taken, the keybinding still opens the switcher, so it degrades rather than breaks.
Override any of it in `~/.config/claude-session-switcher/config.json`:

```json
{ "commands": ["switcher"], "keybinding": "ctrl+g", "refresh": 40 }
```

Plugin-provided skills are already addressed as `plugin:skill`, so if Mods namespace
commands the same way, the qualified name is the one that's safe forever.

## Development

```
npm install     # typescript, ink, react, types — dev only; the CLI provides the runtime
npm run check   # tsc (strict, incl. exactOptionalPropertyTypes + noUncheckedIndexedAccess) + tests
```

## Before it will run
`src/mod.tsx` uses guessed hook names (`command:/sessions`, `$.ui.overlay`,
`$.session.resume`). Mods are pre-release; compare against a built-in mod in
`anthropics/claude-code/mods` and swap in the real calls. Note that resume needs
the session's `cwd`, not just its id. Everything under `src/sessions.ts`,
`src/cache.ts` and `src/tags.ts` is plain Node and is covered by `npm test`.

```
npm run check
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude
```

## License
MIT

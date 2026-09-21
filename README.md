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

There is no raw key hook on the mod surface, so the interaction is built from what
the element table offers — and it fits: the page holds ten rows, and a `Button`
hotkey is exactly one digit.

| Key | Action |
|---|---|
| type | filter across title, prompt, project, branch, `#tag` |
| 1–9, 0 | resume that row, in its own directory |
| t | tag mode — a digit then opens that row's tag field |
| n / p | next / previous page |
| Esc | close the pane |

A surface whose element table has no `Input` still draws its rows; the filter
degrades to a label rather than the pane refusing to draw.

## Layout

An upstream-shaped plugin: `.claude-plugin/plugin.json`, `hooks/hooks.json` naming
`hooks/register.ts`, and `types/claude-code.d.ts` vendored from Claude Code 2.1.277.
`register(on)` hooks `session.start` (register the command), `command.run` (open the
pane), `ui.render` (draw it) and `ui.close`.

## How it stays fast

Transcripts are big. Measured on one real, heavily used store: 372 MB across 13
sessions, the largest single file 226 MB. Reading them the obvious way (`readFile` + `split("\n")` +
`JSON.parse` per line) takes ~1 GB of heap on that one file alone and blocks the
overlay for the whole time.

Instead:

1. **stat first, cache on disk.** Every known file is `stat`ed on open (cheap) and
   only re-read if its mtime or size moved. `INDEX_VERSION` forces a re-parse when
   the extractor changes, so the cache can't serve stale titles forever. This is
   lifted from trailant's indexer. The index lives in `$.store`, the engine's own
   key-value store.
2. **Append-only reads.** The engine cuts a subprocess's stdout at 4 MiB — measured,
   not documented: the largest capture came back at 3.99 MiB. Reads are bounded so
   that cut is routine rather than exceptional, and a read that returns bytes but no
   whole line (one record larger than the entire limit) steps over that record
   instead of stalling the file forever. Transcripts only grow, so a session that gained 40 lines
   Transcripts only grow, so a session that gained 40 lines is read from line
   `cached.lines + 1`, not line 1. A file that shrank is re-read whole.
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
Nowhere on disk. The index, your tags and the config all live in `$.store`, the
engine's own per-plugin key-value store (JSON, 4 MiB cap — the index was 53 KB for
13 sessions). Transcripts are only ever read.

Claude Code *does* have session names (`~/.claude/sessions/*.json`, a user-set
`name` where `nameSource` isn't `"derived"`); it does not have tags. Tags, and
filtering by them, are what this adds. Because resuming a session mints a new
session id, each record also stores a fingerprint (project + opening prompt) and
lookup falls back to it — otherwise your tags orphan the first time you resume.

## Command naming, and not colliding with the CLI

`/sessions` is exactly the kind of generic name a future release could claim —
`--resume` already ships a searchable picker, so a built-in `/sessions` is a short
walk away. The mod therefore never hard-codes one name. `hooks/config.ts` lists
candidates and keeps the first the engine accepts:

    session-switcher:sessions   → qualified; can't collide
    switcher                    → short alias
    sessions                    → generic; only if nothing owns it

If a name is taken, that registration fails and the next is tried; if all three are
taken, the keybinding still opens the switcher, so it degrades rather than breaks.
The command name and the refresh count are declared as `userConfig` in the manifest,
so they're editable from `/config` rather than a hidden file. A name chosen there is
tried first and still falls back if a built-in owns it.

This is upstream's own idiom, not an invention: `$.command.register` throws when a
name is taken, and Anthropic's `diff` mod catches exactly that to cede `/diff`
— *"`/diff` once the built-in stands down."*

## Development

```
npm install     # typescript + node types only; the surface supplies the elements
npm run types   # fetch Anthropic's claude-code.d.ts (not vendored — see below)
npm run check   # tsc against those declarations, then the tests
```

`types/claude-code.d.ts` is Anthropic's file and is deliberately **not** committed
here: this repo is MIT, and shipping their declarations inside it would imply a
licence over them that isn't mine to give. `npm run types` fetches the copy from
`anthropics/claude-code`. Once `/plugin-types` ships in the CLI, prefer that — it
writes the declarations for the build you're actually on.

## Before it will run
**It runs.** On Claude Code 2.1.278 with `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`, the
engine loads the module, admits it, raises `session.start`, registers the command
and opens the pane:

```
hooks module session-switcher@inline loaded (worker, environment 1, tier user);
  events: session.start,command.run,ui.render,ui.close
plugin.register: session-switcher — admitted
$.command.register (session-switcher): /switcher listed
ui.open session-switcher (unasked, unmeasured columns): placed
$.store.set (session-switcher@inline): session-index
```

Note *which* name it took. `session-switcher:sessions` was refused and `/switcher`
was accepted — the ordered fallback firing for real, unprompted.

Measured over the whole 372 MB store, in the engine, not a benchmark harness:

| | subprocess reads | bytes read |
|---|---|---|
| first open (cold index) | 52 | 15.2 MB |
| next open (nothing new) | 4 | — |

`claude plugin validate .` passes, and prints the mod's entire reach before any
session loads it:

```
hooks:      session.start, command.run, ui.render{component=Pane}, ui.close
calls:      $.command.register, $.env.get, $.fs.list, $.fs.stat, $.process.run,
            $.store.get, $.store.set, $.ui.close, $.ui.invalidate, $.ui.log,
            $.ui.open, $.ui.resolve
env writes: nothing
env reads:  HOME
```

```
npm run types && npm run check
claude plugin validate .
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir .
```

What the live run has *not* covered: the pane's actual drawing. A print-mode session
has no surface, so `ui.render` never fires there — the view is proven by its unit
tests and by `ui.open` being placed, not by pixels.

Known unknowns: resume shells out to `claude --resume <id>` with the session's cwd,
because no `$.session.resume` appears on the surface; and `sed`/`head`/`tail` mean
the reader is POSIX-only until there's a portable ranged read.

`/plugin-types` isn't installed in this build, so the declarations used here are the
2.1.277 copy from upstream (`npm run types`). Regenerate with `/plugin-types` once it
exists rather than trusting a snapshot — the header says the surface changes between
releases.

```
npm run check
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude
```

## License
MIT

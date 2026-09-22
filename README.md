# Session Switcher — a Claude Mod

<img src="docs/assets/mascot.svg" width="150" align="right" alt="Phae, a pixel-art hermit hummingbird">

`/sessions` (or Ctrl+G) opens a paged, filterable list of your recent Claude Code
sessions, 10 per page, newest first.

Claude Code already has `--resume` with a searchable picker. What this adds is
**tags**, a sense of **shape** (when a session was actually busy), and switching
**across projects from inside a running session**.

Two lines a row:

```
▇█▁▁···········▁ 1: Token refresh keeps 401ing on retry                    now
                    api-gateway on feat/pane · 38 prompts, 12 files
▄█▄█▄█▄█▄█▄█▄█▄█ 2: Port the switcher to the mods surface                   1h
                    session-switcher on main · 112 prompts, 9 files
█··█···█··█··█·· 3: Trace the 4 MiB stdout ceiling                          2h
                    trailant on feat/pane · 640 prompts, 41 files · sampled
···············█ 4: Bump the deploy workflow                               3h
                    infra on main · 1 prompt
```

- an **activity strip**: 16 cells tracing when in its life the session was busy,
  tinted by project — burst-then-idle, steady and bursty each read differently
- the title, in order of how deliberate it is: a title you set here → the name you
  gave the session (`claude -n`, or the picker's rename) → the newest `ai-title`
  record → your first real prompt
- its digit hotkey, relative last-active time, project, branch, counts and `#tags`

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

## Tagging

Two ways in. From inside the session you're working in — no pane, no picking your
own row out of a list:

```
/switcher #wip #mods          add two tags to this session
/switcher -#mods              drop one
/switcher Token refresh bug   retitle it
/switcher #blocked waiting on review    both at once
/switcher help                the above, in the terminal
```

`+#wip` is accepted as sugar for `#wip`. Removal has to be marked, so `-#tag`
exists; once it does, the symmetric `+#tag` is what people reach for. Requiring it
would be worse — `#wip` is what you type without thinking — so both work.

The form is drawn dim beside the command as you type it (`argumentHint`), which is
the only place it's discoverable at the moment you'd want it. The command is
registered `immediate`, so you can tag a session while a turn is still streaming —
which is exactly when you notice the session is worth marking.

That form **folds in** rather than replacing: tags add, `-#tag` removes, and the
title is only overwritten when you type one. Tagging a session mid-flight should
never silently drop the title you gave it this morning.

Or from the pane: `t`, then the row's digit, then type. That form replaces, because
you can see exactly what you're editing.

Tags are stored per session and keyed by a project + opening-prompt fingerprint, so
they survive the new session id that a resume mints.

### If you already name sessions

A name like `Sep 10 | someone | some team` is three facets crammed into one string,
because a title was the only field there was. The switcher reads those names — they
outrank the generated `ai-title` — so nothing you've already done is lost. But split
that way it does more:

```
/switcher #someone #some-team Refund reconciliation mismatch
```

- **The date is already there.** Every row shows its own last-active time, and falls
  back to a calendar date past a month. Spending the title on `Sep 10` costs you the
  widest column in the list.
- **The facets compose.** The filter ANDs its words, so `#someone #some-team` is the
  intersection. A pipe-string can only be substring-matched, and `Some Team` versus
  `Some Tm` splits into two things that never meet again.
- **The title is then free to say what the session was about** — the one thing none
  of the three facets tell you, and the thing you actually need when you come back.

A tag is lowercased and takes letters, digits, `_` and `-` only, so `Some Team`
becomes `#some-team`. `#some team` would read as the tag `some` and a title
`team`.

### What's worth tagging

Not the project — that's already a facet. Typing `switcher` in the filter matches the
project column for free, and the same goes for the branch and anything in the title.
Tagging what the transcript already knows just duplicates it by hand.

Tags earn their keep on what the transcript can't know:

- **State** — `#wip`, `#blocked`, `#parked`. The switcher can see when a session was
  last active, not whether you were finished. This is the one that turns a long list
  into a queue.
- **Threads that cross repos** — one line of thinking spanning three projects is
  exactly what a project filter can't express.
- **Context that isn't in the code** — `#work` vs personal, `#demo` for sessions
  worth referencing later.

One state tag plus at most one thread tag is usually enough. The filter ANDs its
words, so `#wip #mods` narrows to the intersection. Tag vocabularies die from
ambition, not from disuse.

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
because no `$.session.resume` appears on the surface. And the Windows read fallback
has been written and pinned by tests but never executed — no Windows box here.

`/plugin-types` isn't installed in this build, so the declarations used here are the
2.1.277 copy from upstream (`npm run types`). Regenerate with `/plugin-types` once it
exists rather than trusting a snapshot — the header says the surface changes between
releases.

```
npm run check
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude
```

## The mascot

[Phae](docs/mascot.md), a hermit hummingbird. Hermits **trap-line** — a repeatable
circuit of scattered flowers, each returned to on its own schedule — and they track
not just which flowers they visited but how long ago, timing each return to that
flower's refill rate. Many sites, held in parallel, none of them home. Same diagram
as this tool, arrived at about forty million years earlier.

## License
MIT

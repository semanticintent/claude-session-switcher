# What the real Mods API looks like

Researched 2026-09-21 against `anthropics/claude-code` `main`. This replaces the
guesses in `src/mod.tsx`. **Early access — the surface may change between
releases without notice** (the declaration file says so in its header).

Sources: [issue #91870](https://github.com/anthropics/claude-code/issues/91870),
[`mods/`](https://github.com/anthropics/claude-code/tree/main/mods),
[`mods/types/claude-code.d.ts`](https://github.com/anthropics/claude-code/blob/main/mods/types/claude-code.d.ts),
and the built-in `diff` mod, which is the closest analogue to this one
(a slash command that opens a pane).

## The shape we guessed wrong

| we assumed | actually |
|---|---|
| `export default function(hook)` | `export function register(on: On)`, named export |
| hooks wired in code only | a **plugin folder** with `hooks/hooks.json` → `{ "description": …, "modules": ["./register.ts"] }` |
| `hook("command:/sessions", …)` | `engine.registerCommand({ name, description })` at `session.start`, then `on('command.run', { command: NAME }, ($, e, next) => …)` |
| `$.ui.overlay(<Ink tree/>)` | `$.ui.openPane({ id, title, rows, closeOnEscape, holdToasts })`, then **draw** by hooking `on('ui.render', { component: 'Pane' }, …)` |
| Ink `useInput` | `ui.press` / `ui.input` / `ui.select` / `ui.scroll` / `ui.focus` hooks |
| `$.session.resume(id)` | not found on the surface yet — still to confirm |

Hooks are `($, e, next)`. Calling `next(e)` runs every hook beneath and then the
engine; returning without `next` answers in the engine's place. `$` is the engine
interface, nouns with verbs: `$.ui`, `$.fs`, `$.process`, `$.clock`, `$.http`,
`$.model`, `$.agent`, `$.config`, `$.command`. Every call is spelled out in full
so `claude plugin validate` can print a mod's footprint before its code runs.

Mods draw on four surfaces — terminal, desktop, vscode, mobile — from the
surface's element table, not from our own Ink tree.

## The naming finding

`engine.registerCommand()` **throws when the name is taken**, and Anthropic's own
`diff` mod handles exactly that:

```ts
try {
  await engine.registerCommand(COMMAND_SPEC)
  host = engine
} catch (error) {
  const reason = messageOf(error)
  if (!Names.BUILTIN_HOLDS_PATTERN.test(reason)) { /* log */ }   // built-in holds /diff → stay silent
}
```

Its own docstring: *"`/diff` once the built-in stands down."* So a mod ceding a
name to a built-in is the expected case, not an edge case — which is precisely
what `src/config.ts` already does with its ordered candidate list. That design
survives contact with the real API unchanged; only the call it wraps changes from
`hook("command:/name")` to `engine.registerCommand({ name })`.

## What this costs us

- `src/sessions.ts`, `src/cache.ts`, `src/tags.ts`, `src/config.ts` — **unaffected.**
  Plain Node, fully tested, they port as-is. That was the point of keeping the
  guessed API confined to one file.
- `src/mod.tsx` — rewrite against `register(on)` + `registerCommand` + `command.run`.
- `src/SessionList.tsx` — the bigger job. The layout, filtering, paging and the
  activity strip are all still right; what changes is that it becomes a
  `ui.render` handler returning a `RenderElement` from the surface's element
  table, with key handling moved to the `ui.*` hooks. `<Box>`/`<Text>` and
  `wrap="truncate-end"` look close enough that much of the tree survives.

## Blocker

Mods need Claude Code **>= 2.1.259** behind an early-access flag.
This machine is on **2.1.34** — `claude update` first, then regenerate the
declarations in-place with `/plugin-types` rather than trusting this file.

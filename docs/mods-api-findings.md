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

## What `claude plugin validate` enforces that nothing else states

Validated against Claude Code 2.1.278. Two refusals, neither of them in the
declarations' prose, both of which reshaped this mod:

**`$` never crosses an import.** Passing the engine interface into a helper in
another module is refused outright:

> `$` is passed to "engineHost", imported from "./host.ts": `$` is followed only
> into a function declared in this same file, never across an import; `$` is
> always spelled `$.noun.event(...)` at the call site

So `hooks/host.ts` holds the port's *types* and one pure helper, and the
engine-side implementation is spelled inline in `register.ts`. This is why the
diff mod builds its own `Host` object at `session.start` rather than importing
one — that shape is a requirement, not a preference.

**A function that takes `$` must be declared at the top of the file.** Not nested
in `register()`'s closure:

> `$` is passed to "refresh", which is not a function declared at the top of this
> file (a function declaration, or a const bound to one)

Which is why the mod's state lives at module scope: `refresh` and `resume` have to
be top-level, so the state they work on has to reach them.

Both rules exist so the validator can compute a mod's footprint statically, which
it then prints:

```
hooks:      session.start, command.run{command=DEFAULTS.commands},
            ui.render{component=Pane}, ui.close{id=session-switcher}
calls:      $.command.register, $.env.get, $.fs.list, $.fs.stat, $.process.run,
            $.store.get, $.store.set, $.ui.close, $.ui.invalidate, $.ui.log,
            $.ui.open, $.ui.resolve
env writes: nothing
env reads:  HOME
```

That is the whole reach of this mod, checkable before a session ever loads it.

## Still missing on 2.1.278

- `/plugin-types` is not installed in this build, so the vendored declarations stay
  at the 2.1.277 copy from the repo. They validate clean against 2.1.278.
- `claude plugin test` does not exist yet (`unknown command 'test'`), though the
  declarations describe the kit it would run. The mod's own `npm test` covers the
  same ground in the meantime.

// Entry point: the module hooks.json names. Registers the command, draws the
// pane, and keeps the transcript index behind it fresh.
//
// Written against mods/types/claude-code.d.ts (Claude Code 2.1.277). The
// surface is early access and may change between releases; regenerate the
// declarations with /plugin-types rather than trusting this file's vintage.
import type { EngineInterface, On, PluginOptions } from "claude-code";
import { wholeLines, rangeArgv, sampleArgv, resumeCommand, PROJECTS, SESSIONS, type FileInfo, type Host, type Store } from "./host.ts";
import { cachedSessions, sync, type Session } from "./scan.ts";
import { loadMeta, saveMeta, setMeta, mergeMeta, pruneMeta, metaFor, type Meta } from "./tags.ts";
import { loadConfig, registerFirst, DEFAULTS } from "./config.ts";
import { view, PAGE, type Model, type Actions } from "./view.ts";

const PANE_ID = "session-switcher";
const PANE_TITLE = "Sessions";
const DESCRIPTION = "Switch between recent sessions — filter, tag, and resume in the right directory";
// Drawn dim after the name as you type it, which is the only place the argument
// form is discoverable at the moment you'd want it.
const ARGUMENT_HINT = "[#tag | -#tag | new title | help]";

const HELP = [
  "/switcher                       open the switcher",
  "/switcher #wip #mods            tag this session (+#wip works too)",
  "/switcher -#mods                untag this session",
  "/switcher Token refresh bug     retitle this session",
  "/switcher #blocked on review    tag and retitle at once",
  "",
  "Arguments fold in: tags add, -#tag removes, and the title only changes when",
  "you type one. In the pane, t then a row's digit edits it there instead, and",
  "that form replaces what's on the row, because you can see it.",
  "",
  "In the pane: type to filter · 1-9,0 resume · t tag · n/p page · Esc close",
].join("\n");

/**
 * The mod's whole state. It lives at module scope rather than inside
 * `register`'s closure because `claude plugin validate` only follows `$` into
 * functions declared at the top of this file — so `refresh` and `resume` have
 * to be top-level, and the state they work on has to reach them.
 */
const state = {
  host: null as Host | null,
  store: null as Store | null,
  commandName: null as string | null,
  isWindows: false,
  isOpen: false,
  syncing: false,
  sessions: [] as Session[],
  meta: {} as Record<string, Meta>,
  query: "",
  page: 0,
  mode: "resume" as "resume" | "tag",
  editing: null as { id: string; text: string } | null,
  refresh: 40,
};

const model = (): Model => ({
  sessions: state.sessions, meta: state.meta, query: state.query, page: state.page,
  mode: state.mode, editing: state.editing, syncing: state.syncing,
});

/** Folds in whatever changed since the last open, a row at a time. */
async function refresh($: EngineInterface): Promise<void> {
  const { host, store } = state;
  if (!host || !store || state.syncing) return;
  state.syncing = true;
  const byId = new Map(state.sessions.map((s) => [s.id, s]));
  try {
    await sync(store, host, (s) => {
      byId.set(s.id, s);
      state.sessions = [...byId.values()].sort((a, b) => b.lastActive - a.lastActive);
      $.ui.invalidate("ui.render");
    }, { refresh: state.refresh });
    pruneMeta(state.meta, state.sessions);
    await saveMeta(store, state.meta);
  } catch {
    /* a stale row beats a broken pane */
  } finally {
    state.syncing = false;
    $.ui.invalidate("ui.render");
  }
}

/**
 * Resuming is the one thing this mod cannot do for itself.
 *
 * `$.process.run` captures a child's output and never hands it the terminal, so
 * shelling out to `claude --resume` does not switch you to anything — it starts
 * a headless second session and blocks until the timeout. `$.command.run` is the
 * right shape (it runs a slash command as if you typed it) but a probe of all 70
 * commands in a session found no `/resume` among them, so the call is attempted
 * and its rejection is expected rather than exceptional.
 *
 * Until the surface offers a way to switch sessions, the honest fallback is to
 * hand you the command — with the cwd, because a session belongs to a directory
 * and resuming one from another project without it drops you in the wrong repo.
 */
async function resume($: EngineInterface, s: Session): Promise<void> {
  await $.ui.close({ id: PANE_ID }).catch(() => undefined);
  state.isOpen = false;
  try {
    await $.command.run({ command: "resume", args: s.id });
  } catch {
    $.ui.log(resumeCommand(state.isWindows, s.projectPath, s.id));
  }
}

export function register(on: On, options: PluginOptions) {
  // What the manifest's `userConfig` declares, as the person set it in
  // /config. The ordered fallback below still applies: a name they chose that
  // a built-in already owns costs them that candidate, not the mod.
  const chosen = typeof options.commandName === "string" ? options.commandName : null;
  const refreshCount = typeof options.refresh === "number" ? options.refresh : undefined;


  on("session.start", async ($, e, next) => {
    // The plugin doesn't know where home is; the engine does. Windows sets
    // USERPROFILE and often leaves HOME unset.
    const home = String((await $.env.get("HOME").catch(() => undefined))
      ?? (await $.env.get("USERPROFILE").catch(() => undefined)) ?? "");
    const isWindows = (await $.env.get("OS").catch(() => undefined)) === "Windows_NT";
    state.isWindows = isWindows;
    if (home) {
      // Built here, not imported: `$` is only ever followed into a function
      // declared in the same file, so the engine-side Host is spelled inline.
      const root = `${home}/${PROJECTS}`;
      const namesDir = `${home}/${SESSIONS}`;
      const run = async (argv: string[]): Promise<string> => {
        const { exitCode, stdout } = await $.process.run(argv, { timeoutMs: 30_000 });
        return exitCode === 0 ? stdout : "";
      };

      // One-entry memo: a scan calls linesFrom repeatedly on the same file, and
      // the $.fs.read path would otherwise re-read it whole each time.
      let memoPath = "";
      let memoLines: string[] | null = null;

      /** The whole file as lines, or null when it is too big for $.fs.read. */
      const wholeFile = async (path: string): Promise<string[] | null> => {
        if (memoPath === path) return memoLines;
        memoPath = path;
        memoLines = null;
        try {
          const text = await $.fs.read(path);
          memoLines = typeof text === "string" ? text.split("\n").filter(Boolean) : null;
        } catch {
          memoLines = null;   // over 4 MiB, or unreadable — the tools take it
        }
        return memoLines;
      };

      state.host = {
        async list(): Promise<FileInfo[]> {
          const out: FileInfo[] = [];
          for (const dir of await $.fs.list(root).catch(() => [])) {
            if (dir.kind !== "dir") continue;
            // One level deep only: sub-agent transcripts sit in <id>/subagents/
            // and are somebody else's session.
            for (const f of await $.fs.list(`${root}/${dir.name}`).catch(() => [])) {
              if (f.kind !== "file" || !f.name.endsWith(".jsonl")) continue;
              const path = `${root}/${dir.name}/${f.name}`;
              const st = await $.fs.stat(path).catch(() => null);
              if (st) out.push({ path, size: st.size, mtimeMs: st.mtimeMs });
            }
          }
          return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
        },

        async names() {
          const out: Record<string, string> = {};
          const files = await $.fs.list(namesDir).catch(() => []);
          // Vendor-internal and undocumented: any failure here must degrade to
          // "no names found", never break the listing.
          for (const f of files) {
            if (f.kind !== "file" || !f.name.endsWith(".json")) continue;
            try {
              const raw = await $.fs.read(`${namesDir}/${f.name}`);
              const d = JSON.parse(typeof raw === "string" ? raw : "{}") as Record<string, unknown>;
              const id = d["sessionId"], name = d["name"];
              if (typeof id === "string" && typeof name === "string" && name
                  && d["nameSource"] !== "derived") out[id] = name;
            } catch { /* not ours to understand */ }
          }
          return out;
        },

        async linesFrom(path, from, max) {
          const all = await wholeFile(path);
          if (all) {
            // The common case: no subprocess, nothing platform-specific.
            return { lines: all.slice(from - 1, from - 1 + max), sawBytes: from - 1 < all.length };
          }
          const stdout = await run(rangeArgv(isWindows, path, from, max));
          // Measured: the engine cuts stdout at 4 MiB. wholeLines drops the
          // partial tail, and `sawBytes` lets the scanner recognise the one
          // case that cut hides — a single line bigger than the whole limit.
          return { lines: wholeLines(stdout + "\n"), sawBytes: stdout.length > 0 };
        },

        async sample(path, lines, end) {
          const all = await wholeFile(path);
          if (all) return end === "head" ? all.slice(0, lines) : all.slice(-lines);
          return wholeLines(await run(sampleArgv(isWindows, path, lines, end)) + "\n");
        },
      };

      state.store = {
        get: (key) => $.store.get(key),
        set: (key, value) => $.store.set(key, value),
      };
      const config = await loadConfig(state.store);
      state.refresh = refreshCount ?? config.refresh;
      state.commandName = await registerFirst(
        (spec) => $.command.register(spec),
        chosen ? [chosen, ...config.commands] : config.commands,
        // immediate: tagging is worth doing the moment you think of it, not
        // after the turn you're watching finishes.
        { description: DESCRIPTION, argumentHint: ARGUMENT_HINT, immediate: true },
      );
      // Every candidate taken is survivable: the pane's own hotkeys still work
      // once it is open, and a later release may free one up.
      if (!state.commandName) $.ui.log("session-switcher: no command name was free; open it from /help.");
    }
    return next(e);
  });

  on("command.run", { command: DEFAULTS.commands }, async ($, e, next) => {
    const { host, store } = state;
    if (!host || !store || e.command !== state.commandName) return next(e);

    // `/switcher #wip #mods` tags the session you're in and stays out of the
    // way — no pane, no picking your own row out of a list.
    const args = e.args.trim();
    if (args === "help" || args === "?" || args === "--help") return { text: HELP };
    if (args) {
      const id = await $.session.id();
      const [sessions, meta] = await Promise.all([cachedSessions(store, host), loadMeta(store)]);
      const self = sessions.find((x) => x.id === id) ?? null;
      const saved = mergeMeta(id, self, meta, args);
      await saveMeta(store, meta);
      state.meta = meta;
      const tags = saved.tags.length ? saved.tags.map((t) => "#" + t).join(" ") : "no tags";
      return { text: saved.title ? `${tags} · “${saved.title}”` : tags };
    }

    if (state.isOpen) {
      await $.ui.close({ id: PANE_ID }).catch(() => undefined);
      return { text: "Sessions closed." };
    }

    // Opens on the cached index — no transcript is read — then fills in.
    [state.sessions, state.meta] = await Promise.all([cachedSessions(store, host), loadMeta(store)]);
    state.query = "";
    state.page = 0;
    state.mode = "resume";
    state.editing = null;

    // Two lines a row, plus the header, the filter and the controls — asked
    // for explicitly so the list doesn't overflow and scroll its own chrome
    // out of view.
    await $.ui.open({ id: PANE_ID, title: PANE_TITLE, focus: true, closeOnEscape: true, rows: PAGE * 2 + 4 });
    state.isOpen = true;
    void refresh($);
    return {};
  });

  on("ui.render", { component: "Pane" }, async ($, e, next) => {
    if (e.requestId !== PANE_ID) return next(e);
    const table = await $.ui.resolve(e);
    // Element tables differ by surface — one without `Input` still gets rows.
    const { Box, Text, Button } = table;
    const Input = "Input" in table ? table.Input : undefined;

    const actions: Actions = {
      filter: (value) => { state.query = value; state.page = 0; $.ui.invalidate("ui.render"); },
      turnPage: (by) => { state.page = Math.max(0, state.page + by); $.ui.invalidate("ui.render"); },
      toggleMode: () => { state.mode = state.mode === "tag" ? "resume" : "tag"; $.ui.invalidate("ui.render"); },
      pick: (id) => {
        const s = state.sessions.find((x) => x.id === id);
        if (!s) return;
        if (state.mode === "tag") {
          const m = metaFor(s, state.meta);
          state.editing = { id, text: [m?.title, ...(m?.tags ?? []).map((t) => "#" + t)].filter(Boolean).join(" ") };
          return $.ui.invalidate("ui.render");
        }
        void resume($, s);
      },
      editTags: (value) => {
        const s = state.editing && state.sessions.find((x) => x.id === state.editing!.id);
        if (s && state.store) { setMeta(s, state.meta, value); void saveMeta(state.store, state.meta); }
        state.editing = null;
        state.mode = "resume";
        $.ui.invalidate("ui.render");
      },
    };

    return view({ Box, Text, Button, Input }, model(), actions);
  });

  on("ui.close", { id: PANE_ID }, async ($, e, next) => {
    state.isOpen = false;
    state.editing = null;
    return next(e);
  });

}

export { PAGE };

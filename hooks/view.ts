// The switcher's drawing. One memorable element: each row carries a 24-cell
// activity strip showing *when* in its life the session was busy, so a
// burst-then-idle debugging session looks different from a steady refactor.
//
// This is a pure function — element constructors in, tree out — so it can be
// tested without an engine. The constructors come from the surface's table
// (`$.ui.resolve(e)`), not from ink or react: the same view draws on the
// terminal, the desktop, VS Code and mobile.
//
// Interaction is built from what the element table actually offers. There is
// no raw key handler, so:
//   · the filter is an `Input` (every printable key reaches it while focused)
//   · each of the ten rows on a page is a `Button` with a digit hotkey — the
//     page size and the single-digit hotkeys fit each other exactly
//   · `t` flips to tag mode, where a row's digit opens its tag field instead
//     of resuming it; `n` / `p` page; Escape closes the pane
import type {
  BoxProps, ButtonProps, ElementConstructor, InputProps, RenderElement, TextProps,
} from "claude-code";
import type { Session } from "./scan.ts";
import type { Meta } from "./tags.ts";
import { metaFor } from "./tags.ts";

export const PAGE = 10;
// Sixteen cells, not twenty-four: the strip sits left of every title, so its
// width is a left margin on the whole list. Empty cells are a dot rather than
// a space — a session with one busy minute should read as a shape with one
// mark in it, not as a lone block floating in blank space.
const CELLS = 16;
const BLOCKS = "·▁▂▃▄▅▆▇█";
// Project colours are hashed, so the same repo is always the same hue.
const HUES = ["#7aa2f7", "#9ece6a", "#e0af68", "#bb9af7", "#7dcfff", "#f7768e", "#73daca", "#ff9e64"];
const HOTKEYS = "1234567890";
// Where a row's second line starts: under the title, past the strip and the
// "N: " a plain Button draws.
const INDENT = CELLS + 4;

export type Model = {
  sessions: Session[];
  meta: Record<string, Meta>;
  query: string;
  page: number;
  mode: "resume" | "tag";
  editing: { id: string; text: string } | null;
  syncing: boolean;
};

export type Actions = {
  filter: (value: string) => void;
  pick: (id: string) => void;
  toggleMode: () => void;
  turnPage: (by: number) => void;
  editTags: (value: string) => void;
};

/**
 * Only the elements this view draws; the table has more. `Input` is optional
 * on purpose: not every surface's table offers one, and a switcher that can't
 * take typing should still draw its rows rather than not draw at all.
 */
export type Elements = {
  Box: ElementConstructor<BoxProps>;
  Text: ElementConstructor<TextProps>;
  Button: ElementConstructor<ButtonProps>;
  Input?: ElementConstructor<InputProps> | undefined;
};

export function matches(s: Session, meta: Record<string, Meta>, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const m = metaFor(s, meta);
  const hay = [m?.title, s.title, s.firstPrompt, s.project, s.branch, ...(m?.tags ?? []).map((t) => "#" + t)]
    .join(" ").toLowerCase();
  return words.every((w) => hay.includes(w));
}

export function view(ui: Elements, model: Model, actions: Actions): RenderElement {
  const { Box, Text, Button, Input } = ui;
  const rows = model.sessions.filter((s) => matches(s, model.meta, model.query));
  const pages = Math.max(1, Math.ceil(rows.length / PAGE));
  // Clamped: a filter that shrinks the list must not strand the view on a
  // page that no longer exists.
  const page = Math.min(Math.max(0, model.page), pages - 1);
  const visible = rows.slice(page * PAGE, page * PAGE + PAGE);

  const header = Box({
    justifyContent: "space-between",
    children: [
      Text({ bold: true, children: model.mode === "tag" ? "Sessions — tag which?" : "Sessions" }),
      Text({ dimColor: true, children: `${rows.length} found  page ${page + 1}/${pages}${model.syncing ? "  indexing…" : ""}` }),
    ],
  });

  const filter = Input ? Input({
    key: "filter",
    // No label: the surface draws its own separator after one, so "› " came
    // out as "› :".
    placeholder: "filter by title, project, branch or #tag",
    value: model.query,
    submitLabel: "filter",
    autoFocus: true,
    onInput: (value: string) => actions.filter(value),
    onSubmit: (value: string) => actions.filter(value),
  }) : Text({ dimColor: true, children: model.query ? `filter: ${model.query}` : "filter unavailable on this surface" });

  const body = visible.length === 0
    ? [Text({ dimColor: true, children: `No sessions match “${model.query}”. Clear the filter to see them all.` })]
    : visible.map((s, i) => row(ui, s, model, actions, HOTKEYS[i] ?? ""));

  const editor = model.editing && Input
    ? Input({
        key: "tags",
        label: "Tag or rename",
        placeholder: "#wip #mods  or a new title  or both",
        value: model.editing.text,
        submitLabel: "save",
        autoFocus: true,
        onInput: () => {},
        onSubmit: (value: string) => actions.editTags(value),
      })
    : Box({
        marginTop: 1,
        gap: 2,
        children: [
          Button({ key: "mode", hotkey: "t", plain: true, dimColor: true,
                   label: model.mode === "tag" ? "resume mode" : "tag a session",
                   onPress: () => actions.toggleMode() }),
          Button({ key: "prev", hotkey: "p", plain: true, dimColor: true, label: "prev",
                   onPress: () => actions.turnPage(-1) }),
          Button({ key: "next", hotkey: "n", plain: true, dimColor: true, label: "next",
                   onPress: () => actions.turnPage(1) }),
          Text({ dimColor: true, children: "Esc close" }),
          Text({ dimColor: true, children: "· /switcher #tag tags this session" }),
        ],
      });

  return Box({
    flexDirection: "column",
    paddingX: 1,
    children: [header, Box({ marginBottom: 1, children: [filter] }), ...body, editor],
  });
}

function row(ui: Elements, s: Session, model: Model, actions: Actions, hotkey: string): RenderElement {
  const { Box, Text, Button } = ui;
  const m = metaFor(s, model.meta);
  const colour = hue(s.project);
  const isEditing = model.editing?.id === s.id;

  return Box({
    key: s.id,
    flexDirection: "column",
    marginBottom: isEditing ? 1 : 0,
    children: [
      Box({
        children: [
          Text({ color: colour, children: spark(s.activity) + " " }),
          Box({
            flexGrow: 1,
            children: [
              Button({
                key: `row:${s.id}`,
                hotkey,
                plain: true,
                label: m?.title ?? s.title,
                onPress: () => actions.pick(s.id),
              }),
            ],
          }),
          Text({ dimColor: true, children: " " + ago(s.lastActive) }),
        ],
      }),
      // One meta line, not three. Ten rows have to fit the pane alongside the
      // filter and the controls, and the opening prompt is still searchable
      // whether or not it is drawn.
      // When the line is wider than the pane, every child gets squeezed, and a
      // squeezed Text wraps inside its own narrow column — "Projects" came out
      // as "Project" over "s", and a long branch interleaved with the project.
      // So the project and tags never shrink, and the branch truncates instead.
      Box({
        marginLeft: INDENT,
        children: [
          Box({ flexShrink: 0, children: [Text({ color: colour, children: s.project })] }),
          ...(s.branch ? [Text({ dimColor: true, wrap: "truncate-end", children: ` on ${s.branch}` })] : []),
          Text({ dimColor: true, wrap: "truncate-end",
                 children: ` · ${s.prompts} ${s.prompts === 1 ? "prompt" : "prompts"}`
                   + (s.filesTouched ? `, ${s.filesTouched} files` : "")
                   + (s.partial ? " · sampled" : "") }),
          ...(m?.tags ?? []).map((t) => Box({ flexShrink: 0, children: [Text({ color: "magenta", children: ` #${t}` })] })),
        ],
      }),
    ],
  });
}

export function spark(v: number[], cells = CELLS): string {
  // The index keeps 24 buckets; fold them down to however many the strip draws.
  const per = v.length / cells;
  const folded = Array.from({ length: cells }, (_, i) =>
    v.slice(Math.floor(i * per), Math.max(Math.floor((i + 1) * per), Math.floor(i * per) + 1))
     .reduce((a, b) => a + b, 0));
  const max = Math.max(...folded, 1);
  return folded.map((x) => (x ? BLOCKS[Math.max(1, Math.round((x / max) * 8))] ?? "█" : BLOCKS[0]!)).join("");
}

export const hue = (s: string): string =>
  HUES[[...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % HUES.length] ?? HUES[0]!;

export function ago(t: number, now = Date.now()): string {
  const m = Math.round((now - t) / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  return d < 30 ? `${d}d` : new Date(t).toISOString().slice(0, 10);
}

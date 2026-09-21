// The switcher UI. One memorable element: each row carries a 24-cell
// activity strip showing *when* in its life the session was busy, so a
// burst-then-idle debugging session looks different from a steady refactor.
import React, { useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { Session } from "./sessions.ts";
import { metaFor, type Meta } from "./tags.ts";

const PAGE = 10;
const BLOCKS = " ▁▂▃▄▅▆▇█";
// Project colours are hashed, so the same repo is always the same hue.
const HUES = ["#7aa2f7", "#9ece6a", "#e0af68", "#bb9af7", "#7dcfff", "#f7768e", "#73daca", "#ff9e64"];
const hue = (s: string) =>
  HUES[[...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % HUES.length] ?? HUES[0]!;

export function SessionList(props: {
  sessions: Session[];
  meta: Record<string, Meta>;
  onResume: (id: string) => void;
  onEdit: (session: Session, input: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const [editing, setEditing] = useState<string | null>(null);

  const rows = useMemo(() => {
    const q = query.toLowerCase().split(/\s+/).filter(Boolean);
    return props.sessions.filter((s) => {
      const m = metaFor(s, props.meta);
      const hay = [m?.title, s.title, s.firstPrompt, s.project, s.branch, ...(m?.tags ?? []).map((t) => "#" + t)]
        .join(" ").toLowerCase();
      return q.every((w) => hay.includes(w));
    });
  }, [query, props.sessions, props.meta]);

  const pages = Math.max(1, Math.ceil(rows.length / PAGE));
  const page = Math.floor(cursor / PAGE);
  const visible = rows.slice(page * PAGE, page * PAGE + PAGE);
  const selected = rows[cursor];

  useInput((ch, key) => {
    if (editing !== null) {
      if (key.return) { selected && props.onEdit(selected, editing); setEditing(null); }
      else if (key.escape) setEditing(null);
      else if (key.backspace || key.delete) setEditing(editing.slice(0, -1));
      // Arrow keys and friends arrive with `ch` set to their escape sequence;
      // without this guard they get typed into the title you're writing.
      else if (ch && printable(ch, key)) setEditing(editing + ch);
      return;
    }
    // Clamped at 0: with no matching rows, `rows.length - 1` is -1, which
    // drives `page` negative and silently blanks the list.
    const to = (i: number) => setCursor(Math.max(0, Math.min(rows.length - 1, i)));
    if (key.escape) return query ? setQuery("") : props.onClose();
    // Enter and Tab return unconditionally — falling through on an empty
    // result set appends "\r" / "\t" to the filter.
    if (key.return) return void (selected && props.onResume(selected.id));
    if (key.downArrow) return to(cursor + 1);
    if (key.upArrow) return to(cursor - 1);
    if (key.rightArrow || key.pageDown) return to((page + 1) * PAGE);
    if (key.leftArrow || key.pageUp) return to((page - 1) * PAGE);
    if (key.tab) {
      if (!selected) return;
      const m = metaFor(selected, props.meta);
      return setEditing([m?.title, ...(m?.tags ?? []).map((t) => "#" + t)].filter(Boolean).join(" "));
    }
    if (key.backspace || key.delete) { setQuery(query.slice(0, -1)); return setCursor(0); }
    if (ch && printable(ch, key)) { setQuery(query + ch); setCursor(0); }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
      <Box justifyContent="space-between">
        <Text bold>Sessions</Text>
        <Text dimColor>{rows.length} found  page {page + 1}/{pages}</Text>
      </Box>
      <Box marginBottom={1}>
        <Text color="cyan">› </Text>
        <Text>{query || <Text dimColor>type to filter by title, project, branch or #tag</Text>}</Text>
      </Box>

      {visible.length === 0 && <Text dimColor>No sessions match “{query}”. Press Esc to clear the filter.</Text>}

      {visible.map((s, i) => {
        const on = page * PAGE + i === cursor;
        const m = metaFor(s, props.meta);
        return (
          <Box key={s.id} flexDirection="column" marginBottom={on ? 1 : 0}>
            <Box>
              <Text color={on ? "cyan" : "gray"}>{on ? "▌" : " "} </Text>
              <Text color={hue(s.project)}>{spark(s.activity)} </Text>
              <Box flexGrow={1}>
                <Text bold={on} wrap="truncate-end">{m?.title ?? s.title}</Text>
              </Box>
              <Text dimColor> {ago(s.lastActive)}</Text>
            </Box>
            <Box marginLeft={27}>
              <Text color={hue(s.project)}>{s.project}</Text>
              {s.branch && <Text dimColor> on {s.branch}</Text>}
              {(m?.tags ?? []).map((t) => <Text key={t} color="magenta"> #{t}</Text>)}
            </Box>
            {on && (
              <Box marginLeft={27} flexDirection="column">
                {s.firstPrompt && s.firstPrompt !== s.title &&
                  <Text dimColor wrap="truncate-end">“{s.firstPrompt}”</Text>}
                <Text dimColor>
                  {s.prompts} prompts, {s.filesTouched} files edited
                  {s.partial && " · large session, showing a sampled window"}
                </Text>
              </Box>
            )}
          </Box>
        );
      })}

      {editing !== null ? (
        <Box marginTop={1}>
          <Text color="magenta">Rename or tag › </Text><Text>{editing}</Text><Text inverse> </Text>
        </Box>
      ) : (
        <Box marginTop={1}>
          <Text dimColor>↑↓ move  ←→ page  Enter resume  Tab rename/tag  Esc close</Text>
        </Box>
      )}
    </Box>
  );
}

// Ink reports arrows, function keys and modifier chords with `input` set to
// their raw escape sequence; only accept characters a person meant to type.
function printable(ch: string, key: { ctrl?: boolean; meta?: boolean }) {
  return !key.ctrl && !key.meta && ch.length === 1 && ch >= " " && ch !== "\u007f";
}

function spark(v: number[]) {
  const max = Math.max(...v, 1);
  return v.map((x) => BLOCKS[x ? Math.max(1, Math.round((x / max) * 8)) : 0] ?? " ").join("");
}

function ago(t: number) {
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  return d < 30 ? `${d}d` : new Date(t).toLocaleDateString();
}

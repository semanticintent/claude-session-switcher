// Tags and custom titles — the part Claude Code genuinely doesn't have.
// (It does have session *names*: `~/.claude/sessions/*.json` carries a
// user-set `name` with a `nameSource`, and `nameSource: "derived"` marks
// the CLI's own auto-slug rather than something you chose. Tags, and
// searching by them, are ours.)
//
// The trap this file exists to avoid: resuming a session mints a NEW
// session id, so metadata keyed only by id is orphaned the moment you use
// the session you just tagged. Every record therefore also carries a
// fingerprint — project + opening prompt, which survive a resume — and
// lookup falls back to it.
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { HOME_DIR, saveJson } from "./cache.ts";
import type { Session } from "./sessions.ts";

export type Meta = { title?: string | undefined; tags: string[]; fp?: string | undefined };

const FILE = join(HOME_DIR, "meta.json");

export const fingerprint = (s: Session) =>
  createHash("sha1").update(`${s.projectPath}\u0000${s.firstPrompt.slice(0, 200)}`).digest("hex").slice(0, 16);

export async function loadMeta(): Promise<Record<string, Meta>> {
  try { return JSON.parse(await readFile(FILE, "utf8")); } catch { return {}; }
}

export const saveMeta = (all: Record<string, Meta>) => saveJson(FILE, all);

/** By id, else by fingerprint — so a resumed session keeps its tags. */
export function metaFor(s: Session, all: Record<string, Meta>): Meta | undefined {
  const direct = all[s.id];
  if (direct) return direct;
  const fp = fingerprint(s);
  for (const m of Object.values(all)) if (m.fp === fp) return m;
  return undefined;
}

export function setMeta(s: Session, all: Record<string, Meta>, input: string) {
  const parsed = parseEdit(input);
  all[s.id] = { ...parsed, fp: fingerprint(s) };
}

/** Drops records for sessions that no longer exist, so this can't grow forever. */
export function pruneMeta(all: Record<string, Meta>, sessions: Session[]) {
  const live = new Set(sessions.map((s) => s.id));
  const fps = new Set(sessions.map(fingerprint));
  for (const [id, m] of Object.entries(all))
    if (!live.has(id) && !(m.fp && fps.has(m.fp))) delete all[id];
}

// "#auth #urgent Rename to this" → tags + optional title
export function parseEdit(input: string): Meta {
  const tags = [...input.matchAll(/#([\w-]+)/g)].map((m) => (m[1] ?? "").toLowerCase()).filter(Boolean);
  const title = input.replace(/#[\w-]+/g, "").trim() || undefined;
  return { title, tags: [...new Set(tags)] };
}

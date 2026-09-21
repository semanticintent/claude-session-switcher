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
import type { Store } from "./host.ts";
import type { Session } from "./scan.ts";

export const META_KEY = "session-meta";

export type Meta = { title?: string | undefined; tags: string[]; fp?: string | undefined };

// No node:crypto in a hooks environment, and none needed: this only has to
// tell two sessions apart, not resist anybody.
export function fingerprint(s: Session): string {
  const text = `${s.projectPath}\u0000${s.firstPrompt.slice(0, 200)}`;
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36) + ":" + text.length.toString(36);
}

export async function loadMeta(store: Store): Promise<Record<string, Meta>> {
  return ((await store.get(META_KEY).catch(() => null)) ?? {}) as Record<string, Meta>;
}

export const saveMeta = (store: Store, all: Record<string, Meta>) =>
  store.set(META_KEY, all).catch(() => undefined);

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

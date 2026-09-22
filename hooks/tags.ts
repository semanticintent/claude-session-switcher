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

/**
 * Folds `input` into what a session already carries, rather than replacing it.
 *
 * This is what `/switcher #wip` does from inside a session, where replacing
 * would be wrong: tagging a session you're in the middle of shouldn't silently
 * drop the title you gave it this morning. Tags add, `-#tag` removes, and a
 * title is only overwritten when you actually type one.
 *
 * `session` is null for a session too new to have reached the index yet — its
 * tags are still keyed by id, just without a fingerprint to carry them across
 * a resume until the next index pass.
 */
export function mergeMeta(
  id: string,
  session: Session | null,
  all: Record<string, Meta>,
  input: string,
): Meta {
  const existing = (session ? metaFor(session, all) : all[id]) ?? { tags: [] };
  const removed = [...input.matchAll(/-#([\w-]+)/g)].map((m) => (m[1] ?? "").toLowerCase());
  const parsed = parseEdit(input.replace(/-#[\w-]+/g, " "));
  const tags = [...new Set([...existing.tags, ...parsed.tags])].filter((t) => !removed.includes(t));
  const meta: Meta = { title: parsed.title ?? existing.title, tags };
  if (session) meta.fp = fingerprint(session);
  all[id] = meta;
  return meta;
}

/** Drops records for sessions that no longer exist, so this can't grow forever. */
export function pruneMeta(all: Record<string, Meta>, sessions: Session[]) {
  const live = new Set(sessions.map((s) => s.id));
  const fps = new Set(sessions.map(fingerprint));
  for (const [id, m] of Object.entries(all))
    if (!live.has(id) && !(m.fp && fps.has(m.fp))) delete all[id];
}

// "#auth #urgent Rename to this" → tags + optional title.
//
// `+#auth` is accepted as sugar for `#auth`: removal has to be marked, so `-#x`
// exists, and once it does the symmetric `+#x` is the form people reach for.
// Requiring it would be worse — `#wip` is what you type without thinking — so
// both work and the sign is simply dropped here.
export function parseEdit(input: string): Meta {
  const text = input.replace(/[-+]#/g, "#");
  const tags = [...text.matchAll(/#([\w-]+)/g)].map((m) => (m[1] ?? "").toLowerCase()).filter(Boolean);
  const title = text.replace(/#[\w-]+/g, "").trim() || undefined;
  return { title, tags: [...new Set(tags)] };
}

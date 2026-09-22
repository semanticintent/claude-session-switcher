// Everything a future Claude Code release could collide with lives here.
//
// `/sessions` is exactly the kind of generic name the CLI is likely to claim
// for itself — it already ships `--resume` with a searchable picker, and a
// `/sessions` command is a short walk from that. So the mod does not hard-code
// one name: it asks for several, in order, and keeps the first that registers.
// The bare `/sessions` is last, tried only if nothing owns it.
//
// Precedent worth following: plugin-provided skills are addressed as
// `plugin:skill`. If Mods namespace commands the same way, the qualified name
// below is the one that can never collide, and the short aliases are a
// convenience the CLI is free to take back.
import type { Store } from "./host.ts";

export const CONFIG_KEY = "session-switcher-config";

export type Config = {
  /** Tried in order; the first that registers wins. */
  commands: string[];
  /** Files opened per refresh before the rest are left to the cache. */
  refresh: number;
};

export const DEFAULTS: Config = {
  // Qualified first, short aliases after, generic last.
  commands: ["session-switcher:sessions", "switcher", "sessions"],
  refresh: 40,
};

export async function loadConfig(store: Store): Promise<Config> {
  try {
    const raw = ((await store.get(CONFIG_KEY)) ?? {}) as Partial<Config>;
    return {
      commands: Array.isArray(raw.commands) && raw.commands.length ? raw.commands : DEFAULTS.commands,
      refresh: Number.isFinite(raw.refresh) ? Number(raw.refresh) : DEFAULTS.refresh,
    };
  } catch {
    return DEFAULTS;
  }
}

/**
 * Registers the first candidate the engine accepts.
 *
 * `registerCommand` throws when a name is already spoken for — this is the
 * documented way a mod finds out, and Anthropic's own `diff` mod does exactly
 * this to cede `/diff` to the built-in "once the built-in stands down". So a
 * taken name costs us that candidate, not the mod.
 *
 * There is no fallback beneath the last candidate: the surface gives a mod no
 * way to bind a chord of its own, so a command name is the only way in.
 */
export type Spec = {
  name: string;
  description: string;
  argumentHint?: string;
  immediate?: true;
};

export async function registerFirst(
  register: (spec: Spec) => Promise<unknown>,
  candidates: string[],
  spec: Omit<Spec, "name">,
): Promise<string | null> {
  for (const name of candidates) {
    try {
      await register({ ...spec, name });
      return name;
    } catch {
      /* taken, or refused — try the next one */
    }
  }
  return null;
}

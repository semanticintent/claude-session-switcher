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
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { HOME_DIR } from "./cache.ts";

export type Config = {
  /** Tried in order; the first that registers wins. */
  commands: string[];
  /** Fallback that never depends on a command name being free. */
  keybinding: string;
  /** Files opened per refresh before the rest are left to the cache. */
  refresh: number;
};

export const DEFAULTS: Config = {
  // Qualified first, short aliases after, generic last.
  commands: ["session-switcher:sessions", "switcher", "sessions"],
  // Not ctrl+o — the CLI uses that to expand output.
  keybinding: "ctrl+g",
  refresh: 40,
};

export async function loadConfig(): Promise<Config> {
  try {
    const raw = JSON.parse(await readFile(join(HOME_DIR, "config.json"), "utf8")) as Partial<Config>;
    return {
      commands: Array.isArray(raw.commands) && raw.commands.length ? raw.commands : DEFAULTS.commands,
      keybinding: typeof raw.keybinding === "string" ? raw.keybinding : DEFAULTS.keybinding,
      refresh: Number.isFinite(raw.refresh) ? Number(raw.refresh) : DEFAULTS.refresh,
    };
  } catch {
    return DEFAULTS;
  }
}

/**
 * Registers the first candidate the host accepts. A name already taken should
 * make *that* registration fail, not the mod — and if every candidate is
 * spoken for, the keybinding still works, so the switcher degrades instead of
 * disappearing.
 */
export function registerFirst(
  hook: (event: string, handler: any) => void,
  candidates: string[],
  handler: any,
): string | null {
  for (const name of candidates) {
    try {
      hook(`command:/${name}`, handler);
      return name;
    } catch {
      /* taken, or unsupported — try the next one */
    }
  }
  return null;
}

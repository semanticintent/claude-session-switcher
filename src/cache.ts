// The session index: one record per transcript file, cached on disk so the
// switcher never re-reads a file whose bytes haven't changed.
//
// Borrowed wholesale from trailant's indexer: stat() every known file on
// every open (cheap even at thousands of files) and only re-read one whose
// mtime or size moved. INDEX_VERSION forces a re-parse when the extraction
// logic below changes — otherwise the cache happily serves stale titles
// forever, since nothing about the source file itself changed.
//
// Writes live outside ~/.claude on purpose (that tree is off-limits per the
// user's own rules); change HOME_DIR alone to move them.
import { readFile, rename, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

export const INDEX_VERSION = 1;

export const HOME_DIR = process.env.SESSION_SWITCHER_HOME || join(homedir(), ".config", "claude-session-switcher");
const INDEX_FILE = join(HOME_DIR, "index.json");

export type Entry = {
  v: number;
  path: string;
  size: number;        // bytes of complete lines already folded into this record
  mtimeMs: number;
  id: string;
  aiTitle?: string | undefined;    // last `type:"ai-title"` record wins — they regenerate mid-session
  summary?: string | undefined;    // legacy fallback; real transcripts have none
  firstPrompt?: string | undefined;
  cwd?: string | undefined;
  branch?: string | undefined;
  prompts: number;     // human turns, not every timestamped line
  files: string[];     // distinct file_path values seen in Edit/Write tool calls
  bins: Record<string, number>;  // wall-clock activity histogram, sparse
  firstTs?: number | undefined;
  lastTs?: number | undefined;
  partial: boolean;    // a huge file we sampled head+tail rather than read whole
};

export async function loadIndex(): Promise<Record<string, Entry>> {
  try {
    const all = JSON.parse(await readFile(INDEX_FILE, "utf8")) as Record<string, Entry>;
    // Drop anything written by an older extractor rather than trusting it.
    for (const [k, e] of Object.entries(all)) if (e?.v !== INDEX_VERSION) delete all[k];
    return all;
  } catch {
    return {};
  }
}

// Written temp-then-rename: a crash mid-write must not leave a truncated
// index (or, for tags.ts which reuses this, a truncated set of your tags).
export async function saveJson(file: string, data: unknown) {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(data));
  await rename(tmp, file);
}

export const saveIndex = (all: Record<string, Entry>) => saveJson(INDEX_FILE, all);

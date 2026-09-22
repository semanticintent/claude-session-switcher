// Turns ~/.claude/projects/<slug>/<session>.jsonl into one row per session,
// cheaply enough to run on a 400 MB transcript store.
//
// Three things keep it light:
//   1. stat-first. Files are ranked by mtime and only the newest are ever
//      opened; everything else is served from the cached index.
//   2. Append-only reads. Transcripts only grow, so a file that gained 40
//      lines is read from line `cached.lines + 1`, not line 1.
//   3. No JSON.parse in the hot loop. Every field the row needs is pulled
//      with a regex over the raw line; the only line ever parsed is the
//      single first user prompt. Attachment and tool-output lines — the
//      bulk of the bytes — are matched and discarded without being decoded.
//
// Nothing here touches the file system directly: see hooks/host.ts.
import type { Host, Store, FileInfo } from "./host.ts";

export const INDEX_VERSION = 3;
export const INDEX_KEY = "session-index";

const BIN_MS = 5 * 60_000;              // activity histogram resolution
const HEAD_BYTES = 256 * 1024;          // enough for the opening prompt + cwd + branch
const TAIL_BYTES = 1024 * 1024;         // enough for the latest ai-title + last activity
const FULL_SCAN_MAX = 8 * 1024 * 1024;  // above this, sample head+tail instead
const LINES_PER_READ = 5_000;           // bounded: stdout is cut at 4 MiB (measured)
const READS_PER_FILE = 8;               // …so a huge delta catches up over a few opens
const FILES_CAP = 200;                  // stop collecting distinct edited paths here

export type Entry = {
  v: number;
  path: string;
  lines: number;       // complete lines already folded into this record
  size: number;
  mtimeMs: number;
  id: string;
  aiTitle?: string | undefined;   // newest wins — titles regenerate mid-session
  summary?: string | undefined;   // legacy fallback; real transcripts have none
  firstPrompt?: string | undefined;
  wrapperPrompt?: string | undefined;  // first user turn even when it was a wrapper
  cwd?: string | undefined;
  branch?: string | undefined;
  prompts: number;     // human turns, not every timestamped line
  files: string[];     // distinct file_path values seen in Edit/Write tool calls
  bins: Record<string, number>;   // wall-clock activity histogram, sparse
  firstTs?: number | undefined;
  lastTs?: number | undefined;
  partial: boolean;    // a huge file we sampled rather than read whole
};

export type Session = {
  id: string;
  title: string;
  firstPrompt: string;
  project: string;        // display name
  projectPath: string;    // full cwd — needed to resume in the right directory
  branch?: string | undefined;
  lastActive: number;
  prompts: number;
  filesTouched: number;
  activity: number[];     // 24 cells over the session's lifetime
  partial: boolean;
};

export async function loadIndex(store: Store): Promise<Record<string, Entry>> {
  const all = ((await store.get(INDEX_KEY).catch(() => null)) ?? {}) as Record<string, Entry>;
  // Drop anything written by an older extractor rather than trusting it.
  for (const [k, e] of Object.entries(all)) if (e?.v !== INDEX_VERSION) delete all[k];
  return all;
}

/** Instant: the cached index only, no transcript is opened. */
export async function cachedSessions(store: Store, host: Host, limit = 200): Promise<Session[]> {
  const [files, index] = await Promise.all([host.list(), loadIndex(store)]);
  return files.slice(0, limit)
    .map((f) => toSession(index[f.path], f))
    .filter((s): s is Session => s !== null);
}

/**
 * Brings the index up to date, newest file first, invoking `onRow` as each one
 * lands so the open pane fills in progressively instead of blocking.
 */
export async function sync(
  store: Store,
  host: Host,
  onRow: (s: Session) => void,
  { refresh = 40 }: { refresh?: number } = {},
): Promise<void> {
  const [files, index] = await Promise.all([host.list(), loadIndex(store)]);
  let touched = 0;
  let opened = 0;

  for (const f of files) {
    const cached = index[f.path];
    if (cached && cached.mtimeMs === f.mtimeMs && cached.size === f.size) continue;
    if (opened++ >= refresh) break;

    const entry = await scan(host, f, cached).catch(() => null);
    if (!entry) continue;
    index[f.path] = entry;
    touched++;
    const row = toSession(entry, f);
    if (row) onRow(row);
  }

  // Forget files that have been deleted, so the index can't grow forever.
  const live = new Set(files.map((f) => f.path));
  for (const k of Object.keys(index)) if (!live.has(k)) { delete index[k]; touched++; }

  if (touched) await store.set(INDEX_KEY, index).catch(() => undefined);
}

async function scan(host: Host, f: FileInfo, cached?: Entry): Promise<Entry> {
  // A file that shrank was rewritten, not appended to — start over.
  const resumable = cached && cached.v === INDEX_VERSION && cached.size <= f.size && !cached.partial;
  const e: Entry = resumable
    ? { ...cached, mtimeMs: f.mtimeMs, size: f.size, files: [...cached.files], bins: { ...cached.bins } }
    : { v: INDEX_VERSION, path: f.path, lines: 0, size: f.size, mtimeMs: f.mtimeMs,
        id: idOf(f.path), prompts: 0, files: [], bins: {}, partial: false };

  if (!resumable && f.size > FULL_SCAN_MAX) {
    // Too big to read whole on first sight: take the opening prompt from the
    // head and recent activity from the tail, and say so in the row.
    for (const line of await host.sample(f.path, HEAD_BYTES, "head")) fold(line, e);
    for (const line of await host.sample(f.path, TAIL_BYTES, "tail")) fold(line, e);
    e.partial = true;
    return e;
  }

  // Bounded per read, because the engine cuts stdout at 4 MiB; a file that
  // gained more than we take catches up over the next few opens.
  //
  // A read that returned bytes but no complete line means one line is larger
  // than the whole limit, so it can never come back whole. Stepping over it
  // costs that record; not stepping over it stalls the file for good.
  for (let i = 0; i < READS_PER_FILE; i++) {
    const { lines, sawBytes } = await host.linesFrom(f.path, e.lines + 1, LINES_PER_READ);
    if (!sawBytes) break;                       // end of file
    if (!lines.length) { e.lines += 1; continue; }  // see below
    for (const line of lines) fold(line, e);
    e.lines += lines.length;
    if (lines.length < LINES_PER_READ) break;
  }
  return e;
}

// Field extractors. Deliberately regex, not JSON.parse: the lines that hold
// most of the bytes (attachments, tool output) are ones we want to skip, and
// decoding them just to throw them away is where the naive version dies.
const RE_TS = /"timestamp":"([^"]+)"/;
const RE_CWD = /"cwd":"((?:[^"\\]|\\.)*)"/;
const RE_BRANCH = /"gitBranch":"((?:[^"\\]|\\.)*)"/;
const RE_AI_TITLE = /"aiTitle":"((?:[^"\\]|\\.)*)"/;
const RE_SUMMARY = /"summary":"((?:[^"\\]|\\.)*)"/;
const RE_EDIT = /"name":"(?:Edit|Write|MultiEdit|NotebookEdit)"[^}]*?"file_path":"((?:[^"\\]|\\.)*)"/g;

export function fold(line: string, e: Entry) {
  const ts = RE_TS.exec(line)?.[1];
  const t = ts ? Date.parse(ts) : NaN;

  if (e.cwd === undefined) { const m = RE_CWD.exec(line)?.[1]; if (m) e.cwd = unescape(m); }
  if (e.branch === undefined) {
    const m = RE_BRANCH.exec(line)?.[1];
    // "HEAD" is what a detached checkout — or a directory that is no repo at
    // all — reports. Drawing "on HEAD" tells you nothing.
    if (m && m !== "HEAD") e.branch = unescape(m);
  }

  if (line.includes('"type":"ai-title"')) {
    // Titles regenerate as a session goes on; the newest is the honest one.
    const m = RE_AI_TITLE.exec(line)?.[1];
    if (m) e.aiTitle = unescape(m);
    return;
  }
  if (line.includes('"type":"summary"')) {
    const m = RE_SUMMARY.exec(line)?.[1];
    if (m) e.summary = unescape(m);
    return;
  }

  const isUser = line.includes('"type":"user"');
  const isAssistant = !isUser && line.includes('"type":"assistant"');
  if (!isUser && !isAssistant) return;   // attachment, queue-operation, last-prompt, …

  // Only user/assistant turns count as activity, which is what the strip is
  // meant to show. Sub-agent chatter is somebody else's session.
  if (line.includes('"isSidechain":true')) return;

  if (!Number.isNaN(t)) {
    if (e.firstTs === undefined || t < e.firstTs) e.firstTs = t;
    if (e.lastTs === undefined || t > e.lastTs) e.lastTs = t;
    const bin = String(Math.floor(t / BIN_MS));
    e.bins[bin] = (e.bins[bin] ?? 0) + 1;
  }

  if (isUser) {
    if (line.includes('"tool_result"')) return;   // a tool's reply, not a human turn
    e.prompts++;
    if (e.firstPrompt === undefined) {
      const text = firstText(line);
      if (text && !isSystemWrapper(text)) e.firstPrompt = clean(text).slice(0, 300);
      // A session whose every turn is a wrapper still deserves better than
      // "Untitled": `clean` strips the tags, and what's inside one is usually
      // the command that ran.
      else if (text && e.wrapperPrompt === undefined) {
        const inner = clean(text).slice(0, 80);
        if (inner) e.wrapperPrompt = inner;
      }
    }
    return;
  }

  if (e.files.length < FILES_CAP && line.includes('"tool_use"')) {
    RE_EDIT.lastIndex = 0;
    for (let m: RegExpExecArray | null; (m = RE_EDIT.exec(line)); ) {
      const p = unescape(m[1] ?? "");
      if (p && !e.files.includes(p)) e.files.push(p);
      if (e.files.length >= FILES_CAP) break;
    }
  }
}

// The one place we decode a line — a single user turn, once per session.
function firstText(line: string): string | undefined {
  if (line.length > 1_000_000) return undefined;
  try {
    const c = (JSON.parse(line) as any)?.message?.content;
    if (typeof c === "string") return c;
    if (Array.isArray(c)) return c.map((b: any) => (typeof b?.text === "string" ? b.text : "")).join(" ");
  } catch { /* malformed line — no prompt from it */ }
  return undefined;
}

// Tags the CLI injects as a literal "user" turn: a slash command's banner, a
// hook's stdout, the IDE's selection, CLAUDE.md reminders. Taking the first
// user record at face value titles half your sessions "<system-reminder>".
// (List lifted from trailant, which learned it against real transcripts.)
const WRAPPERS = ["local-command-caveat", "local-command-stdout", "command-name", "command-message",
  "command-args", "system-reminder", "user-prompt-submit-hook", "ide_selection", "ide_diagnostics",
  "ide_opened_file", "recommended_plugins", "environment_context"];
function isSystemWrapper(text: string): boolean {
  const m = /^<([a-zA-Z][\w-]*)>/.exec(text.trim())?.[1];
  return !!m && WRAPPERS.includes(m);
}

// ---------------------------------------------------------------- rows

export function toSession(e: Entry | undefined, f: FileInfo): Session | null {
  if (!e || (e.prompts === 0 && !e.aiTitle)) return null;
  // cwd from the transcript is authoritative; the directory name is a lossy
  // fallback (Claude Code maps "/", ".", ":" and "\" all onto "-").
  const projectPath = e.cwd || decodeProjectDir(dirName(f.path));
  return {
    id: e.id,
    title: clean(e.aiTitle || e.summary || e.firstPrompt || e.wrapperPrompt || "Untitled session"),
    firstPrompt: e.firstPrompt ? clean(e.firstPrompt) : "",
    project: baseName(projectPath) || "?",
    projectPath,
    branch: e.branch,
    lastActive: e.lastTs ?? f.mtimeMs,
    prompts: e.prompts,
    filesTouched: e.files.length,
    activity: strip(e),
    partial: e.partial,
  };
}

/** Re-buckets the sparse wall-clock histogram into 24 cells at read time. */
function strip(e: Entry, n = 24): number[] {
  const out = new Array<number>(n).fill(0);
  const keys = Object.keys(e.bins);
  if (!keys.length) return out;
  const lo = e.firstTs ?? Number(keys[0]!) * BIN_MS;
  const span = Math.max(1, (e.lastTs ?? lo) - lo);
  for (const k of keys) {
    const i = Math.min(n - 1, Math.max(0, Math.floor(((Number(k) * BIN_MS - lo) / span) * n)));
    out[i]! += e.bins[k]!;
  }
  return out;
}

// No node:path here either — these are the only two pieces of it we need.
const baseName = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const dirName = (p: string) => baseName(p.slice(0, p.lastIndexOf("/")));
const idOf = (p: string) => baseName(p).replace(/\.jsonl$/, "");
const decodeProjectDir = (name: string) =>
  name.startsWith("-") ? "/" + name.slice(1).replace(/-/g, "/") : name.replace(/-/g, "/");
const unescape = (s: string) => { try { return JSON.parse(`"${s}"`) as string; } catch { return s; } };
const clean = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

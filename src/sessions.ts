// Turns ~/.claude/projects/<slug>/<session>.jsonl into one row per session,
// cheaply enough to run on a 400 MB transcript store.
//
// Three things keep it light:
//   1. stat-first. Files are ranked by mtime and only the newest are ever
//      opened; everything else is served from the cached index.
//   2. Append-only reads. Transcripts only grow, so a file that gained
//      40 KB since last time is read from byte `cached.size`, not byte 0.
//   3. No JSON.parse in the hot loop. Every field the row needs is pulled
//      with a regex over the raw line; the only line ever parsed is the
//      single first user prompt. Attachment and tool-output lines — the
//      bulk of the bytes — are matched and discarded without being decoded.
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, basename } from "node:path";
import { loadIndex, saveIndex, INDEX_VERSION, type Entry } from "./cache.ts";

// Overridable so the scanner can be exercised against a fixture tree.
const ROOT = process.env.SESSION_SWITCHER_ROOT || join(homedir(), ".claude", "projects");

const BIN_MS = 5 * 60_000;                  // activity histogram resolution
const HEAD_BYTES = 256 * 1024;              // enough for the opening prompt + cwd + branch
const TAIL_BYTES = 4 * 1024 * 1024;         // enough for the latest ai-title + last activity
const FULL_SCAN_MAX = 64 * 1024 * 1024;     // above this, sample head+tail instead
const FILES_CAP = 200;                      // stop collecting distinct edited paths here

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
  partial: boolean;       // strip/counts cover a sampled window, not the whole file
};

/** Instant: stat + cached index only, no transcript is opened. */
export async function loadSessions(limit = 200): Promise<Session[]> {
  const [files, index] = await Promise.all([listFiles(), loadIndex()]);
  return files
    .slice(0, limit)
    .map((f) => toSession(index[f.path], f))
    .filter((s): s is Session => s !== null);
}

/**
 * Brings the index up to date, newest file first, invoking `onRow` as each
 * one lands so the open list fills in progressively instead of blocking.
 * `refresh` files are opened at most; the rest keep their cached rows.
 */
export async function syncSessions(
  onRow: (s: Session) => void,
  { refresh = 40 }: { refresh?: number } = {},
): Promise<void> {
  const [files, index] = await Promise.all([listFiles(), loadIndex()]);
  let touched = 0;
  let scanned = 0;

  for (const f of files) {
    const cached = index[f.path];
    if (cached && cached.mtimeMs === f.mtimeMs && cached.size === f.size) continue;
    if (scanned++ >= refresh) break;

    const entry = await scan(f, cached).catch(() => null);
    if (!entry) continue;
    index[f.path] = entry;
    touched++;
    const row = toSession(entry, f);
    if (row) onRow(row);
  }

  // Forget files that have been deleted, so the index can't grow forever.
  const live = new Set(files.map((f) => f.path));
  for (const k of Object.keys(index)) if (!live.has(k)) { delete index[k]; touched++; }

  if (touched) await saveIndex(index);
}

// ---------------------------------------------------------------- scanning

type FileInfo = { path: string; size: number; mtimeMs: number };

async function listFiles(): Promise<FileInfo[]> {
  const out: FileInfo[] = [];
  for (const dir of await safeReaddir(ROOT)) {
    // Exactly one level deep: sub-agent transcripts live in a nested
    // <session-id>/subagents/ directory and are deliberately not sessions.
    for (const name of await safeReaddir(join(ROOT, dir))) {
      if (!name.endsWith(".jsonl")) continue;
      const path = join(ROOT, dir, name);
      const st = await stat(path).catch(() => null);
      if (st?.isFile()) out.push({ path, size: st.size, mtimeMs: st.mtimeMs });
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

async function scan(f: FileInfo, cached?: Entry): Promise<Entry> {
  // A file that shrank was rewritten, not appended to — start over.
  const resumable = cached && cached.v === INDEX_VERSION && cached.size <= f.size && !cached.partial;
  const e: Entry = resumable
    ? { ...cached!, size: cached!.size, mtimeMs: f.mtimeMs, files: [...cached!.files], bins: { ...cached!.bins } }
    : { v: INDEX_VERSION, path: f.path, size: 0, mtimeMs: f.mtimeMs, id: basename(f.path, ".jsonl"),
        prompts: 0, files: [], bins: {}, partial: false };

  if (resumable) {
    // Append-only fast path: read only the bytes that are new.
    e.size = await scanRange(f.path, e.size, f.size, e, false);
  } else if (f.size > FULL_SCAN_MAX) {
    // Too big to read whole on first sight: take the opening prompt from the
    // head and recent activity from the tail, and say so in the row.
    await scanRange(f.path, 0, Math.min(HEAD_BYTES, f.size), e, false);
    await scanRange(f.path, Math.max(0, f.size - TAIL_BYTES), f.size, e, true);
    e.partial = true;
    e.size = f.size;
  } else {
    e.size = await scanRange(f.path, 0, f.size, e, false);
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

/** Reads [start, end) as lines; returns the offset after the last complete one. */
function scanRange(path: string, start: number, end: number, e: Entry, dropFirstPartial: boolean): Promise<number> {
  return new Promise((resolve, reject) => {
    if (end <= start) return resolve(start);
    const stream = createReadStream(path, { start, end: end - 1, encoding: "utf8" });
    let buf = "";
    let consumed = start;
    let first = dropFirstPartial;

    stream.on("data", (chunk) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        consumed += Buffer.byteLength(line, "utf8") + 1;
        if (first) { first = false; continue; }  // ranged read landed mid-line
        if (line) fold(line, e);
      }
    });
    stream.on("error", reject);
    stream.on("end", () => resolve(consumed));
  });
}

function fold(line: string, e: Entry) {
  const ts = RE_TS.exec(line)?.[1];
  const t = ts ? Date.parse(ts) : NaN;

  if (e.cwd === undefined) { const m = RE_CWD.exec(line)?.[1]; if (m) e.cwd = unescape(m); }
  if (e.branch === undefined) { const m = RE_BRANCH.exec(line)?.[1]; if (m) e.branch = unescape(m); }

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
    }
    return;
  }

  if (e.files.length < FILES_CAP && line.includes('"tool_use"')) {
    RE_EDIT.lastIndex = 0;
    for (let m: RegExpExecArray | null; (m = RE_EDIT.exec(line)); ) {
      const p = unescape(m[1] ?? "");
      if (!p) continue;
      if (!e.files.includes(p)) e.files.push(p);
      if (e.files.length >= FILES_CAP) break;
    }
  }
}

// The one place we decode a line — a single user turn, once per session.
function firstText(line: string): string | undefined {
  if (line.length > 1_000_000) return undefined;
  try {
    const c = JSON.parse(line)?.message?.content;
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

function toSession(e: Entry | undefined, f: FileInfo): Session | null {
  if (!e || (e.prompts === 0 && !e.aiTitle)) return null;
  // cwd from the transcript is authoritative; the directory name is a lossy
  // fallback (Claude Code maps "/", ".", ":" and "\" all onto "-").
  const projectPath = e.cwd || decodeProjectDir(basename(dirOf(f.path)));
  const title = e.aiTitle || e.summary || e.firstPrompt || "Untitled session";
  return {
    id: e.id,
    title: clean(title),
    firstPrompt: e.firstPrompt ? clean(e.firstPrompt) : "",
    project: basename(projectPath) || "?",
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
  const out = new Array(n).fill(0);
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

const dirOf = (p: string) => p.slice(0, p.lastIndexOf("/"));
const decodeProjectDir = (name: string) =>
  name.startsWith("-") ? "/" + name.slice(1).replace(/-/g, "/") : name.replace(/-/g, "/");
const unescape = (s: string) => { try { return JSON.parse(`"${s}"`); } catch { return s; } };
const clean = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const safeReaddir = (p: string) => readdir(p).catch(() => [] as string[]);

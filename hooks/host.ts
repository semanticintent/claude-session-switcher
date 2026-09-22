// The port between the scanner's logic and whatever can actually touch files.
//
// A hooks module runs in an environment of its own — no Node, no DOM — so the
// scanner cannot import `node:fs`. Worse, `$.fs.read` rejects any file over
// 4 MiB and offers no ranged read, and a 226 MB transcript is ordinary here.
//
// So a read tries `$.fs.read` first — no subprocess, every platform — and only
// a transcript too big for that falls back to `$.process.run`, which takes an
// argv (no shell) and hands back the child's stdout. That fallback is the one
// platform-specific corner in the mod: `sed`/`head`/`tail` on a POSIX host,
// `Get-Content` on Windows. Most sessions never reach it.
//
// This file holds only the port's shape and one pure helper. The engine-side
// implementation lives in register.ts, because `claude plugin validate`
// refuses a mod that passes `$` across an import: every `$.noun.verb(...)`
// must be spelled in the file that hooks. `test/node-host.ts` implements the
// same three calls on `node:fs`, which is what keeps the scanner testable.
export type FileInfo = { path: string; size: number; mtimeMs: number };

export type Host = {
  /** Session transcripts, newest first. Exactly one level deep. */
  list(): Promise<FileInfo[]>;
  /**
   * Lines `from` (1-based) onward, at most `max` of them. `sawBytes` says
   * whether the read returned anything at all, which is how the scanner tells
   * "end of file" from "one line too big to come back whole".
   */
  linesFrom(path: string, from: number, max: number): Promise<{ lines: string[]; sawBytes: boolean }>;
  /** The first or last `lines` lines — a line budget, not a byte one, because
   *  that is the one shape both `head`/`tail` and PowerShell's `Get-Content`
   *  express directly. */
  sample(path: string, lines: number, end: "head" | "tail"): Promise<string[]>;
};

export type Store = {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
};

export const PROJECTS = ".claude/projects";

// The argv the fallback runs, built as pure functions so the Windows branch —
// the one corner of this mod that cannot be executed on a POSIX machine — is
// still reviewable and covered by tests.

/** PowerShell quoting: single quotes, with any inside doubled. */
export const psPath = (p: string) => `'${p.replace(/'/g, "''")}'`;

const ps = (script: string) => ["powershell", "-NoProfile", "-NonInteractive", "-Command", script];

/** Lines `from`..`from + max - 1`, printed without reading past them. */
export function rangeArgv(isWindows: boolean, path: string, from: number, max: number): string[] {
  const last = from + max - 1;
  return isWindows
    // -TotalCount stops the read at `last`; Skip drops the ones before `from`.
    ? ps(`Get-Content -LiteralPath ${psPath(path)} -Encoding UTF8 -TotalCount ${last} | Select-Object -Skip ${from - 1}`)
    // sed's trailing q is what stops it reading on to EOF after the range.
    : ["sed", "-n", `${from},${last}p;${last + 1}q`, path];
}

/** The first or last `lines` lines. */
export function sampleArgv(isWindows: boolean, path: string, lines: number, end: "head" | "tail"): string[] {
  return isWindows
    ? ps(`Get-Content -LiteralPath ${psPath(path)} -Encoding UTF8 ${end === "head" ? "-TotalCount" : "-Tail"} ${lines}`)
    : [end === "head" ? "head" : "tail", "-n", String(lines), path];
}

/** Splits a captured stdout chunk into whole lines, dropping a truncated tail. */
export function wholeLines(stdout: string, dropFirstPartial = false): string[] {
  const lines = stdout.split("\n");
  // `$.process.run` cuts stdout at the output limit, so the last line may be a
  // fragment; a tail read's *first* line is a fragment for the same reason.
  lines.pop();
  if (dropFirstPartial) lines.shift();
  return lines.filter(Boolean);
}

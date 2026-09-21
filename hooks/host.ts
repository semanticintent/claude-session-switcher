// The port between the scanner's logic and whatever can actually touch files.
//
// A hooks module runs in an environment of its own — no Node, no DOM — so the
// scanner cannot import `node:fs`. Worse, `$.fs.read` rejects any file over
// 4 MiB and offers no ranged read, and a 226 MB transcript is ordinary here.
//
// So reads go through `$.process.run`, which takes an argv (no shell) and
// hands back the child's stdout. That gives back exactly what the design
// needs — read the head, read the tail, or read only the lines appended since
// last time — without ever copying a whole transcript into the plugin.
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
  /** Whole lines within the first / last `bytes` of the file. */
  sample(path: string, bytes: number, end: "head" | "tail"): Promise<string[]>;
};

export type Store = {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
};

export const PROJECTS = ".claude/projects";

/** Splits a captured stdout chunk into whole lines, dropping a truncated tail. */
export function wholeLines(stdout: string, dropFirstPartial = false): string[] {
  const lines = stdout.split("\n");
  // `$.process.run` cuts stdout at the output limit, so the last line may be a
  // fragment; a tail read's *first* line is a fragment for the same reason.
  lines.pop();
  if (dropFirstPartial) lines.shift();
  return lines.filter(Boolean);
}

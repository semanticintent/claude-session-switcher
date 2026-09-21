import { mkdirSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { join } from "node:path";
const T = join(process.env.TMPDIR ?? "/tmp", "session-switcher-fixture");
rmSync(T, { recursive: true, force: true });
const dir = join(T, "projects", "-tmp-demo");
mkdirSync(dir, { recursive: true });
const FILE = join(dir, "11111111-2222-3333-4444-555555555555.jsonl");
process.env.SESSION_SWITCHER_ROOT = join(T, "projects");
process.env.SESSION_SWITCHER_HOME = join(T, "home");
const { loadSessions, syncSessions } = await import("../src/sessions.ts");

const ts = (m: number) => new Date(Date.UTC(2026, 8, 21, 10, m)).toISOString();
const L = (o: any) => JSON.stringify(o) + "\n";
const part1 =
  L({ type: "user", timestamp: ts(0), cwd: "/tmp/demo", gitBranch: "main",
      message: { content: "<system-reminder>ignore me</system-reminder>" } }) +
  L({ type: "attachment", timestamp: ts(0), blob: "x".repeat(5000) }) +
  L({ type: "user", timestamp: ts(1), cwd: "/tmp/demo", message: { content: [{ type: "text", text: "Fix the token refresh bug" }] } }) +
  L({ type: "assistant", timestamp: ts(2), message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: "/tmp/demo/a.ts" } }] } }) +
  L({ type: "user", timestamp: ts(3), message: { content: [{ type: "tool_result", text: "ok" }] } }) +
  L({ type: "ai-title", timestamp: ts(3), aiTitle: "First guess at a title" }) +
  L({ type: "user", timestamp: ts(4), isSidechain: true, message: { content: "subagent chatter" } }) +
  L({ type: "last-prompt", timestamp: ts(4), text: "noise" });
writeFileSync(FILE, part1);

const runs: any[] = [];
await syncSessions(() => {}, { refresh: 10 });
runs.push((await loadSessions())[0]!);

// …session continues: more turns, a regenerated title, another file edited.
appendFileSync(FILE,
  L({ type: "user", timestamp: ts(40), message: { content: "and also the retry path" } }) +
  L({ type: "assistant", timestamp: ts(41), message: { content: [{ type: "tool_use", name: "Write", input: { file_path: "/tmp/demo/b.ts" } }] } }) +
  L({ type: "ai-title", timestamp: ts(42), aiTitle: "Token refresh and retry" }));
await syncSessions(() => {}, { refresh: 10 });
const incremental = (await loadSessions())[0]!;

// Same file, but indexed from scratch — the two must agree.
rmSync(join(T, "home"), { recursive: true, force: true });
await syncSessions(() => {}, { refresh: 10 });
const fromScratch = (await loadSessions())[0]!;

const eq = JSON.stringify(incremental) === JSON.stringify(fromScratch);
const checks: [string, boolean][] = [
  ["skips the <system-reminder> wrapper as the first prompt", runs[0].firstPrompt === "Fix the token refresh bug"],
  ["newest ai-title wins over the earlier one", incremental.title === "Token refresh and retry"],
  ["tool_result and sidechain turns are not counted as prompts", incremental.prompts === 3],
  ["counts distinct edited files", incremental.filesTouched === 2],
  ["keeps the full cwd for resume", incremental.projectPath === "/tmp/demo" && incremental.project === "demo"],
  ["picks up the git branch", incremental.branch === "main"],
  ["activity strip spreads across the session's life", incremental.activity[0]! > 0 && incremental.activity[23]! > 0],
  ["append-only re-index === full re-index", eq],
];
for (const [name, ok] of checks) console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
if (!eq) { console.log("incremental:", incremental); console.log("scratch:   ", fromScratch); }
console.log(checks.every(c => c[1]) ? "\nall green" : "\nFAILURES");

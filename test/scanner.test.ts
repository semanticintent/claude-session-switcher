import { mkdirSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { cachedSessions, sync } from "../hooks/scan.ts";
import { view, spark, matches, type Model } from "../hooks/view.ts";
import { setMeta, mergeMeta, metaFor, fingerprint, type Meta } from "../hooks/tags.ts";
import { nodeHost, memoryStore } from "./node-host.ts";
import { rangeArgv, sampleArgv, psPath, resumeCommand } from "../hooks/host.ts";

const T = join(process.env.TMPDIR ?? "/tmp", "session-switcher-fixture");
rmSync(T, { recursive: true, force: true });
const dir = join(T, "projects", "-tmp-demo");
mkdirSync(dir, { recursive: true });
const FILE = join(dir, "11111111-2222-3333-4444-555555555555.jsonl");

const host = nodeHost(join(T, "projects"));

// Claude Code's own name store. "derived" is its auto-slug, not your choice.
mkdirSync(join(T, "sessions"), { recursive: true });
writeFileSync(join(T, "sessions", "a.json"), JSON.stringify({
  sessionId: "11111111-2222-3333-4444-555555555555",
  name: "Sep 10 | someone | some team", nameSource: "user" }));
writeFileSync(join(T, "sessions", "b.json"), JSON.stringify({
  sessionId: "22222222-3333-4444-5555-666666666666",
  name: "workspace-a7", nameSource: "derived" }));
const ts = (m: number) => new Date(Date.UTC(2026, 8, 21, 10, m)).toISOString();
const L = (o: unknown) => JSON.stringify(o) + "\n";

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

// A second session whose every turn is a wrapper, in a directory that is no
// git repo — the two cases that used to draw "Untitled session ... on HEAD".
const BARE = join(dir, "22222222-3333-4444-5555-666666666666.jsonl");
writeFileSync(BARE,
  L({ type: "user", timestamp: ts(10), cwd: "/tmp/bare", gitBranch: "HEAD",
      message: { content: "<command-name>/plugin-types</command-name>" } }) +
  L({ type: "user", timestamp: ts(11), message: { content: "<system-reminder>be good</system-reminder>" } }));

// A session recorded on Windows: the cwd has backslashes and no "/" at all.
const WIN_CWD = "C:\\src\\sample\\Widget.2.1";
writeFileSync(join(dir, "33333333-4444-5555-6666-777777777777.jsonl"),
  L({ type: "user", timestamp: ts(20), cwd: WIN_CWD, message: { content: "Fix the parser" } }));

// Selected by project, not by position: the fixture holds more than one
// session and they are ordered by mtime.
const demoOf = async (st: typeof store) =>
  (await cachedSessions(st, host)).find((x) => x.projectPath === "/tmp/demo")!;

let store = memoryStore();
await sync(store, host, () => {});
const first = await demoOf(store);

// …session continues: more turns, a regenerated title, another file edited.
appendFileSync(FILE,
  L({ type: "user", timestamp: ts(40), message: { content: "and also the retry path" } }) +
  L({ type: "assistant", timestamp: ts(41), message: { content: [{ type: "tool_use", name: "Write", input: { file_path: "/tmp/demo/b.ts" } }] } }) +
  L({ type: "ai-title", timestamp: ts(42), aiTitle: "Token refresh and retry" }));
await sync(store, host, () => {});
const incremental = await demoOf(store);

// Same file, but indexed from scratch — the two must agree.
store = memoryStore();
await sync(store, host, () => {});
const fromScratch = await demoOf(store);

// The view is a pure function, so it can be drawn with recording stubs.
const drawn: string[] = [];
const stub = (name: string) => (props: any) => {
  const kids = [props.label, props.placeholder, props.children].flat(3).filter((c) => typeof c === "string");
  drawn.push(`${name}:${kids.join("")}`);
  return { name, props } as any;
};
const meta: Record<string, Meta> = {};
setMeta(incremental, meta, "#auth Token refresh");
const model: Model = { sessions: [incremental], meta, query: "", page: 0, mode: "resume", editing: null, syncing: false };
const actions = { filter() {}, pick() {}, toggleMode() {}, turnPage() {}, editTags() {} };
view({ Box: stub("Box"), Text: stub("Text"), Button: stub("Button"), Input: stub("Input") }, model, actions);
const text = drawn.join("\n");

// A surface whose table has no Input must still draw its rows.
drawn.length = 0;
view({ Box: stub("Box"), Text: stub("Text"), Button: stub("Button") }, model, actions);
const noInput = drawn.join("\n");

const bare = (await cachedSessions(store, host)).find((x) => x.projectPath === "/tmp/bare")!;
const win = (await cachedSessions(store, host)).find((x) => x.projectPath === WIN_CWD)!;

// What `/switcher #wip` does from inside a session: fold in, don't replace.
const live: Record<string, Meta> = {};
setMeta(incremental, live, "#mods Token refresh");
mergeMeta(incremental.id, incremental, live, "#wip");
const merged = metaFor(incremental, live)!;
mergeMeta(incremental.id, incremental, live, "-#mods +#blocked");   // the symmetric form
const after = metaFor(incremental, live)!;
mergeMeta(incremental.id, incremental, live, "Renamed in flight");
const retitled = metaFor(incremental, live)!;
const brandNew = mergeMeta("not-indexed-yet", null, live, "#wip");

// The Windows fallback can't be run here, so it's pinned by its argv instead.
const winRange = rangeArgv(true, "C:\\Users\\d\\.claude\\x.jsonl", 41, 10).join(" ");
const posixRange = rangeArgv(false, "/h/x.jsonl", 41, 10);

const checks: [string, boolean][] = [
  ["posix range reads only the range and quits past it", posixRange[2] === "41,50p;51q"],
  ["windows range stops the read at the last line it needs", winRange.includes("-TotalCount 50") && winRange.includes("-Skip 40")],
  ["windows tail asks for lines from the end", sampleArgv(true, "x", 400, "tail").join(" ").includes("-Tail 400")],
  ["posix head asks for lines, not bytes", sampleArgv(false, "x", 200, "head").join(" ") === "head -n 200 x"],
  ["a quote in a path can't break out of the PowerShell string", psPath("C:\\it's\\x") === "'C:\\it''s\\x'"],
  ["a tag adds without dropping the title", merged.tags.join() === "mods,wip" && merged.title === "Token refresh"],
  ["-#tag removes just that one, +#tag adds", after.tags.join() === "wip,blocked"],
  ["+#tag leaves no stray sign in the title", after.title === "Token refresh"],
  ["a typed title replaces, tags survive", retitled.title === "Renamed in flight" && retitled.tags.join() === "wip,blocked"],
  ["a session not yet indexed still takes a tag", brandNew.tags.join() === "wip" && brandNew.fp === undefined],
  ["a name you gave the session outranks the ai-title", incremental.title === "Sep 10 | someone | some team"],
  ["the CLI's derived auto-slug does not", bare.title === "/plugin-types"],
  ["a detached or non-repo cwd draws no branch", bare.branch === undefined],
  ["skips the <system-reminder> wrapper as the first prompt", first.firstPrompt === "Fix the token refresh bug"],
  ["newest ai-title wins over the earlier one", first.title !== "First guess at a title"],
  ["tool_result and sidechain turns are not counted as prompts", incremental.prompts === 3],
  ["counts distinct edited files", incremental.filesTouched === 2],
  ["keeps the full cwd for resume", incremental.projectPath === "/tmp/demo" && incremental.project === "demo"],
  ["a Windows cwd draws its last folder, not the whole path", win.projectPath === WIN_CWD && win.project === "Widget.2.1"],
  ["posix resume keeps &&", resumeCommand(false, "/tmp/demo", "abc") === "cd /tmp/demo && claude --resume abc"],
  ["windows resume has no && (a PowerShell 5.1 parse error)",
    resumeCommand(true, "C:\\it's\\x", "abc") === "cd 'C:\\it''s\\x'; if ($?) { claude --resume abc }"],
  ["picks up the git branch", incremental.branch === "main"],
  ["activity strip spreads across the session's life", incremental.activity[0]! > 0 && incremental.activity[23]! > 0],
  ["append-only re-index === full re-index", JSON.stringify(incremental) === JSON.stringify(fromScratch)],
  ["a tag survives a resume's new session id", fingerprint({ ...incremental, id: "brand-new-id" }) === fingerprint(incremental)],
  ["filter matches on #tag as well as text", matches(incremental, meta, "#auth") && !matches(incremental, meta, "#nope")],
  ["the row draws its title, project, tag and strip", text.includes("Token refresh") && text.includes("demo") && text.includes("#auth") && text.includes(spark(incremental.activity))],
  ["the row carries a digit hotkey", text.includes("Button:Token refresh")],
  ["a surface without Input still draws the row", noInput.includes("Button:Token refresh")],
  // Your own title beats the session name, which beats the ai-title: each step
  // is a more deliberate statement of what the session is.
  ["a title you set here outranks the session's name", (metaFor(incremental, meta)?.title) === "Token refresh"
    && incremental.title === "Sep 10 | someone | some team"],
];
for (const [name, ok] of checks) console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
console.log(checks.every((c) => c[1]) ? "\nall green" : "\nFAILURES");
if (!checks.every((c) => c[1])) process.exitCode = 1;

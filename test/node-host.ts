// A Host backed by node:fs, for tests only. The engine's Host (hooks/host.ts)
// reads through $.fs and $.process; this one reads through Node — same three
// calls, so the scanner's logic is exercised without an engine.
import { readFileSync, readdirSync, statSync } from "node:fs";
import type { Host, Store, FileInfo } from "../hooks/host.ts";

export function nodeHost(root: string): Host {
  const linesOf = (p: string) => readFileSync(p, "utf8").split("\n").filter(Boolean);
  return {
    async list(): Promise<FileInfo[]> {
      const out: FileInfo[] = [];
      for (const dir of readdirSync(root, { withFileTypes: true })) {
        if (!dir.isDirectory()) continue;
        for (const f of readdirSync(`${root}/${dir.name}`, { withFileTypes: true })) {
          if (!f.isFile() || !f.name.endsWith(".jsonl")) continue;
          const path = `${root}/${dir.name}/${f.name}`;
          const st = statSync(path);
          out.push({ path, size: st.size, mtimeMs: st.mtimeMs });
        }
      }
      return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
    },
    async linesFrom(path, from, max) {
      return linesOf(path).slice(from - 1, from - 1 + max);
    },
    async sample(path, bytes, end) {
      const buf = readFileSync(path);
      const slice = end === "head" ? buf.subarray(0, bytes) : buf.subarray(Math.max(0, buf.length - bytes));
      const text = slice.toString("utf8");
      const lines = text.split("\n");
      // Same truncation rules the real host applies to a captured stdout.
      if (buf.length > bytes) { if (end === "head") lines.pop(); else lines.shift(); }
      return lines.filter(Boolean);
    },
  };
}

export function memoryStore(): Store {
  const data = new Map<string, unknown>();
  return {
    async get(key) { return data.get(key); },
    // Round-trips through JSON exactly as $.store does.
    async set(key, value) { data.set(key, JSON.parse(JSON.stringify(value))); },
  };
}

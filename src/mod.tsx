// Entry point. ⚠ The hook names and $ methods below are ASSUMPTIONS based on
// the Mods proposal (issue #91870). Check them against a built-in mod in
// anthropics/claude-code/mods and adjust — everything else is self-contained
// and covered by test/scanner.test.ts.
import React from "react";
import { SessionList } from "./SessionList.tsx";
import { loadSessions, syncSessions, type Session } from "./sessions.ts";
import { loadMeta, saveMeta, setMeta, pruneMeta } from "./tags.ts";
import { loadConfig, registerFirst } from "./config.ts";

export default async function sessionSwitcher(hook: any) {
  const config = await loadConfig();

  const open = async ($: any) => {
    // Opens on the cached index (milliseconds, no transcript is read), then
    // folds in anything that changed as it lands — so the list is never
    // waiting on a 200 MB file before it will draw.
    const [sessions, meta] = await Promise.all([loadSessions(), loadMeta()]);
    const rows = new Map(sessions.map((s) => [s.id, s]));

    const overlay = $.ui.overlay(                      // ASSUMED API
      <SessionList
        sessions={sessions}
        meta={meta}
        onClose={() => overlay.close()}
        onResume={(id: string) => {
          overlay.close();
          const s = rows.get(id);
          // A session belongs to a directory; resuming cross-project without
          // its cwd drops you into the wrong repo.
          $.session.resume(id, { cwd: s?.projectPath });                // ASSUMED API
        }}
        onEdit={async (s: Session, input: string) => {
          setMeta(s, meta, input);
          await saveMeta(meta);
          overlay.update({ meta: { ...meta } });
        }}
      />
    );

    syncSessions((s) => {
      rows.set(s.id, s);
      const next = [...rows.values()].sort((a, b) => b.lastActive - a.lastActive);
      overlay.update({ sessions: next });
    }, { refresh: config.refresh }).then(async () => {
      pruneMeta(meta, [...rows.values()]);
      await saveMeta(meta);
    }).catch(() => { /* a stale row beats a crashed overlay */ });
  };

  // See src/config.ts: candidate names are tried in order so a future
  // built-in /sessions can take the generic name without breaking the mod.
  registerFirst(hook, config.commands, async ($: any) => open($));
  hook(`keybinding:${config.keybinding}`, async ($: any) => open($));
}

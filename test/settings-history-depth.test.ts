// [LAW:verifiable-goals] A session's history depth (`↶`/`↷`) is what its
// view's payload reads, so it moves for that session's own steps and never for
// another's: one click recomputes one session's payload, however many sessions
// the daemon draws.

import { autorun } from "mobx";
import { SessionState } from "../src/daemon/session-state";
import { SettingsHistory } from "../src/daemon/settings-history";

test("one session's step moves its own depth and no other session's", () => {
  const sessionState = new SessionState();
  const history = new SettingsHistory(sessionState, () => {});
  const pick = (sessionId: string, theme: string): void => {
    const journal = history.begin();
    journal.sessionState.set(sessionId, "theme", theme);
    journal.commit();
  };
  pick("b", "nord");
  const seen: Record<string, number[]> = { a: [], b: [] };
  const stops = ["a", "b"].map((sid) =>
    autorun(() => seen[sid]!.push(history.depth(sid).undo)),
  );
  try {
    pick("a", "nord");
    pick("a", "dracula");
    expect(seen).toEqual({ a: [0, 1, 2], b: [1] });
  } finally {
    for (const stop of stops) stop();
  }
});

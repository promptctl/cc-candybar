// [LAW:verifiable-goals] A session's history depth (`↶`/`↷`) is what its
// view's payload reads, so it moves for that session's own steps and never for
// another's: one click recomputes one session's payload, however many sessions
// the daemon draws.

import {
  historyAfterEdits,
  type Change,
  type SessionHistory,
} from "../../src/renderer-interface/history-storage";
import { autorun } from "mobx";
import { SessionState } from "../../src/renderer/session-state";
import { SettingsHistory } from "../../src/renderer/settings-history";
import {
  sessionIdOf,
  type SessionId,
} from "../../src/daemon/foundations/session-id";
import { NO_LAYERS } from "../helpers/history-step";

const A = sessionIdOf("a");
const B = sessionIdOf("b");

test("one session's step moves its own depth and no other session's", () => {
  const sessionState = new SessionState();
  const history = new SettingsHistory(sessionState, () => {});
  const pick = (sessionId: SessionId, theme: string): void => {
    const journal = history.begin(NO_LAYERS);
    journal.sessionState.set(sessionId, "theme", theme);
    journal.commit();
  };
  pick(B, "nord");
  const seen: Record<string, number[]> = { a: [], b: [] };
  const stops = [A, B].map((sid) =>
    autorun(() => seen[sid]!.push(history.depth(sid).undo)),
  );
  try {
    pick(A, "nord");
    pick(A, "dracula");
    expect(seen).toEqual({ a: [0, 1, 2], b: [1] });
  } finally {
    for (const stop of stops) stop();
  }
});

// [LAW:carrying-cost] A hearing runs on every request and moves only the
// order, so no session's depth is read again for it.
test("a request from a session moves its place and no session's depth", () => {
  const sessionState = new SessionState();
  const history = new SettingsHistory(sessionState, () => {});
  for (const sessionId of [A, B]) {
    const journal = history.begin(NO_LAYERS);
    journal.sessionState.set(sessionId, "theme", "nord");
    journal.commit();
  }
  history.drain();
  const seen: Record<string, number[]> = { a: [], b: [] };
  const stops = [A, B].map((sid) =>
    autorun(() => seen[sid]!.push(history.depth(sid).undo)),
  );
  try {
    history.heard(A);
    expect(seen).toEqual({ a: [1], b: [1] });
    expect(history.drain()).toEqual([
      { kind: "heard", store: "settings-history", key: A },
    ]);
  } finally {
    for (const stop of stops) stop();
  }
});

test.each([1, 24])(
  "a click beside %d other sessions never rereads their history",
  (count) => {
    let reads = 0;
    const unrelated = Object.fromEntries(
      Array.from({ length: count }, (_, i) => [
        `other-${i}`,
        {
          past: Array.from({ length: 15 }, () => [
            {
              kind: "session" as const,
              key: "theme",
              get before() {
                reads++;
                return "old";
              },
              get after() {
                reads++;
                return "new";
              },
            },
          ]),
          future: [],
        },
      ]),
    );
    const history = new SettingsHistory(
      new SessionState(),
      () => {},
      unrelated,
    );
    reads = 0;
    const click = history.begin(NO_LAYERS);
    click.sessionState.set(A, "theme", "nord");
    click.commit();
    history.heard(sessionIdOf("other-0"));
    const writes = history.drain();
    expect(reads).toBe(0);
    expect(writes).toEqual([
      {
        kind: "steps",
        store: "settings-history",
        key: A,
        edits: [
          {
            kind: "append",
            step: [
              { kind: "session", key: "theme", before: null, after: "nord" },
            ],
          },
        ],
      },
      { kind: "heard", store: "settings-history", key: sessionIdOf("other-0") },
    ]);
  },
);

test("a peer appends, undoes, redoes and discards a stale target without resending the file step", () => {
  const big = "x".repeat(64 * 1024);
  const file = {
    kind: "layer",
    role: "user",
    digest: "layer",
    before: big,
    after: big + "y",
  } as const;
  const prior = { past: [[file]], future: [] };
  const picks = new SessionState();
  const history = new SettingsHistory(picks, () => {}, { [A]: prior });
  let peer: SessionHistory | undefined = prior;
  const receive = (edit: unknown) => {
    const writes = history.drain();
    expect(writes).toEqual([
      { kind: "steps", store: "settings-history", key: A, edits: [edit] },
    ]);
    expect(JSON.stringify(writes).length).toBeLessThan(220);
    const [write] = writes;
    if (write?.kind !== "steps") throw new Error("expected a history change");
    peer = historyAfterEdits(peer, write.edits) ?? undefined;
    expect(peer).toEqual(history.history(A));
  };
  const theme: Change = {
    kind: "session",
    key: "theme",
    before: null,
    after: "nord",
  };
  const appended = history.begin(NO_LAYERS);
  appended.sessionState.set(A, "theme", "nord");
  appended.commit();
  receive({ kind: "append", step: [theme] });
  for (const verb of ["undo", "redo"] as const) {
    const click = history.begin(NO_LAYERS);
    click[verb](A);
    click.commit();
    receive({ kind: verb });
  }
  picks.set(A, "theme", "changed elsewhere");
  const stale = history.begin(NO_LAYERS);
  expect(() => stale.undo(A)).toThrow(/changed since that edit/);
  stale.commit();
  receive({ kind: "forget", targets: [{ kind: "session", key: "theme" }] });
  expect(history.history(A)).toEqual(prior);
});

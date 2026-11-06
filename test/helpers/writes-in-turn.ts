// [LAW:nothing-unseen] The ordering instrument of the request and click
// paths: a view of the session store that throws on a write made while no
// journal turn is held, so a write that slipped out of its turn fails the test
// that made it instead of landing in a frame that no event explains. Every
// click-path test writes through it (test/helpers/click.ts), and so does every
// daemon built in a worker (test/helpers/in-worker-daemon.ts); the ticket that
// routes the last writer promotes it into the store itself.

import type { JournalTurns } from "../../src/daemon/journal-turns";
import type { SessionStateRW } from "../../src/daemon/session-state";

export function writesInTurn(
  store: SessionStateRW,
  turns: Pick<JournalTurns, "getStats">,
): SessionStateRW {
  const held = (what: string): void => {
    if (turns.getStats().holder === null) {
      throw new Error(`session state written outside any journal turn: ${what}`);
    }
  };
  return {
    get: (sessionId, key) => store.get(sessionId, key),
    revision: (sessionId) => store.revision(sessionId),
    values: (sessionId) => store.values(sessionId),
    set: (sessionId, key, value) => {
      held(`set ${key}`);
      store.set(sessionId, key, value);
    },
    setBatch: (sessionId, pairs) => {
      held(`setBatch ${pairs.map((p) => p.key).join(",")}`);
      store.setBatch(sessionId, pairs);
    },
    clear: (sessionId, key) => {
      held(`clear ${key}`);
      store.clear(sessionId, key);
    },
  };
}

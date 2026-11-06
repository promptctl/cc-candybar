// The facts source a test hands a view it reads no built-in through: every
// fact pending for good, nothing held, nothing started. A test double of the
// interface (src/daemon/facts-source.ts), beside SOURCES_NOTHING and the other
// nothing-doubles, so a cache or view built for another subject declares
// nothing without an owner.
import type { SessionId } from "../../src/daemon/session-id";
import { inProcessFacts, type Facts } from "../../src/daemon/facts-source";
import {
  BUILTIN_FACTS,
  FACTS_VERSION,
  type BuiltinFacts,
  type SessionFacts,
} from "../../src/facts/session-facts";
import type { Instant } from "../../src/utils/instant";
import { pendingOf } from "../../src/utils/outcome";
import { UNREAD_RUNS, type SourceRuns } from "../../src/var-system/source-runs";
import { absentOwners } from "./payload-owners";

// The document before any source has answered: total, sequence 0 because no
// assembly made it. The built-ins are the one list of them, so a built-in
// added to the document is pending here without an edit.
export function pendingFacts(session: SessionId): SessionFacts {
  const unread = pendingOf("unread");
  return {
    v: FACTS_VERSION,
    session,
    seq: 0,
    builtins: Object.fromEntries(
      BUILTIN_FACTS.map((name) => [name, unread]),
    ) as unknown as BuiltinFacts,
    sources: {},
    runs: {},
    update: unread,
    diagnostics: [],
  };
}

export const FACTS_NOTHING: Facts = {
  follow: (facts) => {
    const line = { at: 0 as Instant, facts: pendingFacts(facts.sessionId) };
    return {
      runs: UNREAD_RUNS,
      stamped: () => line,
      failure: () => null,
      follow: () => {},
      settle: () => ({ refreshed: new Map(), landed: Promise.resolve() }),
      dispose: () => {},
    };
  },
};

// The facts source a test hands a view whose `shell` and `file` sources must
// answer and whose built-ins it reads none of: the in-process arm, running
// the view's sources in `runs`, over owners that hold nothing. A view's
// sources are drawn only through its follow (src/daemon/facts-source.ts), so
// a double that ran none would leave them pending.
export function factsRunning(runs: SourceRuns): Facts {
  return inProcessFacts({
    providers: { ...absentOwners(), log: () => {} } as never,
    update: () => pendingOf("unread"),
    runs,
  });
}

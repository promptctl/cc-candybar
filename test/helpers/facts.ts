// The facts source a test hands a view it reads no built-in through: every
// fact pending for good, nothing held, nothing started. A test double of the
// interface (src/daemon/facts-source.ts), beside SOURCES_NOTHING and the other
// nothing-doubles, so a cache or view built for another subject declares
// nothing without an owner.
import type { SessionId } from "../../src/daemon/session-id";
import type { Facts } from "../../src/daemon/facts-source";
import { FACTS_VERSION, type SessionFacts } from "../../src/facts/session-facts";
import type { Instant } from "../../src/utils/instant";
import { pendingOf } from "../../src/utils/outcome";

// The document before any source has answered: total, sequence 0 because no
// assembly made it.
export function pendingFacts(session: SessionId): SessionFacts {
  const unread = pendingOf("unread");
  return {
    v: FACTS_VERSION,
    session,
    seq: 0,
    builtins: {
      session: unread,
      today: unread,
      speed: unread,
      context: unread,
      metrics: unread,
      activity: unread,
      cache: unread,
      autocompact: unread,
      git: unread,
      pr: unread,
      tmux: unread,
      hostName: unread,
      hostUser: unread,
    },
    sources: {},
    update: unread,
    diagnostics: [],
  };
}

export const FACTS_NOTHING: Facts = {
  follow: (facts) => {
    const line = { at: 0 as Instant, facts: pendingFacts(facts.sessionId) };
    return {
      stamped: () => line,
      failure: () => null,
      follow: () => {},
      settle: () => ({ refreshed: new Map(), landed: Promise.resolve() }),
      dispose: () => {},
    };
  },
};

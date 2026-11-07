// [LAW:verifiable-goals] A connection's lifecycle table, cell by cell: the next
// state each event moves it to, and the effects of that step. The connection
// over a stream is test/daemon-connection.test.ts.

import {
  AWAITING,
  backstopArmed,
  clientLeft,
  inFlight,
  step,
  timedOut,
  type ConnectionEvent,
  type ConnectionState,
} from "../../src/daemon/connection-state";
import type { Reply } from "../../src/daemon/reply";
import { sessionIdOf } from "../../src/daemon/session-id";

const reply = (exitAfterFlush: number | null = null): Reply => ({
  resp: { ok: true, output: "the answer" },
  exitAfterFlush,
  delivered: () => {},
});
const ANSWER = reply();
const unsubscribe = (): void => {};
const start = async (): Promise<Reply> => ANSWER;

const ANSWERING: ConnectionState = { kind: "answering" };
const UNATTENDED: ConnectionState = { kind: "unattended", lapsed: false };
const LAPSED: ConnectionState = { kind: "unattended", lapsed: true };
const REPLIED: ConnectionState = { kind: "answered", by: "reply" };
const TOLD_TIMEOUT: ConnectionState = { kind: "answered", by: "backstop" };
const HELD: ConnectionState = { kind: "held" };
const STREAMING: ConnectionState = { kind: "streaming", unsubscribe };
const CLOSED: ConnectionState = { kind: "closed", lapsed: false };
const CLOSED_LAPSED: ConnectionState = { kind: "closed", lapsed: true };

const STATES: readonly ConnectionState[] = [
  AWAITING,
  ANSWERING,
  UNATTENDED,
  LAPSED,
  REPLIED,
  TOLD_TIMEOUT,
  HELD,
  STREAMING,
  CLOSED,
  CLOSED_LAPSED,
];

const EVENTS: readonly ConnectionEvent[] = [
  { kind: "read", waits: true },
  { kind: "read", waits: false },
  { kind: "unreadable", answer: ANSWER },
  { kind: "deadline", answer: ANSWER },
  { kind: "reply", ...reply(0) },
  {
    kind: "subscribe",
    sessionId: sessionIdOf("a-session"),
    lane: "statusline",
  },
  { kind: "subscribed", unsubscribe },
  { kind: "held", start },
  { kind: "threw", answer: ANSWER },
  { kind: "settled" },
  { kind: "close" },
];

const kinds = (s: ConnectionState, e: ConnectionEvent): string[] =>
  step(s, e).effects.map((effect) => effect.kind);

describe("the read", () => {
  test("a request frame: its client waits for the answer", () => {
    expect(step(AWAITING, { kind: "read", waits: true })).toEqual({
      next: ANSWERING,
      effects: [],
    });
  });

  test("a url frame: nobody waits, and the deadline is still armed", () => {
    const { next } = step(AWAITING, { kind: "read", waits: false });
    expect(next).toEqual(UNATTENDED);
    expect(backstopArmed(next)).toBe(true);
    expect(inFlight(next)).toBe(true);
  });

  test("a request frame read after the backstop answered changes nothing", () => {
    expect(step(TOLD_TIMEOUT, { kind: "read", waits: true })).toEqual({
      next: TOLD_TIMEOUT,
      effects: [],
    });
  });

  // The forwarder hangs up by design, so its close is no departure even once
  // the backstop has fired: the frame stays in flight until it is handled.
  test("a url frame read after the backstop answered is unattended and lapsed", () => {
    const { next, effects } = step(TOLD_TIMEOUT, {
      kind: "read",
      waits: false,
    });
    expect(next).toEqual(LAPSED);
    expect(effects).toEqual([]);
    expect(step(next, { kind: "close" }).next).toEqual(LAPSED);
    expect(clientLeft(next)).toBe(false);
    expect(timedOut(next)).toBe(true);
  });

  test("a frame that does not parse is answered, only while awaiting", () => {
    const bad: ConnectionEvent = { kind: "unreadable", answer: ANSWER };
    expect(step(AWAITING, bad)).toEqual({
      next: REPLIED,
      effects: [{ kind: "clear-backstop" }, { kind: "answer", answer: ANSWER }],
    });
    expect(step(ANSWERING, bad)).toEqual({ next: ANSWERING, effects: [] });
  });
});

describe("the deadline", () => {
  const deadline: ConnectionEvent = { kind: "deadline", answer: ANSWER };

  test.each([AWAITING, ANSWERING])(
    "a waiting client (%o) is told TIMEOUT, and it counts",
    (s) => {
      expect(step(s, deadline)).toEqual({
        next: TOLD_TIMEOUT,
        effects: [
          { kind: "clear-backstop" },
          { kind: "count-timeout" },
          { kind: "answer", answer: ANSWER },
        ],
      });
    },
  );

  test("an unattended frame lapses: it counts, and nobody is told", () => {
    const { next, effects } = step(UNATTENDED, deadline);
    expect(next).toEqual(LAPSED);
    expect(effects.map((e) => e.kind)).toEqual([
      "clear-backstop",
      "count-timeout",
    ]);
    expect(timedOut(next)).toBe(true);
    expect(inFlight(next)).toBe(true);
  });

  test("no other state reacts to it", () => {
    const reacting = STATES.filter((s) => {
      const { next, effects } = step(s, deadline);
      return next !== s || effects.length > 0;
    });
    expect(reacting).toEqual([AWAITING, ANSWERING, UNATTENDED]);
  });
});

describe("a reply", () => {
  test.each([ANSWERING, HELD])("from %o is written", (s) => {
    const r: ConnectionEvent = { kind: "reply", ...ANSWER };
    const { next, effects } = step(s, r);
    expect(next).toEqual(REPLIED);
    expect(effects).toContainEqual({ kind: "answer", answer: r });
  });

  test.each([TOLD_TIMEOUT, CLOSED_LAPSED])(
    "to a client told TIMEOUT (%o) drops its exit, and says so",
    (s) => {
      expect(step(s, { kind: "reply", ...reply(0) })).toEqual({
        next: s,
        effects: [{ kind: "exit-dropped" }],
      });
      expect(step(s, { kind: "reply", ...reply() })).toEqual({
        next: s,
        effects: [],
      });
    },
  );

  test("to a client that hung up unanswered writes nothing, and keeps its exit", () => {
    expect(step(CLOSED, { kind: "reply", ...reply(3) })).toEqual({
      next: CLOSED,
      effects: [{ kind: "exit", code: 3 }],
    });
  });

  test("to an unattended frame goes to no one", () => {
    expect(step(UNATTENDED, { kind: "reply", ...reply(0) })).toEqual({
      next: UNATTENDED,
      effects: [],
    });
  });

  test("a throw is answered from answering or held, and from nothing else", () => {
    const threw: ConnectionEvent = { kind: "threw", answer: ANSWER };
    const answering = STATES.filter((s) => kinds(s, threw).includes("answer"));
    expect(answering).toEqual([ANSWERING, HELD]);
    expect(step(HELD, threw).next).toEqual(REPLIED);
  });
});

describe("a subscribe", () => {
  const subscribe: ConnectionEvent = {
    kind: "subscribe",
    sessionId: sessionIdOf("a-session"),
    lane: "statusline",
  };

  test("attaches the feed from answering, and stays answering until it stands", () => {
    expect(step(ANSWERING, subscribe)).toEqual({
      next: ANSWERING,
      effects: [
        {
          kind: "attach",
          sessionId: sessionIdOf("a-session"),
          lane: "statusline",
        },
      ],
    });
  });

  test("attaches nothing from any other state", () => {
    const attaching = STATES.filter((s) =>
      kinds(s, subscribe).includes("attach"),
    );
    expect(attaching).toEqual([ANSWERING]);
  });

  test("once it stands, the connection streams, out of in-flight and the backstop", () => {
    expect(step(ANSWERING, { kind: "subscribed", unsubscribe })).toEqual({
      next: STREAMING,
      effects: [{ kind: "clear-backstop" }, { kind: "leave-in-flight" }],
    });
  });

  test("one the feed took after the connection moved on is ended", () => {
    for (const s of STATES.filter((s) => s !== ANSWERING)) {
      expect(step(s, { kind: "subscribed", unsubscribe })).toEqual({
        next: s,
        effects: [{ kind: "unsubscribe", unsubscribe }],
      });
    }
  });
});

describe("a held request", () => {
  test("starts its work from answering only", () => {
    const held: ConnectionEvent = { kind: "held", start };
    expect(step(ANSWERING, held)).toEqual({
      next: HELD,
      effects: [{ kind: "clear-backstop" }, { kind: "start", start }],
    });
    const starting = STATES.filter((s) => kinds(s, held).includes("start"));
    expect(starting).toEqual([ANSWERING]);
  });
});

describe("the close", () => {
  const close: ConnectionEvent = { kind: "close" };

  test("ends a subscription", () => {
    expect(step(STREAMING, close)).toEqual({
      next: CLOSED,
      effects: [{ kind: "unsubscribe", unsubscribe }],
    });
  });

  test("aborts held work", () => {
    expect(step(HELD, close)).toEqual({
      next: CLOSED,
      effects: [{ kind: "leave-in-flight" }, { kind: "abort" }],
    });
  });

  test("is not a departure for an unattended frame", () => {
    expect(step(UNATTENDED, close)).toEqual({
      next: UNATTENDED,
      effects: [],
    });
    expect(clientLeft(UNATTENDED)).toBe(false);
  });

  test("of a client told TIMEOUT keeps that it timed out", () => {
    const { next } = step(TOLD_TIMEOUT, close);
    expect(next).toEqual(CLOSED_LAPSED);
    expect(timedOut(next)).toBe(true);
    expect(clientLeft(next)).toBe(true);
  });

  test("of a waiting client leaves in-flight and the backstop", () => {
    expect(step(ANSWERING, close)).toEqual({
      next: CLOSED,
      effects: [{ kind: "clear-backstop" }, { kind: "leave-in-flight" }],
    });
  });
});

test("an unattended frame's settled handling closes it, lapsed or not", () => {
  expect(step(LAPSED, { kind: "settled" })).toEqual({
    next: CLOSED_LAPSED,
    effects: [{ kind: "leave-in-flight" }],
  });
  const settling = STATES.filter(
    (s) => step(s, { kind: "settled" }).next !== s,
  );
  expect(settling).toEqual([UNATTENDED, LAPSED]);
});

// [LAW:one-source-of-truth] In-flight and the backstop are columns of the
// table: a step leaves either only by crossing its line, and nothing returns
// across it, so each moves once in a connection's life.
describe.each(STATES)("from %o", (s) => {
  test.each(EVENTS)(
    "on %o, in-flight and the backstop move only across their lines",
    (e) => {
      const { next, effects } = step(s, e);
      const count = (kind: string): number =>
        effects.filter((effect) => effect.kind === kind).length;
      expect(count("leave-in-flight")).toBe(
        Number(inFlight(s)) - Number(inFlight(next)),
      );
      expect(count("clear-backstop")).toBe(
        Number(backstopArmed(s)) - Number(backstopArmed(next)),
      );
    },
  );
});

test("timedOut reads the deadline's fact, and nothing else", () => {
  expect(STATES.filter(timedOut)).toEqual([
    LAPSED,
    TOLD_TIMEOUT,
    CLOSED_LAPSED,
  ]);
});

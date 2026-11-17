// A click lands in its session's arrival order, in the daemon's one journal
// turn; a doctor click asks the host for its reading and runs no probe in its
// turn. Clicks here are real verbs; a click is kept in flight by parking
// another turn ahead of it, and the click-path cases drive `replyTo`, the
// daemon's real click arm.

import { RuntimeStats } from "../src/daemon/stats";
import { JournalTurns } from "../src/renderer/journal-turns";
import { MenuIdle } from "../src/daemon/menu-idle";
import type { DaemonParts } from "../src/daemon/daemon-parts";
import { clickParts } from "./helpers/click-parts";
import { signedClick } from "./helpers/link-signer";
import { replyTo } from "../src/daemon/reply";
import { SessionState } from "../src/renderer/session-state";
import {
  VERBS,
  type VerbContext,
  type VerbHandler,
} from "../src/renderer/verbs";
import { SESSION_CLIENT_HINTS_KEY } from "../src/daemon/foundations/session-keys";
import {
  VERB_DISPATCH,
  VERB_DOCTOR_RUN,
  VERB_SET_CONFIG,
  VERB_SET_STATE,
  effectsUrl,
  encodeSegments,
} from "../src/click/wire";
import { ClickAbandoned } from "../src/daemon/foundations/verb-error";
import type { ConfigLoad } from "../src/doctor/ports";
import { instantOf } from "../src/utils/instant";
import { emptyStores } from "./helpers/doctor-facts";
import {
  recordRender,
  testVerbContext,
  verbContextWith,
  withDoctor,
} from "./helpers/click";
import { EMPTY_DEFAULT, parseAndValidate } from "./helpers/parse-and-validate";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { listResolvablePaletteNames } from "../src/themes/policy";
import { durableConfig } from "./helpers/durable-config";
import { systemTimekeeper } from "../src/time";
import { sessionIdOf, type SessionId } from "../src/daemon/foundations/session-id";

const ALLOWED = new Set(listResolvablePaletteNames());
const A = sessionIdOf("session-a");
const S = sessionIdOf("s");
const LOAD: ConfigLoad = {
  layers: [],
  error: null,
  warning: null,
  unused: [],
  config: EMPTY_DEFAULT,
};

function gate(): { wait: Promise<void>; open: () => void } {
  let open = (): void => {};
  const wait = new Promise<void>((resolve) => (open = resolve));
  return { wait, open };
}

async function drain(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

function setup() {
  const sessionState = new SessionState();
  const logged: string[] = [];
  const base = testVerbContext(sessionState, undefined, EMPTY_DEFAULT);
  const turns = new JournalTurns({
    monotonic: () => systemTimekeeper.monotonic(),
    changesLanded: () => base.configWrites.landed(),
  });
  recordRender(sessionState, A);
  sessionState.set(A, SESSION_CLIENT_HINTS_KEY, "{}");
  const ctx = withDoctor(
    verbContextWith(base, {
      journalTurns: turns,
      log: (_level, line) => logged.push(line),
    }),
    { stores: emptyStores(), load: LOAD },
  );
  // Another click's turn, held until the gate opens: every click after it
  // waits in the queue, in flight.
  const parkTurn = () => {
    const parked = gate();
    const holding = turns.take(
      "parked",
      { waited: () => {}, gone: async () => false },
      () => parked.wait,
    );
    return { open: parked.open, holding };
  };
  const written = (sid: SessionId) => sessionState.get(sid, "theme");
  const doctor = (sid: string, c: VerbContext = ctx) =>
    VERBS.get(VERB_DOCTOR_RUN)!(encodeURIComponent(sid), c);
  const write = (sid: string, c: VerbContext = ctx) =>
    VERBS.get(VERB_SET_STATE)!(encodeSegments([sid, "theme", "nord"]), c);
  return { sessionState, logged, turns, ctx, parkTurn, written, doctor, write };
}

describe("a doctor click", () => {
  test("runs no probe in its turn: it ends with the run asked of the host, and a write behind it lands at once", async () => {
    const { ctx, doctor, write, written } = setup();
    await doctor(A);
    expect(ctx.doctorRuns.subscriptions().get(A)).toMatchObject({
      kind: "doctor",
      ask: { run: 1 },
    });
    await write(A);
    expect(written(A)).toBe("nord");
  });

  // A click lands whole, when it ends: its doctor judges the config the click
  // found, and the write is there for the next click.
  test("a `do` of set-config then doctor judges the config the click found", async () => {
    const fixture = durableConfig();
    try {
      const sessionState = new SessionState();
      fixture.seedOrigin(sessionState, A);
      sessionState.set(A, SESSION_CLIENT_HINTS_KEY, "{}");
      const config = parseAndValidate(
        "<user>",
        `{ actions: { pal: { persist: 'palette', from: 'themes' } } }`,
        ALLOWED,
        DEFAULT_DSL_CONFIG,
      );
      const seen: Array<string | null> = [];
      const ctx = verbContextWith(
        withDoctor(
          testVerbContext(
            sessionState,
            fixture.historyFor(sessionState),
            config,
            fixture.host,
          ),
          { stores: emptyStores(), load: LOAD },
        ),
        {
          doctorLoad: () => {
            seen.push(fixture.text());
            return LOAD;
          },
        },
      );
      const url = effectsUrl([
        { verb: VERB_SET_CONFIG, args: [A, "user", "palette", [...ALLOWED][0]!] },
        { verb: VERB_DOCTOR_RUN, args: [A] },
      ]);
      await VERBS.get(VERB_DISPATCH)!(url.slice(url.lastIndexOf("/") + 1), ctx);
      expect(seen).toEqual([null]);
      expect(fixture.text()).toContain("palette");
    } finally {
      fixture.dispose();
    }
  });
});

describe("one session's order", () => {
  test("a click whose client left while it queued behind another turn is refused, and writes nothing", async () => {
    const { ctx, parkTurn, write, written } = setup();
    const parked = parkTurn();
    const later = write(A, { ...ctx, clientGone: async () => true });
    const refused = expect(later).rejects.toBeInstanceOf(ClickAbandoned);
    parked.open();
    await parked.holding;
    await refused;
    expect(written(A)).toBeNull();
  });

  test("a click queued behind its session's own click reports the wait; a menu with a click in flight draws no countdown", async () => {
    const { ctx, parkTurn, write } = setup();
    const parked = parkTurn();
    const waits: number[] = [];
    const first = write(A);
    const later = write(A, { ...ctx, placeWaited: (ms) => waits.push(ms) });
    await new Promise((r) => setTimeout(r, 20));
    parked.open();
    await Promise.all([parked.holding, first, later]);
    expect(waits).toHaveLength(1);
    expect(waits[0]).toBeGreaterThan(0);

    const idle = new MenuIdle({
      clock: systemTimekeeper,
      now: () => instantOf(new Date(100000)),
      close: async () => null,
      failed: () => {},
    });
    idle.observe(A, instantOf(new Date(100000)), true, 30);
    expect(idle.since(A, instantOf(new Date(100000)))).toBeDefined();
    idle.clickArrived(A);
    expect(idle.since(A, instantOf(new Date(100000)))).toBeUndefined();
    idle.clickSettled(A);
    expect(idle.since(A, instantOf(new Date(100000)))).toBeDefined();
    idle.dispose();
  });
});

describe("the idle clock", () => {
  function clock() {
    let now = 1000;
    const closes: string[] = [];
    const idle = new MenuIdle({
      clock: systemTimekeeper,
      now: () => instantOf(new Date(now * 1000)),
      close: async (sid, { firedAt }) => {
        idle.confirmClose(sid, firedAt);
        closes.push(sid);
        return null;
      },
      failed: () => {},
    });
    const at = () => instantOf(new Date(now * 1000));
    return {
      idle,
      closes,
      at,
      advance: async (s: number) => {
        now += s;
        await jest.advanceTimersByTimeAsync(s * 1000);
      },
    };
  }
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test("past the deadline no timer is armed and no close runs; the deadline returns as the click settles", async () => {
    const c = clock();
    c.idle.observe(S, c.at(), true, 30);
    c.idle.clickArrived(S);
    expect(c.idle.getStats()).toMatchObject({ armed: 0, pending: 1 });
    await c.advance(60);
    expect(c.closes).toEqual([]);
    expect(c.idle.getStats().armed).toBe(0);
    c.idle.clicked(S, c.at());
    c.idle.clickSettled(S);
    expect(c.idle.getStats()).toMatchObject({ armed: 1, pending: 0 });
    await c.advance(30);
    expect(c.closes).toEqual(["s"]);
    c.idle.dispose();
  });

  test("an abandoned click does not move the clock", async () => {
    const c = clock();
    c.idle.observe(S, c.at(), true, 30);
    await c.advance(20);
    c.idle.clickArrived(S);
    await c.advance(5);
    c.idle.clickSettled(S);
    expect(c.idle.since(S, c.at())).toBe(1000);
    await c.advance(5);
    expect(c.closes).toEqual(["s"]);
    c.idle.dispose();
  });

  test("eviction of an abandoned click's record leaves pending intact, and settling throws nothing", async () => {
    const c = clock();
    c.idle.clicked(S, c.at());
    c.idle.clickArrived(S);
    for (let i = 0; i < 256; i++)
      c.idle.clicked(sessionIdOf(`other${i}`), c.at());
    expect(c.idle.getStats().pending).toBe(1);
    expect(() => c.idle.clickSettled(S)).not.toThrow();
    expect(c.idle.getStats().pending).toBe(0);
    c.idle.dispose();
  });
});

// The daemon's click arm over `ctx`'s verbs, with what its host parts hand in.
function clickArm(
  ctx: VerbContext,
  over: {
    readonly menuIdle: Pick<MenuIdle, "clickArrived" | "clickSettled">;
    readonly log?: (level: string, line: string) => void;
    readonly collector?: Parameters<typeof clickParts>[2];
  },
) {
  const {
    arrival: _a,
    turnWaited: _t,
    placeWaited: _p,
    clientGone: _c,
    latest: _l,
    ...verbCtx
  } = ctx;
  const parts = {
    clock: { monotonic: () => performance.now(), now: () => Date.now() },
    menuIdle: over.menuIdle,
    payloadProviders: {},
    frameFeeds: { latest: () => null },
    log: over.log ?? (() => {}),
    ...clickParts(verbCtx, over.menuIdle, over.collector),
  } as unknown as DaemonParts;
  return (verb: string, value: string, gone: () => boolean) =>
    replyTo(
      parts,
      signedClick(verb, value) as Parameters<typeof replyTo>[1],
      () => false,
      new RuntimeStats(systemTimekeeper).accept(),
      gone,
    );
}

const WRITE_A = encodeSegments([A, "theme", "nord"]);

test("the click path counts a click pending from arrival, through a refusal", async () => {
  const { ctx, parkTurn } = setup();
  const idle = new MenuIdle({
    clock: systemTimekeeper,
    now: () => instantOf(new Date()),
    close: async () => null,
    failed: () => {},
  });
  const send = clickArm(ctx, { menuIdle: idle });
  const parked = parkTurn();
  const sent = send(VERB_SET_STATE, WRITE_A, () => false);
  await drain();
  expect(idle.getStats().pending).toBe(1);
  parked.open();
  await sent;
  expect(idle.getStats().pending).toBe(0);
  await send(VERB_SET_STATE, WRITE_A, () => true);
  expect(idle.getStats().pending).toBe(0);
  idle.dispose();
});

test("a click's turn holds its session in the collector while it runs, with nothing held by the click path, and lets go whether it lands or is refused", async () => {
  const { ctx, parkTurn } = setup();
  const idle = new MenuIdle({
    clock: systemTimekeeper,
    now: () => instantOf(new Date()),
    close: async () => null,
    failed: () => {},
  });
  // The collector's holds, as the sweep reads them: how many are taken and
  // not yet let go, per session.
  const holds = new Map<string, number>();
  let taken = 0;
  const holding = (session: string) => {
    taken++;
    holds.set(session, (holds.get(session) ?? 0) + 1);
    return () => void holds.set(session, holds.get(session)! - 1);
  };
  const send = clickArm(ctx, {
    menuIdle: idle,
    collector: { holding, clicked: () => {} },
  });
  const parked = parkTurn();
  const sent = send(VERB_SET_STATE, WRITE_A, () => false);
  await drain();
  expect(holds.get(A)).toBe(1);
  parked.open();
  await sent;
  expect(holds.get(A)).toBe(0);
  await send(VERB_SET_STATE, WRITE_A, () => true);
  expect(taken).toBe(2);
  expect(holds.get(A)).toBe(0);
  idle.dispose();
});

test("a click whose session will not decode is a bad request whose event still names its verb", async () => {
  const { ctx } = setup();
  const events: string[] = [];
  const send = clickArm(ctx, {
    menuIdle: { clickArrived: () => {}, clickSettled: () => {} },
    log: (_level, line) => events.push(line),
  });
  // An escape that is no UTF-8: the one malformed segment a signed link,
  // whose bare `%` is escaped, can still carry.
  const { resp } = await send(VERB_DOCTOR_RUN, "%C0", () => false);
  expect(resp).toMatchObject({ ok: false, code: "BAD_REQUEST" });
  expect(events).toEqual([
    expect.stringMatching(new RegExp(` verb=${VERB_DOCTOR_RUN} `)),
  ]);
});

test("tsc refuses the host's edges in a VerbHandler", () => {
  const handler: VerbHandler = async (_value, ctx) => {
    // @ts-expect-error A handler reaches launches through the turn alone.
    void ctx.launcher;
    // @ts-expect-error The doctor's probes are the host's to run.
    void ctx.doctor;
    // @ts-expect-error As the launcher.
    void ctx.claudeInput;
  };
  expect(handler).toBeDefined();
});

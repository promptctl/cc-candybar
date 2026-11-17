// Clicks and idle closes in the renderer's mailbox: each one turn, in arrival
// order, made as its turn comes. A click is kept in flight by holding another
// turn ahead of it in the mailbox; the clicks are real verbs, sent through
// `replyTo`, the daemon's real click arm.

import { RuntimeStats } from "../src/daemon/stats";
import { closeByTurn, MenuIdle } from "../src/daemon/menu-idle";
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
  VERB_TMUX_STATUS_CLICK,
  VERB_UNDO,
  effectsUrl,
  encodeSegments,
} from "../src/click/wire";
import type { Failure } from "../src/daemon/foundations/verb-error";
import type { ConfigLoad } from "../src/doctor/ports";
import { instantOf } from "../src/utils/instant";
import { fieldOf, fieldsOf } from "../src/utils/logfmt";
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
import { sessionIdOf } from "../src/daemon/foundations/session-id";
import { undoOf } from "./helpers/history-step";

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
const IDLE = { firedAt: instantOf(new Date(0)), idleS: 30, timeoutS: 30 };

// A click reaches its turn some microtasks after it is sent, under real timers
// and fake ones alike.
async function drain(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

// The daemon's click arm over one session's verbs: its idle clock closes
// through the same mailbox, on a clock the case moves.
function setup(
  over: {
    readonly collector?: Parameters<typeof clickParts>[1];
    readonly linkAt?: () => unknown;
  } = {},
) {
  const sessionState = new SessionState();
  const logged: string[] = [];
  recordRender(sessionState, A);
  sessionState.set(A, SESSION_CLIENT_HINTS_KEY, "{}");
  const ctx = withDoctor(
    verbContextWith(
      testVerbContext(sessionState, undefined, EMPTY_DEFAULT),
      { log: (_level, line) => logged.push(line) },
    ),
    { stores: emptyStores(), load: LOAD },
  );
  const { arrival: _a, latest: _l, effects: _e, ...verbCtx } = ctx;
  const host = clickParts(verbCtx, over.collector);
  let now = 1000;
  const at = () => instantOf(new Date(now * 1000));
  const failures: Failure[] = [];
  const idle: MenuIdle = new MenuIdle({
    clock: systemTimekeeper,
    now: at,
    close: (sid, span) =>
      closeByTurn(
        host.renderer,
        at,
        sid,
        span,
        () => null,
        () => idle.confirmClose(sid, span.firedAt),
      ),
    failed: (_sid, failure) => failures.push(failure),
  });
  const events: string[] = [];
  const parts = {
    clock: { monotonic: () => performance.now(), now: () => Date.now() },
    menuIdle: idle,
    payloadProviders: {},
    frameFeeds: { latest: () => null },
    log: (_level: string, line: string) => events.push(line),
    tmuxStatusLines: { linkAt: over.linkAt ?? (() => ({ kind: "link", url: "" })) },
    ...host,
  } as unknown as DaemonParts;
  const stats = new RuntimeStats(systemTimekeeper);
  const send = (verb: string, value: string, gone = () => false) =>
    replyTo(
      parts,
      signedClick(verb, value) as Parameters<typeof replyTo>[1],
      () => false,
      stats.accept(),
      gone,
    );
  // A click writing `theme`, then `endcaps`, as one dispatch.
  const dispatch = (theme: string, style: string) => {
    const url = effectsUrl([
      { verb: VERB_SET_STATE, args: [A, "theme", theme] },
      { verb: VERB_SET_STATE, args: [A, "endcaps", style] },
    ]);
    return send(VERB_DISPATCH, url.slice(url.lastIndexOf("/") + 1));
  };
  const write = (theme: string, gone?: () => boolean) =>
    send(VERB_SET_STATE, encodeSegments([A, "theme", theme]), gone);
  // An idle close of A's menus, as the clock fires one.
  const closeIdle = () =>
    closeByTurn(host.renderer, at, A, IDLE, () => null, () => true);
  return {
    sessionState,
    ctx,
    logged,
    events,
    idle,
    failures,
    at,
    advance: (s: number) => {
      now += s;
      jest.advanceTimersByTime(s * 1000);
    },
    park: host.park,
    renderer: host.renderer,
    send,
    dispatch,
    write,
    closeIdle,
    theme: () => sessionState.get(A, "theme"),
    undoDepth: () => ctx.history.depth(A).undo,
  };
}

describe("a doctor click", () => {
  test("runs no probe in its turn: it ends with the run asked of the host, and a write behind it lands at once", () => {
    const { ctx, theme } = setup();
    VERBS.get(VERB_DOCTOR_RUN)!(encodeURIComponent(A), ctx);
    expect(ctx.doctorRuns.subscriptions().get(A)).toMatchObject({
      kind: "doctor",
    });
    VERBS.get(VERB_SET_STATE)!(encodeSegments([A, "theme", "nord"]), ctx);
    expect(theme()).toBe("nord");
  });

  // A click lands whole, when it ends: its doctor judges the config the click
  // found, and the write is there for the next click.
  test("a `do` of set-config then doctor judges the config the click found", () => {
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
      VERBS.get(VERB_DISPATCH)!(url.slice(url.lastIndexOf("/") + 1), ctx);
      expect(seen).toEqual([null]);
      expect(fixture.text()).toContain("palette");
    } finally {
      fixture.dispose();
    }
  });
});

describe("the mailbox's order", () => {
  test("two clicks sent together land in order, one undo step each", async () => {
    const { ctx, sessionState, park, dispatch, theme, undoDepth, idle } =
      setup();
    const parked = park();
    const first = dispatch("nord", "plain");
    const second = dispatch("dracula", "powerline");
    await drain();
    expect(theme()).toBeNull();
    parked.open();
    await Promise.all([parked.holding, first, second]);
    expect(theme()).toBe("dracula");
    expect(sessionState.get(A, "endcaps")).toBe("powerline");
    expect(undoDepth()).toBe(2);
    undoOf(ctx.history, A);
    expect(theme()).toBe("nord");
    expect(sessionState.get(A, "endcaps")).toBe("plain");
    idle.dispose();
  });

  test("an idle close sent behind a click is a turn of its own, after it", async () => {
    const { sessionState, park, dispatch, closeIdle, undoDepth, idle } =
      setup();
    const parked = park();
    const slow = dispatch("nord", "plain");
    await drain();
    let closed = false;
    const closing = closeIdle().then(() => (closed = true));
    await drain();
    expect(closed).toBe(false);
    parked.open();
    await Promise.all([parked.holding, slow, closing]);
    expect(sessionState.get(A, "endcaps")).toBe("plain");
    expect(undoDepth()).toBe(1);
    idle.dispose();
  });

  test("a click whose client left while it waited never lands, so it reverts no toggle", async () => {
    const { park, write, theme, events, idle } = setup();
    const parked = park();
    const first = write("nord");
    const left = write("dracula", () => true);
    parked.open();
    await Promise.all([parked.holding, first, left]);
    expect(theme()).toBe("nord");
    expect(events.map((e) => fieldsOf(e).get("abandoned"))).toEqual([
      undefined,
      "1",
    ]);
    idle.dispose();
  });

  test("a click's event says how long it waited in the mailbox", async () => {
    const { park, write, events, idle } = setup();
    const parked = park();
    const sent = write("nord");
    await new Promise((r) => setTimeout(r, 20));
    parked.open();
    await Promise.all([parked.holding, sent]);
    expect(Number(fieldOf(events[0]!, "mailbox")!.replace("ms", ""))).toBeGreaterThan(
      0,
    );
    idle.dispose();
  });

  test("stats name the input in the renderer's turn and what waits behind it", async () => {
    const { park, write, renderer, theme, idle } = setup();
    const parked = park();
    await drain();
    const queued = write("nord");
    await drain();
    expect(renderer.stats()).toMatchObject({ holder: "start", queued: 1 });
    parked.open();
    await Promise.all([parked.holding, queued]);
    expect(theme()).toBe("nord");
    expect(renderer.stats()).toEqual({ holder: null, heldMs: 0, queued: 0 });
    idle.dispose();
  });
});

describe("the idle close decides as its turn comes", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test("a close waiting behind another turn keeps what a click arriving behind it opens", async () => {
    const { idle, at, advance, park, logged } = setup();
    idle.observe(A, at(), true, 30);
    const parked = park();
    await drain();
    advance(30);
    idle.clickArrived(A);
    parked.open();
    await jest.advanceTimersByTimeAsync(0);
    await parked.holding;
    await drain();
    idle.clickSettled(A);
    expect(logged).toContain(`menu-idle: no longer idle, kept (session=${A})`);
    expect(logged.filter((l) => l.startsWith("menu-idle: closed="))).toEqual(
      [],
    );
    idle.dispose();
  });

  test("a close whose session was evicted while it waited keeps what its click opened", async () => {
    const { idle, at, advance, park, logged } = setup();
    idle.observe(A, at(), true, 30);
    const parked = park();
    await drain();
    advance(30);
    for (let i = 0; i < 256; i++) idle.clicked(sessionIdOf(`other${i}`), at());
    idle.clicked(A, at());
    parked.open();
    await jest.advanceTimersByTimeAsync(0);
    await parked.holding;
    await drain();
    expect(logged).toContain(`menu-idle: no longer idle, kept (session=${A})`);
    idle.dispose();
  });

  test("a close the renderer refuses goes to failed, and is no unhandled rejection", async () => {
    const { idle, at, advance, ctx, failures } = setup();
    const unhandled: unknown[] = [];
    const heard = (e: unknown): void => void unhandled.push(e);
    process.on("unhandledRejection", heard);
    ctx.configWrites.close();
    idle.observe(A, at(), true, 30);
    advance(30);
    await jest.advanceTimersByTimeAsync(0);
    await drain();
    process.off("unhandledRejection", heard);
    expect(failures).toHaveLength(1);
    expect(failures[0]!.message).toContain("the daemon closed");
    expect(unhandled).toEqual([]);
    idle.dispose();
  });
});

describe("close", () => {
  test("an idle close waiting in the mailbox lands nothing once the daemon closes", async () => {
    const { ctx, sessionState, park, closeIdle, undoDepth, idle } = setup();
    const before = sessionState.revision(A);
    const parked = park();
    const closing = closeIdle();
    await drain();
    ctx.configWrites.close();
    parked.open();
    expect((await closing)?.message).toContain("the daemon closed");
    expect(sessionState.revision(A)).toBe(before);
    expect(undoDepth()).toBe(0);
    idle.dispose();
  });

  test("a click that landed before the close stays one step", async () => {
    const { ctx, dispatch, undoDepth, idle } = setup();
    await dispatch("nord", "plain");
    ctx.configWrites.close();
    expect(undoDepth()).toBe(1);
    idle.dispose();
  });

  test("a click waiting in the mailbox as the daemon closes is refused, as a `closing` outcome at info", async () => {
    const { ctx, park, write, events, undoDepth, idle } = setup();
    const parked = park();
    const queued = write("dracula");
    await drain();
    ctx.configWrites.close();
    parked.open();
    const { resp } = await queued;
    expect(resp).toMatchObject({
      ok: false,
      error: expect.stringContaining("the daemon closed"),
    });
    expect(events[0]).toContain("closing=");
    expect(undoDepth()).toBe(0);
    idle.dispose();
  });
});

describe("the click path", () => {
  test("a BadVerbArgs thrown in the handler reaches the client", async () => {
    const { send, events, idle } = setup();
    const { resp } = await send(VERB_UNDO, encodeSegments([A]));
    expect(resp).toMatchObject({
      ok: false,
      code: "BAD_REQUEST",
      error: expect.stringContaining("nothing to undo"),
    });
    expect(events[0]).toMatch(/ mailbox=\d+ms /);
    idle.dispose();
  });

  test("a click's event names the request it was accepted as", async () => {
    const { send, events, idle } = setup();
    await send(VERB_UNDO, encodeSegments([A]));
    await send(VERB_UNDO, encodeSegments([A]));
    expect(events.map((e) => fieldOf(e, "req"))).toEqual(["1", "2"]);
    idle.dispose();
  });

  test("a status-line link naming a verb re-enters without deadlock", async () => {
    const url = `cc-candybar://${VERB_UNDO}/${encodeSegments([A])}`;
    const { send, idle } = setup({ linkAt: () => ({ kind: "link", url }) });
    const { resp } = await send(VERB_TMUX_STATUS_CLICK, "ignored");
    expect(resp).toMatchObject({ ok: false, code: "BAD_REQUEST" });
    idle.dispose();
  });

  test("a status-line click that throws is its outcome, and writes its event", async () => {
    const { send, events, idle } = setup({
      linkAt: () => {
        throw new Error("the opener failed");
      },
    });
    const { resp } = await send(VERB_TMUX_STATUS_CLICK, "ignored");
    expect(resp).toMatchObject({
      ok: false,
      error: expect.stringContaining("the opener failed"),
    });
    expect(events).toHaveLength(1);
    expect(fieldOf(events[0]!, "verb")).toBe(VERB_TMUX_STATUS_CLICK);
    idle.dispose();
  });

  test("a click counts as pending from its arrival, through a refusal", async () => {
    const { park, write, idle } = setup();
    const parked = park();
    const sent = write("nord");
    await drain();
    expect(idle.getStats().pending).toBe(1);
    parked.open();
    await sent;
    expect(idle.getStats().pending).toBe(0);
    await write("nord", () => true);
    expect(idle.getStats().pending).toBe(0);
    idle.dispose();
  });

  test("a click's turn holds its session in the collector while it runs and not while it waits; a refused click holds nothing", async () => {
    // The collector's holds, as the sweep reads them: how many are taken and
    // not yet let go, per session.
    const holds = new Map<string, number>();
    let taken = 0;
    const holding = (session: string) => {
      taken++;
      holds.set(session, (holds.get(session) ?? 0) + 1);
      return () => void holds.set(session, holds.get(session)! - 1);
    };
    const { park, write, idle } = setup({
      collector: { holding, clicked: () => {} },
    });
    const parked = park();
    const sent = write("nord");
    await drain();
    expect(holds.get(A)).toBeUndefined();
    parked.open();
    await sent;
    expect(taken).toBe(1);
    expect(holds.get(A)).toBe(0);
    await write("nord", () => true);
    expect(taken).toBe(1);
    idle.dispose();
  });

  test("a click whose session will not decode is a bad request whose event still names its verb", async () => {
    const { send, events, idle } = setup();
    // An escape that is no UTF-8: the one malformed segment a signed link,
    // whose bare `%` is escaped, can still carry.
    const { resp } = await send(VERB_DOCTOR_RUN, "%C0");
    expect(resp).toMatchObject({ ok: false, code: "BAD_REQUEST" });
    expect(events).toEqual([
      expect.stringMatching(new RegExp(` verb=${VERB_DOCTOR_RUN} `)),
    ]);
    idle.dispose();
  });
});

test("a navigation commit that throws leaves the settings journal committed", () => {
  const { ctx, theme, undoDepth, idle } = setup();
  const begin = ctx.navigation.begin.bind(ctx.navigation);
  jest.spyOn(ctx.navigation, "begin").mockImplementation((store) => ({
    ...begin(store),
    commit: () => {
      throw new Error("navigation broke");
    },
  }));
  expect(() =>
    VERBS.get(VERB_SET_STATE)!(encodeSegments([A, "theme", "nord"]), ctx),
  ).toThrow("navigation broke");
  expect(undoDepth()).toBe(1);
  undoOf(ctx.history, A);
  expect(theme()).toBeNull();
  idle.dispose();
});

test("a verb stamps its session's landing, though its handler threw", () => {
  const { ctx, idle } = setup();
  const landed: string[] = [];
  expect(() =>
    VERBS.get(VERB_UNDO)!(encodeSegments([A]), {
      ...ctx,
      clickLanded: (sid) => landed.push(sid),
    }),
  ).toThrow("nothing to undo");
  expect(landed).toEqual([A]);
  idle.dispose();
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

  test("a menu with a click in flight draws no countdown", () => {
    const c = clock();
    c.idle.observe(A, c.at(), true, 30);
    expect(c.idle.since(A, c.at())).toBeDefined();
    c.idle.clickArrived(A);
    expect(c.idle.since(A, c.at())).toBeUndefined();
    c.idle.clickSettled(A);
    expect(c.idle.since(A, c.at())).toBeDefined();
    c.idle.dispose();
  });

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

  test("eviction of an abandoned click's record leaves pending intact, and settling throws nothing", () => {
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

test("tsc refuses the host's edges in a VerbHandler", () => {
  const handler: VerbHandler = (_value, ctx: VerbContext) => {
    // @ts-expect-error A handler reaches launches through the turn alone.
    void ctx.launcher;
    // @ts-expect-error The doctor's probes are the host's to run.
    void ctx.doctor;
    // @ts-expect-error As the launcher.
    void ctx.claudeInput;
  };
  expect(handler).toBeDefined();
});

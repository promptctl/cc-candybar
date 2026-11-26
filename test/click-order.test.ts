// Clicks and idle closes in the renderer's mailbox: each one turn, in arrival
// order, made as its turn comes. A click is kept in flight by holding another
// turn ahead of it in the mailbox; the clicks are real verbs, sent through
// `replyTo`, the daemon's real click arm.

import { RuntimeStats } from "../src/daemon/stats";
import type { DaemonParts } from "../src/daemon/daemon-parts";
import { clickParts } from "./helpers/click-parts";
import { signedClick } from "./helpers/link-signer";
import { replyTo } from "../src/daemon/reply";
import { SessionState } from "../src/renderer/session-state";
import {
  type VerbContext,
  type VerbHandler,
} from "../src/renderer/verbs";
import {
  VERB_DISPATCH,
  VERB_SET_STATE,
  VERB_UNDO,
  effectsUrl,
  encodeSegments,
} from "../src/click/wire";
import { tickAt, type Tick } from "../src/utils/instant";
import { fieldOf, fieldsOf } from "../src/utils/logfmt";
import {
  recordRender,
  linkClick,
  testVerbContext,
  verbContextWith,
  CLICK_VERBS,
} from "./helpers/click";
import { EMPTY_DEFAULT } from "../scripts/lib/draw-fixtures/parse-and-validate";
import { type Timekeeper } from "../src/time";
import { sessionIdOf } from "../src/daemon/foundations/session-id";
import { NO_LAYERS, undoOf } from "./helpers/history-step";
import { heldClock } from "./helpers/held-clock";
import { FOREGROUND_BURST } from "../src/utils/keyed-serial-queue";

const A = sessionIdOf("session-a");
const S = sessionIdOf("s");

// A click reaches its turn some microtasks after it is sent, under real timers
// and fake ones alike.
async function drain(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

// The daemon's click arm over one session's verbs: its idle closes are `due`
// turns in the same mailbox.
function setup(
  over: {
    readonly collector?: Parameters<typeof clickParts>[1];
    readonly clock?: Timekeeper;
  } = {},
) {
  const sessionState = new SessionState();
  const logged: string[] = [];
  recordRender(sessionState, A);
  const ctx = verbContextWith(testVerbContext(sessionState, undefined, EMPTY_DEFAULT), {
    log: (_level, line) => logged.push(line),
  });
  const { context: _c, effects: _e, ...verbCtx } = ctx;
  const clock = over.clock ?? heldClock(new Date(0));
  const host = clickParts(verbCtx, over.collector, undefined, clock);
  const events: string[] = [];
  const parts = {
    clock,
    payloadProviders: {},
    frameFeeds: { latest: () => null },
    log: (_level: string, line: string) => events.push(line),
    ...host,
  } as unknown as DaemonParts;
  const stats = new RuntimeStats(clock);
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
  // A wake of the renderer's: the idle closes due as its turn comes.
  const due = () =>
    host.renderer.deliver(
      () => ({ kind: "event", event: { kind: "due" } }),
      [],
    );
  return {
    sessionState,
    ctx,
    logged,
    events,
    menuIdle: host.menuIdle,
    // A's menu was shown a whole timeout before this fixture clock's current turn.
    shownLongAgo: () => host.menuIdle.drew(A, (tickAt(clock) - 30) as Tick, true, 30),
    park: host.park,
    // The teardown's first renderer step, as the daemon sends it: it takes
    // its place in the mailbox behind every input that arrived before it.
    closeJournal: () => host.renderer.command({ kind: "close-journal" }),
    renderer: host.renderer,
    send,
    dispatch,
    write,
    due,
    theme: () => sessionState.get(A, "theme"),
    undoDepth: () => ctx.history.depth(A).undo,
  };
}

describe("the mailbox's order", () => {
  test("two clicks sent together land in order, one undo step each", async () => {
    const { ctx, sessionState, park, dispatch, theme, undoDepth } = setup();
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
    undoOf(ctx.history, A, NO_LAYERS);
    expect(theme()).toBe("nord");
    expect(sessionState.get(A, "endcaps")).toBe("plain");
  });

  test("a due sent behind a click is a turn of its own, after it", async () => {
    const { sessionState, park, dispatch, due, undoDepth } = setup();
    const parked = park();
    const slow = dispatch("nord", "plain");
    await drain();
    let closed = false;
    const closing = due().then(() => (closed = true));
    await drain();
    expect(closed).toBe(false);
    parked.open();
    await Promise.all([parked.holding, slow, closing]);
    expect(sessionState.get(A, "endcaps")).toBe("plain");
    expect(undoDepth()).toBe(1);
  });

  test("a click whose client left while it waited never lands, so it reverts no toggle", async () => {
    const { park, write, theme, events } = setup();
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
  });

  test("a click's event says how long it waited in the mailbox", async () => {
    const clock = heldClock(new Date(0));
    clock.advance(1_000);
    const { park, write, events, renderer } = setup({ clock });
    const parked = park();
    const sent = write("nord");
    await clock.settle(0);
    expect(renderer.stats()).toMatchObject({ holder: "start", queued: 1 });
    clock.advance(37);
    parked.open();
    await Promise.all([parked.holding, sent]);
    expect(events.map((event) => fieldOf(event, "mailbox"))).toEqual(["37ms"]);
  });

  test("stats name the input in the renderer's turn and what waits behind it", async () => {
    const { park, write, renderer, theme } = setup();
    const parked = park();
    await drain();
    const queued = write("nord");
    await drain();
    expect(renderer.stats()).toMatchObject({ holder: "start", queued: 1 });
    parked.open();
    await Promise.all([parked.holding, queued]);
    expect(theme()).toBe("nord");
    expect(renderer.stats()).toEqual({ holder: null, heldMs: 0, queued: 0 });
  });
});

describe("the idle close decides as its turn comes", () => {
  const closes = (logged: readonly string[]) =>
    logged.filter((line) => line.startsWith("menu-idle:"));

  test("a due closes the menus of a session idle past its timeout", async () => {
    const { shownLongAgo, due, logged } = setup();
    shownLongAgo();
    expect(await due()).toMatchObject({ kind: "answered" });
    expect(closes(logged)).toEqual([
      expect.stringMatching(
        new RegExp(`^menu-idle: closed=.* timeout=30s \\(session=${A}\\)$`),
      ),
    ]);
  });

  test("a scheduled due closes another session's menu while leaving a queued click's menu open", async () => {
    const clock = heldClock(new Date(0));
    const { menuIdle, park, renderer, sessionState, write, theme, logged } = setup({ clock });
    const other = sessionIdOf("session-b");
    recordRender(sessionState, other);
    menuIdle.drew(A, tickAt(clock), true, 30);
    menuIdle.drew(other, tickAt(clock), true, 30);
    const viewers = () => ({ kind: "event", event: { kind: "viewers", viewers: {} } }) as const;
    await renderer.deliver(viewers, []);
    const parked = park();
    const foreground = Array.from({ length: FOREGROUND_BURST }, () => renderer.deliver(viewers, []));
    clock.advance(30_000);
    let beforeClick: readonly string[] = [];
    const atNextOrdinarySlot = renderer.deliver(() => {
      beforeClick = closes(logged);
      return viewers();
    }, []);
    const clicked = write("nord");
    parked.open();
    await Promise.all([parked.holding, ...foreground, atNextOrdinarySlot, clicked]);
    expect(beforeClick).toEqual([
      expect.stringContaining(`(session=${other})`),
    ]);
    expect(theme()).toBe("nord");
    expect(closes(logged)).toEqual(beforeClick);
    expect(menuIdle.next()).toBe(60);
    renderer.closeWake();
  });

  test("a due waiting behind a click finds the period the click restarted, and closes nothing", async () => {
    const { menuIdle, shownLongAgo, due, park, write, logged } = setup();
    shownLongAgo();
    const parked = park();
    const clicked = write("nord");
    const closing = due();
    await drain();
    parked.open();
    await Promise.all([parked.holding, clicked, closing]);
    expect(closes(logged)).toEqual([]);
    expect(menuIdle.next()).not.toBeNull();
  });
});

// The close takes its place in the mailbox in arrival order: what arrived
// before it runs whole, and what arrived after it is refused.
describe("close", () => {
  test("a due behind the close in the mailbox lands nothing", async () => {
    const {
      closeJournal,
      sessionState,
      park,
      due,
      undoDepth,
      shownLongAgo,
      logged,
    } = setup();
    shownLongAgo();
    const before = sessionState.revision(A);
    const parked = park();
    const closed = closeJournal();
    const closing = due();
    await drain();
    parked.open();
    await closed;
    // The turn answers: its close was refused, as a click's is.
    expect(await closing).toMatchObject({ kind: "answered" });
    expect(logged).toEqual([
      expect.stringMatching(
        new RegExp(
          `^menu-idle: close failed \\(session=${A}\\): .*the daemon closed`,
        ),
      ),
    ]);
    expect(sessionState.revision(A)).toBe(before);
    expect(undoDepth()).toBe(0);
  });

  test("a click that landed before the close stays one step", async () => {
    const { closeJournal, dispatch, undoDepth } = setup();
    await dispatch("nord", "plain");
    await closeJournal();
    expect(undoDepth()).toBe(1);
  });

  test("a click waiting in the mailbox ahead of the close lands whole", async () => {
    const { closeJournal, park, write, theme, undoDepth } = setup();
    const parked = park();
    const queued = write("dracula");
    await drain();
    const closed = closeJournal();
    parked.open();
    expect((await queued).resp).toMatchObject({ ok: true });
    await closed;
    expect(theme()).toBe("dracula");
    expect(undoDepth()).toBe(1);
  });

  test("a click behind the close in the mailbox is refused, as a `closing` outcome at info", async () => {
    const { closeJournal, park, write, events, undoDepth } = setup();
    const parked = park();
    const closed = closeJournal();
    const queued = write("dracula");
    await drain();
    parked.open();
    await closed;
    const { resp } = await queued;
    expect(resp).toMatchObject({
      ok: false,
      error: expect.stringContaining("the daemon closed"),
    });
    expect(events[0]).toContain("closing=");
    expect(undoDepth()).toBe(0);
  });
});

describe("the mailbox's stats", () => {
  test("name the input holding the mailbox for its whole slot, and how many wait behind it", async () => {
    const { renderer, park, write } = setup();
    const parked = park();
    const queued = write("nord");
    await drain();
    expect(renderer.stats()).toMatchObject({ holder: "start", queued: 1 });
    parked.open();
    await queued;
    expect(renderer.stats()).toEqual({ holder: null, heldMs: 0, queued: 0 });
  });
});

describe("the click path", () => {
  test("a BadVerbArgs thrown in the handler reaches the client", async () => {
    const { send, events } = setup();
    const { resp } = await send(VERB_UNDO, encodeSegments([A]));
    expect(resp).toMatchObject({
      ok: false,
      code: "BAD_REQUEST",
      error: expect.stringContaining("nothing to undo"),
    });
    expect(events[0]).toMatch(/ mailbox=\d+ms /);
  });

  test("a click's event names the request it was accepted as", async () => {
    const { send, events } = setup();
    await send(VERB_UNDO, encodeSegments([A]));
    await send(VERB_UNDO, encodeSegments([A]));
    expect(events.map((e) => fieldOf(e, "req"))).toEqual(["1", "2"]);
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
    const { park, write } = setup({
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
  });

  test("a signed batch naming two sessions reaches no renderer turn", async () => {
    const clicked = jest.fn();
    const { send, theme, events } = setup({
      collector: { holding: () => () => {}, clicked },
    });
    const { verb, value } = linkClick(effectsUrl([
      { verb: VERB_SET_STATE, args: [A, "theme", "nord"] },
      { verb: VERB_SET_STATE, args: [S, "theme", "dracula"] },
    ]));

    const { resp } = await send(verb, value);

    expect(resp).toMatchObject({
      ok: false,
      code: "BAD_REQUEST",
      error: expect.stringContaining("more than one session"),
    });
    expect(clicked).not.toHaveBeenCalled();
    expect(theme()).toBeNull();
    expect(events[0]).not.toContain(" mailbox=");
  });

  test("a click whose session will not decode is a bad request whose event still names its verb", async () => {
    const { send, events } = setup();
    // An escape that is no UTF-8: the one malformed segment a signed link,
    // whose bare `%` is escaped, can still carry.
    const { resp } = await send(VERB_UNDO, "%C0");
    expect(resp).toMatchObject({ ok: false, code: "BAD_REQUEST" });
    expect(events).toEqual([
      expect.stringMatching(new RegExp(` verb=${VERB_UNDO} `)),
    ]);
  });
});

test("a navigation commit that throws leaves the settings journal committed", () => {
  const { ctx, theme, undoDepth } = setup();
  const begin = ctx.navigation.begin.bind(ctx.navigation);
  jest.spyOn(ctx.navigation, "begin").mockImplementation((...args) => ({
    ...begin(...args),
    commit: () => {
      throw new Error("navigation broke");
    },
  }));
  expect(() =>
    CLICK_VERBS.get(VERB_SET_STATE)!(encodeSegments([A, "theme", "nord"]), ctx),
  ).toThrow("navigation broke");
  expect(undoDepth()).toBe(1);
  undoOf(ctx.history, A, NO_LAYERS);
  expect(theme()).toBeNull();
});

test("a verb stamps its session's landing, though its handler threw", () => {
  const { ctx } = setup();
  const landed: string[] = [];
  expect(() =>
    CLICK_VERBS.get(VERB_UNDO)!(encodeSegments([A]), {
      ...ctx,
      clickLanded: (sid) => landed.push(sid),
    }),
  ).toThrow("nothing to undo");
  expect(landed).toEqual([A]);
});

test("tsc refuses the host's edges in a VerbHandler", () => {
  const handler: VerbHandler = (_value, ctx: VerbContext) => {
    // @ts-expect-error A handler reaches launches through the turn alone.
    void ctx.launcher;
    // @ts-expect-error As the launcher.
    void ctx.claudeInput;
  };
  expect(handler).toBeDefined();
});

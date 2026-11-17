// Journals in their turns. A click is a real `dispatch`, kept in flight by a
// turn parked ahead of it; the one turn that awaits inside itself is the idle
// close, asking its confirm. The click-path cases drive `replyTo`, the
// daemon's real click arm.

import { signedClick } from "./helpers/link-signer";
import { fieldOf } from "../src/utils/logfmt";
import { RuntimeStats } from "../src/daemon/stats";
import { JournalTurns } from "../src/renderer/journal-turns";
import { MenuIdle } from "../src/daemon/menu-idle";
import type { DaemonParts } from "../src/daemon/daemon-parts";
import { clickParts } from "./helpers/click-parts";
import { replyTo } from "../src/daemon/reply";
import {
  DaemonClosing,
  failureOf,
  type Failure,
} from "../src/daemon/foundations/verb-error";
import { SessionState } from "../src/renderer/session-state";
import { closeIdleMenus, VERBS, type VerbContext } from "../src/renderer/verbs";
import {
  VERB_DISPATCH,
  VERB_SET_STATE,
  VERB_TMUX_STATUS_CLICK,
  VERB_UNDO,
  effectsUrl,
  encodeSegments,
} from "../src/click/wire";
import { instantOf } from "../src/utils/instant";
import { recordRender, testVerbContext,
  verbContextWith } from "./helpers/click";
import { EMPTY_DEFAULT } from "./helpers/parse-and-validate";
import { systemTimekeeper } from "../src/time";
import { sessionIdOf } from "../src/daemon/foundations/session-id";
import { undoOf } from "./helpers/history-step";

const SID = sessionIdOf("s1");
const IDLE = {
  firedAt: instantOf(new Date(0)),
  idleS: 30,
  timeoutS: 30,
  confirm: async () => true,
};

function gate(): { wait: Promise<void>; open: () => void } {
  let open = (): void => {};
  const wait = new Promise<void>((resolve) => (open = resolve));
  return { wait, open };
}

// Another session's click, holding the daemon's turn until `held` opens.
const holdTurn = (turns: JournalTurns, held: Promise<void>): Promise<void> =>
  turns.take("parked", { waited: () => {}, gone: async () => false }, () => held);

function setup() {
  const sessionState = new SessionState();
  recordRender(sessionState, SID);
  const logged: string[] = [];
  const base = testVerbContext(sessionState, undefined, EMPTY_DEFAULT);
  const turns = new JournalTurns({
    monotonic: () => systemTimekeeper.monotonic(),
    changesLanded: () => base.configWrites.landed(),
  });
  const ctx = verbContextWith(base, {
    journalTurns: turns,
    log: (_level, msg) => logged.push(msg),
  });
  // A click writing `theme`, then `style`.
  const click = (theme: string, style: string): Promise<void> => {
    const url = effectsUrl([
      { verb: VERB_SET_STATE, args: [SID, "theme", theme] },
      { verb: VERB_SET_STATE, args: [SID, "endcaps", style] },
    ]);
    return VERBS.get(VERB_DISPATCH)!(url.slice(url.lastIndexOf("/") + 1), ctx);
  };
  // Another turn, held until the gate opens: what is sent after it queues.
  const park = () => {
    const held = gate();
    return { open: held.open, holding: holdTurn(turns, held.wait) };
  };
  // The idle close, in its turn, awaiting its confirm until the gate opens.
  const confirming = () => {
    const held = gate();
    const closing = closeIdleMenus(
      SID,
      null,
      { ...IDLE, confirm: () => held.wait.then(() => true) },
      ctx,
      ctx.effects,
    );
    return { open: held.open, closing };
  };
  // The renderer's `close-journal`.
  const close = (): void => {
    turns.close();
    ctx.configWrites.close();
  };
  return {
    sessionState,
    ctx,
    turns,
    logged,
    click,
    park,
    confirming,
    close,
  };
}

// A click reaches its turn some microtasks after it is sent, under real timers
// and fake ones alike.
async function drain(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

const undoDepth = (ctx: VerbContext): number => ctx.history.depth(SID).undo;

describe("journals take turns", () => {
  test("two clicks queued together apply in order, one undo step each", async () => {
    const { sessionState, ctx, click, park } = setup();
    const parked = park();
    const first = click("nord", "plain");
    const second = click("dracula", "powerline");
    await drain();
    expect(sessionState.get(SID, "theme")).toBeNull();
    parked.open();
    await Promise.all([parked.holding, first, second]);
    expect(sessionState.get(SID, "theme")).toBe("dracula");
    expect(sessionState.get(SID, "endcaps")).toBe("powerline");
    expect(undoDepth(ctx)).toBe(2);
    undoOf(ctx.history, SID);
    expect(sessionState.get(SID, "theme")).toBe("nord");
    expect(sessionState.get(SID, "endcaps")).toBe("plain");
  });

  test("an idle close queued behind a click is a step of its own, after it", async () => {
    const { sessionState, ctx, click, park } = setup();
    const parked = park();
    const slow = click("nord", "plain");
    await drain();
    let closed = false;
    const closing = closeIdleMenus(SID, null, IDLE, ctx, ctx.effects).then(
      () => (closed = true),
    );
    await drain();
    expect(closed).toBe(false);
    parked.open();
    await Promise.all([parked.holding, slow, closing]);
    expect(sessionState.get(SID, "endcaps")).toBe("plain");
    expect(undoDepth(ctx)).toBe(1);
  });
});

describe("the idle close decides in its turn", () => {
  function idleOver(ctx: VerbContext) {
    let now = 1000;
    const failures: Failure[] = [];
    const fired: Array<Promise<void>> = [];
    const idle = new MenuIdle({
      clock: systemTimekeeper,
      now: () => instantOf(new Date(now * 1000)),
      close: async (sid, closing) => {
        const running = closeIdleMenus(
          sid,
          null,
          {
            ...closing,
            confirm: async () => idle.confirmClose(sid, closing.firedAt),
          },
          ctx,
          ctx.effects,
        );
        fired.push(running);
        return running.then(
          () => null,
          (e: unknown) => failureOf(e),
        );
      },
      failed: (_sid, e) => failures.push(e),
    });
    return {
      idle,
      failures,
      fired,
      at: () => instantOf(new Date(now * 1000)),
      advance: (s: number) => {
        now += s;
        jest.advanceTimersByTime(s * 1000);
      },
    };
  }
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test("a close queued behind another session's click keeps what a click arriving behind it opens", async () => {
    const { ctx, logged, turns } = setup();
    const m = idleOver(ctx);
    m.idle.observe(SID, m.at(), true, 30);
    const held = gate();
    // Another session holds the turn past this session's deadline.
    const other = holdTurn(turns, held.wait);
    await drain();
    m.advance(30);
    expect(m.fired).toHaveLength(1);
    m.idle.clickArrived(SID);
    held.open();
    await jest.advanceTimersByTimeAsync(0);
    await Promise.all([other, ...m.fired]);
    m.idle.clickSettled(SID);
    expect(logged).toContain(
      `menu-idle: no longer idle, kept (session=${SID})`,
    );
    expect(logged.filter((l) => l.startsWith("menu-idle: closed="))).toEqual(
      [],
    );
    m.idle.dispose();
  });

  test("a close whose session was evicted while queued keeps what its click opened", async () => {
    const { ctx, logged, turns } = setup();
    const m = idleOver(ctx);
    const held = gate();
    m.idle.observe(SID, m.at(), true, 30);
    const other = holdTurn(turns, held.wait);
    await drain();
    m.advance(30);
    for (let i = 0; i < 256; i++)
      m.idle.clicked(sessionIdOf(`other${i}`), m.at());
    m.idle.clicked(SID, m.at());
    held.open();
    await jest.advanceTimersByTimeAsync(0);
    await Promise.all([other, ...m.fired]);
    expect(logged).toContain(
      `menu-idle: no longer idle, kept (session=${SID})`,
    );
    m.idle.dispose();
  });

  test("a rejected idle turn goes to failed, and is no unhandled rejection", async () => {
    const { ctx, turns } = setup();
    const m = idleOver(ctx);
    const unhandled: unknown[] = [];
    const heard = (e: unknown): void => void unhandled.push(e);
    process.on("unhandledRejection", heard);
    turns.close();
    m.idle.observe(SID, m.at(), true, 30);
    m.advance(30);
    await jest.advanceTimersByTimeAsync(0);
    process.off("unhandledRejection", heard);
    expect(m.failures).toHaveLength(1);
    expect(m.failures[0]!.message).toContain("the daemon closed");
    expect(unhandled).toEqual([]);
    m.idle.dispose();
  });
});

test("a navigation commit that throws leaves the settings journal committed", async () => {
  const { sessionState, ctx } = setup();
  const begin = ctx.navigation.begin.bind(ctx.navigation);
  jest.spyOn(ctx.navigation, "begin").mockImplementation((store) => ({
    ...begin(store),
    commit: () => {
      throw new Error("navigation broke");
    },
  }));
  const click = VERBS.get(VERB_SET_STATE)!;
  await expect(
    click(encodeSegments([SID, "theme", "nord"]), ctx),
  ).rejects.toThrow("navigation broke");
  expect(undoDepth(ctx)).toBe(1);
  undoOf(ctx.history, SID);
  expect(sessionState.get(SID, "theme")).toBeNull();
});

test("a verb stamps its session's landing, though its handler threw", async () => {
  const { ctx } = setup();
  const landed: string[] = [];
  const verb = VERBS.get(VERB_UNDO)!;
  await expect(
    verb(encodeSegments([SID]), {
      ...ctx,
      clickLanded: (sid) => landed.push(sid),
    }),
  ).rejects.toThrow("nothing to undo");
  expect(landed).toEqual([SID]);
});

describe("close", () => {
  test("an idle close in flight lands nothing once the daemon closes", async () => {
    const { sessionState, ctx, confirming, close } = setup();
    const before = sessionState.revision(SID);
    const cut = confirming();
    await drain();
    close();
    cut.open();
    await expect(cut.closing).rejects.toBeInstanceOf(DaemonClosing);
    expect(sessionState.revision(SID)).toBe(before);
    expect(undoDepth(ctx)).toBe(0);
  });

  test("a click that landed before the close stays one step", async () => {
    const { ctx, click, close } = setup();
    await click("nord", "plain");
    close();
    expect(undoDepth(ctx)).toBe(1);
  });

  test("a click queued behind the turn it cut off is refused", async () => {
    const { ctx, click, confirming, close } = setup();
    const cut = confirming();
    await drain();
    const queued = click("dracula", "powerline");
    await drain();
    close();
    cut.open();
    await expect(cut.closing).rejects.toBeInstanceOf(DaemonClosing);
    await expect(queued).rejects.toThrow("the daemon closed");
    expect(undoDepth(ctx)).toBe(0);
  });
});

describe("the click path", () => {
  function parts(
    ctx: VerbContext,
    linkUrl = "",
    linkAt: () => unknown = () => ({ kind: "link", url: linkUrl }),
  ) {
    const {
      arrival: _a,
      turnWaited: _t,
      clientGone: _g,
      latest: _l,
      ...verbCtx
    } = ctx;
    const events: string[] = [];
    const menuIdle = { clickArrived: () => {}, clickSettled: () => {} };
    const given = {
      clock: { monotonic: () => performance.now(), now: () => Date.now() },
      menuIdle,
      payloadProviders: {},
      frameFeeds: { latest: () => null },
      log: (_level: string, line: string) => events.push(line),
      tmuxStatusLines: { linkAt },
      ...clickParts(verbCtx, menuIdle),
    } as unknown as DaemonParts;
    const stats = new RuntimeStats(systemTimekeeper);
    const send = (verb: string, value: string, gone = () => false) =>
      replyTo(
        given,
        signedClick(verb, value) as Parameters<typeof replyTo>[1],
        () => false,
        stats.accept(),
        gone,
      );
    return { send, events };
  }

  test("a BadVerbArgs thrown in the handler reaches the client", async () => {
    const { ctx } = setup();
    const { send, events } = parts(ctx);
    const { resp } = await send(VERB_UNDO, encodeSegments([SID]));
    expect(resp).toMatchObject({
      ok: false,
      code: "BAD_REQUEST",
      error: expect.stringContaining("nothing to undo"),
    });
    expect(events[0]).toMatch(/ turnWait=\d+ms /);
  });

  test("a click's event names the request it was accepted as", async () => {
    const { ctx } = setup();
    const { send, events } = parts(ctx);
    await send(VERB_UNDO, encodeSegments([SID]));
    await send(VERB_UNDO, encodeSegments([SID]));
    expect(events.map((e) => fieldOf(e, "req"))).toEqual(["1", "2"]);
  });

  test("a status-line link naming a verb re-enters without deadlock", async () => {
    const { ctx } = setup();
    const url = `cc-candybar://${VERB_UNDO}/${encodeSegments([SID])}`;
    const { send } = parts(ctx, url);
    const { resp } = await send(VERB_TMUX_STATUS_CLICK, "ignored");
    expect(resp).toMatchObject({ ok: false, code: "BAD_REQUEST" });
  });

  test("a status-line click that throws is its outcome, and writes its event", async () => {
    const { ctx } = setup();
    const { send, events } = parts(ctx, "", () => {
      throw new Error("the opener failed");
    });
    const { resp } = await send(VERB_TMUX_STATUS_CLICK, "ignored");
    expect(resp).toMatchObject({
      ok: false,
      error: expect.stringContaining("the opener failed"),
    });
    expect(events).toHaveLength(1);
    expect(fieldOf(events[0]!, "verb")).toBe(VERB_TMUX_STATUS_CLICK);
  });

  test("a click after close is answered as a failed click", async () => {
    const { ctx, turns } = setup();
    turns.close();
    const { send } = parts(ctx);
    const { resp } = await send(VERB_UNDO, encodeSegments([SID]));
    expect(resp).toMatchObject({
      ok: false,
      error: expect.stringContaining("the daemon closed"),
    });
  });

  test("a click after close is a `closing` outcome at info, not an error", async () => {
    const { ctx, turns } = setup();
    turns.close();
    const { send, events } = parts(ctx);
    await send(VERB_UNDO, encodeSegments([SID]));
    expect(events[0]).toContain("closing=");
  });

  test("a queued click whose client left never lands, and undoes no toggle", async () => {
    const { sessionState, ctx, click, park } = setup();
    const parked = park();
    const slow = click("nord", "plain");
    const { send, events } = parts(ctx);
    const queued = send(
      VERB_SET_STATE,
      encodeSegments([SID, "theme", "dracula"]),
      () => true,
    );
    parked.open();
    await parked.holding;
    await slow;
    await queued;
    expect(sessionState.get(SID, "theme")).toBe("nord");
    expect(events[0]).toContain("abandoned=1");
  });
});

test("stats name the holder and what waits", async () => {
  const { ctx, turns, click, park } = setup();
  const parked = park();
  await drain();
  const queued = click("nord", "plain");
  await drain();
  expect(turns.getStats()).toMatchObject({ holder: "parked", queued: 1 });
  parked.open();
  await Promise.all([parked.holding, queued]);
  expect(ctx.sessionState.get(SID, "theme")).toBe("nord");
  expect(turns.getStats()).toEqual({ holder: null, heldMs: 0, queued: 0 });
});

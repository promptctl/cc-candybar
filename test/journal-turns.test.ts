// Journals across an awaited handler. `journaled` is driven directly with a
// handler parked on a gate, the shape an async launch gives a verb; the
// click-path cases drive `replyTo`, the daemon's real click arm.

import { JournalTurns } from "../src/daemon/journal-turns";
import { MenuIdle } from "../src/daemon/menu-idle";
import type { DaemonParts } from "../src/daemon/daemon-parts";
import { replyTo } from "../src/daemon/reply";
import { SessionState } from "../src/daemon/session-state";
import {
  closeIdleMenus,
  journaled,
  type VerbContext,
} from "../src/daemon/verbs";
import {
  VERB_TMUX_STATUS_CLICK,
  VERB_UNDO,
  encodeSegments,
} from "../src/click/wire";
import { instantOf } from "../src/utils/instant";
import { recordRender, testVerbContext } from "./helpers/click";
import { EMPTY_DEFAULT } from "./helpers/parse-and-validate";

const SID = "s1";
const IDLE = { idleS: 30, timeoutS: 30, stillIdle: () => true };

function gate(): { wait: Promise<void>; open: () => void } {
  let open = (): void => {};
  const wait = new Promise<void>((resolve) => (open = resolve));
  return { wait, open };
}

function setup() {
  const sessionState = new SessionState();
  recordRender(sessionState, SID);
  const logged: string[] = [];
  const turns = new JournalTurns({
    log: (_level, msg) => logged.push(msg),
    monotonic: () => performance.now(),
  });
  const ctx: VerbContext = {
    ...testVerbContext(sessionState, undefined, EMPTY_DEFAULT),
    journalTurns: turns,
    log: (_level, msg) => logged.push(msg),
  };
  // A click writing `theme`, parked on `parked` before it writes `style`.
  const click = (theme: string, style: string, parked: Promise<void>) =>
    journaled<VerbContext>(
      "slow",
      async (_value, c) => {
        c.sessionState.set(SID, "theme", theme);
        await parked;
        c.sessionState.set(SID, "style", style);
      },
      () => SID,
      () => {},
    )("", ctx);
  return { sessionState, ctx, turns, logged, click };
}

const undoDepth = (ctx: VerbContext): number =>
  ctx.history.depth(SID).undo;

describe("journals take turns", () => {
  test("two clicks together apply in order, one undo step each, across an awaited handler", async () => {
    const { sessionState, ctx, click } = setup();
    const held = gate();
    const first = click("nord", "minimal", held.wait);
    const second = click("dracula", "powerline", Promise.resolve());
    expect(sessionState.get(SID, "theme")).toBe("nord");
    held.open();
    await Promise.all([first, second]);
    expect(sessionState.get(SID, "theme")).toBe("dracula");
    expect(sessionState.get(SID, "style")).toBe("powerline");
    expect(undoDepth(ctx)).toBe(2);
    ctx.history.undo(SID);
    expect(sessionState.get(SID, "theme")).toBe("nord");
    expect(sessionState.get(SID, "style")).toBe("minimal");
  });

  test("an idle close during an awaited click is a step of its own, after it", async () => {
    const { sessionState, ctx, click } = setup();
    const held = gate();
    const slow = click("nord", "minimal", held.wait);
    let closed = false;
    const closing = closeIdleMenus(SID, IDLE, ctx).then(() => (closed = true));
    await Promise.resolve();
    expect(closed).toBe(false);
    held.open();
    await Promise.all([slow, closing]);
    expect(sessionState.get(SID, "style")).toBe("minimal");
    expect(undoDepth(ctx)).toBe(1);
  });
});

describe("the idle close decides in its turn", () => {
  function idleOver(ctx: VerbContext) {
    let now = 1000;
    const failures: unknown[] = [];
    const fired: Array<Promise<void>> = [];
    const idle = new MenuIdle({
      now: () => instantOf(new Date(now * 1000)),
      close: async (sid, closing) => {
        const running = closeIdleMenus(sid, closing, ctx);
        fired.push(running);
        return running;
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

  test("a close queued behind a click leaves what that click opened", async () => {
    const { ctx, logged, click } = setup();
    const m = idleOver(ctx);
    const landing: VerbContext = {
      ...ctx,
      clickLanded: (sid) => m.idle.clicked(sid, m.at()),
    };
    m.idle.observe(SID, m.at(), true, 30);
    const held = gate();
    // The click opening the menu holds the turn past the deadline.
    const slow = click("nord", "minimal", held.wait).then(() =>
      landing.clickLanded(SID),
    );
    const finished = journaled<VerbContext>(
      "after",
      () => landing.clickLanded(SID),
      () => SID,
      () => {},
    )("", landing);
    m.advance(30);
    expect(m.fired).toHaveLength(1);
    held.open();
    await jest.advanceTimersByTimeAsync(0);
    await Promise.all([slow, finished, ...m.fired]);
    expect(logged).toContain(`menu-idle: a click came first, kept (session=${SID})`);
    expect(logged.filter((l) => l.startsWith("menu-idle: closed="))).toEqual([]);
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
    expect(String(m.failures[0])).toContain("the daemon closed");
    expect(unhandled).toEqual([]);
    m.idle.dispose();
  });
});

describe("close", () => {
  test("a click in flight stays undoable as one step, its verb logged, and is not committed again", async () => {
    const { sessionState, ctx, turns, logged, click } = setup();
    const held = gate();
    let landed = 0;
    const cut = click("nord", "minimal", held.wait);
    const counted: VerbContext = {
      ...ctx,
      views: { follow: () => landed++ },
    };
    turns.close();
    expect(logged).toContain("journal: slow cut off by close, committing what landed");
    expect(undoDepth(ctx)).toBe(1);
    held.open();
    await cut;
    expect(landed).toBe(0);
    expect(undoDepth(counted)).toBe(1);
    ctx.history.undo(SID);
    expect(sessionState.get(SID, "theme")).toBeNull();
  });

  test("a click queued behind the turn it cut off is refused", async () => {
    const { ctx, turns, click } = setup();
    const held = gate();
    const cut = click("nord", "minimal", held.wait);
    const queued = click("dracula", "powerline", Promise.resolve());
    turns.close();
    held.open();
    await cut;
    await expect(queued).rejects.toThrow("the daemon closed");
    expect(undoDepth(ctx)).toBe(1);
  });
});

describe("the click path", () => {
  function parts(ctx: VerbContext, linkUrl = "") {
    const { arrival: _a, turnWaited: _t, ...verbCtx } = ctx;
    const events: string[] = [];
    const given = {
      clock: { monotonic: () => performance.now(), date: () => new Date() },
      menuIdle: { clicked: () => {} },
      payloadProviders: {},
      log: (_level: string, line: string) => events.push(line),
      tmuxStatusLines: {
        linkAt: () => ({ kind: "link", url: linkUrl }),
      },
      verbCtx,
    } as unknown as DaemonParts;
    const send = (verb: string, value: string) =>
      replyTo(
        given,
        { kind: "click", verb, value } as Parameters<typeof replyTo>[1],
        () => false,
        performance.now(),
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

  test("a status-line link naming a verb re-enters without deadlock", async () => {
    const { ctx } = setup();
    const url = `cc-candybar://${VERB_UNDO}/${encodeSegments([SID])}`;
    const { send } = parts(ctx, url);
    const { resp } = await send(VERB_TMUX_STATUS_CLICK, "ignored");
    expect(resp).toMatchObject({ ok: false, code: "BAD_REQUEST" });
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
});

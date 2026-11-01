// Journals across an awaited handler. A click is a real `dispatch` parked on
// its `copy` launch; the click-path cases drive `replyTo`, the daemon's real
// click arm.

import { JournalTurns } from "../src/daemon/journal-turns";
import { MenuIdle } from "../src/daemon/menu-idle";
import type { DaemonParts } from "../src/daemon/daemon-parts";
import { replyTo } from "../src/daemon/reply";
import { DaemonClosing } from "../src/daemon/verb-error";
import { SessionState } from "../src/daemon/session-state";
import {
  closeIdleMenus,
  SESSION_CLIENT_HINTS_KEY,
  VERBS,
  type VerbContext,
} from "../src/daemon/verbs";
import {
  VERB_COPY,
  VERB_DISPATCH,
  VERB_SET_STATE,
  VERB_TMUX_STATUS_CLICK,
  VERB_UNDO,
  effectsUrl,
  encodeSegments,
} from "../src/click/wire";
import type { Launcher, LaunchResult } from "../src/proc/launch";
import { instantOf } from "../src/utils/instant";
import { createLauncher } from "../src/proc/launch";
import { DoctorBusy } from "../src/doctor/busy";
import type { DoctorEdge } from "../src/doctor/edge";
import { emptyStores, healthyDaemonEdge, healthyDataEdge, noManagedSettings, HEALTHY_INSTALL_EDGE } from "./helpers/doctor-facts";
import { VERB_DOCTOR_RUN } from "../src/click/wire";
import { recordRender, testVerbContext } from "./helpers/click";
import { EMPTY_DEFAULT } from "./helpers/parse-and-validate";

const SID = "s1";
const IDLE = { idleS: 30, timeoutS: 30, stillIdle: () => true, closed: () => {} };

function gate(): { wait: Promise<void>; open: () => void } {
  let open = (): void => {};
  const wait = new Promise<void>((resolve) => (open = resolve));
  return { wait, open };
}

const LAUNCHED: LaunchResult = {
  ok: true,
  stdout: "",
  stderr: "",
  exitCode: 0,
} as LaunchResult;

function parkedClick(
  ctx: VerbContext,
  theme: string,
  style: string,
  parked: Promise<unknown>,
): Promise<void> {
  const url = effectsUrl([
    { verb: VERB_SET_STATE, args: [SID, "theme", theme] },
    { verb: VERB_COPY, args: ["x"] },
    { verb: VERB_SET_STATE, args: [SID, "endcaps", style] },
  ]);
  const launcher = {
    ...ctx.launcher,
    launch: () => parked.then(() => LAUNCHED),
  } as Launcher;
  return VERBS.get(VERB_DISPATCH)!(url.slice(url.lastIndexOf("/") + 1), {
    ...ctx,
    launcher,
  });
}

function setup() {
  const sessionState = new SessionState();
  recordRender(sessionState, SID);
  const logged: string[] = [];
  const turns = new JournalTurns({
    log: (_level, msg) => logged.push(msg),
    monotonic: () => performance.now(),
  });
  const followed: string[] = [];
  const ctx: VerbContext = {
    ...testVerbContext(sessionState, undefined, EMPTY_DEFAULT),
    journalTurns: turns,
    views: { follow: (sid) => followed.push(sid) },
    log: (_level, msg) => logged.push(msg),
  };
  // A click writing `theme`, parked on `parked` in a launch before it writes
  // `style`.
  const click = (theme: string, style: string, parked: Promise<unknown>) =>
    parkedClick(ctx, theme, style, parked);
  return { sessionState, ctx, turns, logged, click, followed };
}

const undoDepth = (ctx: VerbContext): number =>
  ctx.history.depth(SID).undo;

describe("journals take turns", () => {
  test("two clicks together apply in order, one undo step each, across an awaited handler", async () => {
    const { sessionState, ctx, click } = setup();
    const held = gate();
    const first = click("nord", "plain", held.wait);
    const second = click("dracula", "powerline", Promise.resolve());
    expect(sessionState.get(SID, "theme")).toBe("nord");
    held.open();
    await Promise.all([first, second]);
    expect(sessionState.get(SID, "theme")).toBe("dracula");
    expect(sessionState.get(SID, "endcaps")).toBe("powerline");
    expect(undoDepth(ctx)).toBe(2);
    ctx.history.undo(SID);
    expect(sessionState.get(SID, "theme")).toBe("nord");
    expect(sessionState.get(SID, "endcaps")).toBe("plain");
  });

  test("an idle close during an awaited click is a step of its own, after it", async () => {
    const { sessionState, ctx, click } = setup();
    const held = gate();
    const slow = click("nord", "plain", held.wait);
    let closed = false;
    const closing = closeIdleMenus(SID, IDLE, ctx).then(() => (closed = true));
    await Promise.resolve();
    expect(closed).toBe(false);
    held.open();
    await Promise.all([slow, closing]);
    expect(sessionState.get(SID, "endcaps")).toBe("plain");
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
    const slow = click("nord", "plain", held.wait).then(() =>
      landing.clickLanded(SID),
    );
    const finished = VERBS.get(VERB_SET_STATE)!(
      encodeSegments([SID, "theme", "dracula"]),
      landing,
    );
    m.advance(30);
    expect(m.fired).toHaveLength(1);
    held.open();
    await jest.advanceTimersByTimeAsync(0);
    await Promise.all([slow, finished, ...m.fired]);
    expect(logged).toContain(`menu-idle: no longer idle, kept (session=${SID})`);
    expect(logged.filter((l) => l.startsWith("menu-idle: closed="))).toEqual([]);
    m.idle.dispose();
  });

  test("a close whose session was evicted while queued keeps what its click opened", async () => {
    const { ctx, logged } = setup();
    const m = idleOver(ctx);
    const held = gate();
    const slow = parkedClick(ctx, "nord", "plain", held.wait);
    m.idle.observe(SID, m.at(), true, 30);
    m.advance(30);
    for (let i = 0; i < 256; i++) m.idle.clicked(`other${i}`, m.at());
    m.idle.clicked(SID, m.at());
    held.open();
    await jest.advanceTimersByTimeAsync(0);
    await Promise.all([slow, ...m.fired]);
    expect(logged).toContain(`menu-idle: no longer idle, kept (session=${SID})`);
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
  await expect(click(encodeSegments([SID, "theme", "nord"]), ctx)).rejects.toThrow("navigation broke");
  expect(undoDepth(ctx)).toBe(1);
  ctx.history.undo(SID);
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
  test("a click in flight stays undoable as one step, its verb logged, and is not committed again", async () => {
    const { sessionState, ctx, turns, logged, click, followed } = setup();
    const held = gate();
    const cut = click("nord", "plain", held.wait);
    turns.close();
    expect(logged).toContain("journal: dispatch cut off by close, committing what landed");
    expect(undoDepth(ctx)).toBe(1);
    held.open();
    await expect(cut).rejects.toBeInstanceOf(DaemonClosing);
    expect(sessionState.get(SID, "endcaps")).toBeNull();
    expect(followed).toEqual([]);
    expect(undoDepth(ctx)).toBe(1);
    ctx.history.undo(SID);
    expect(sessionState.get(SID, "theme")).toBeNull();
  });

  test("a click that lands normally is followed, and its commit is no cut-off", async () => {
    const { ctx, turns, logged, click, followed } = setup();
    await click("nord", "plain", Promise.resolve());
    turns.close();
    expect(followed).toEqual([SID]);
    expect(logged.filter((l) => l.includes("cut off"))).toEqual([]);
    expect(undoDepth(ctx)).toBe(1);
  });

  test("a click queued behind the turn it cut off is refused", async () => {
    const { ctx, turns, click } = setup();
    const held = gate();
    const cut = click("nord", "plain", held.wait);
    const queued = click("dracula", "powerline", Promise.resolve());
    turns.close();
    held.open();
    await expect(cut).rejects.toBeInstanceOf(DaemonClosing);
    await expect(queued).rejects.toThrow("the daemon closed");
    expect(undoDepth(ctx)).toBe(1);
  });
});

describe("the click path", () => {
  function parts(ctx: VerbContext, linkUrl = "") {
    const { arrival: _a, turnWaited: _t, clientGone: _g, ...verbCtx } = ctx;
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
    const send = (verb: string, value: string, gone = () => false) =>
      replyTo(
        given,
        { kind: "click", verb, value } as Parameters<typeof replyTo>[1],
        gone,
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

  test("a click after close is a `closing` outcome at info, not an error", async () => {
    const { ctx, turns } = setup();
    turns.close();
    const { send, events } = parts(ctx);
    await send(VERB_UNDO, encodeSegments([SID]));
    expect(events[0]).toContain("closing=");
  });

  test("a queued click whose client left never lands, and undoes no toggle", async () => {
    const { sessionState, ctx, click } = setup();
    const held = gate();
    const slow = click("nord", "plain", held.wait);
    const { send, events } = parts(ctx);
    const queued = send(
      VERB_SET_STATE,
      encodeSegments([SID, "theme", "dracula"]),
      () => true,
    );
    held.open();
    await slow;
    await queued;
    expect(sessionState.get(SID, "theme")).toBe("nord");
    expect(events[0]).toContain("abandoned=1");
  });
});

describe("a cut click goes no further", () => {
  test("a later effect does not run, and no click error is held", async () => {
    const { sessionState, ctx, turns, click } = setup();
    const held = gate();
    const cut = click("nord", "plain", held.wait);
    await Promise.resolve();
    turns.close();
    held.open();
    await expect(cut).rejects.toBeInstanceOf(DaemonClosing);
    expect(sessionState.get(SID, "endcaps")).toBeNull();
  });

  test("a launch the close aborted answers DaemonClosing, not its own failure", async () => {
    const { ctx, turns, click } = setup();
    const held = gate();
    const cut = click(
      "nord",
      "plain",
      held.wait.then(() => {
        throw new Error("aborted");
      }),
    );
    await Promise.resolve();
    turns.close();
    held.open();
    await expect(cut).rejects.toBeInstanceOf(DaemonClosing);
    expect(undoDepth(ctx)).toBe(1);
  });
});

test("stats name the holder and what waits", async () => {
  const { ctx, turns, click } = setup();
  const held = gate();
  const slow = click("nord", "plain", held.wait);
  const queued = click("dracula", "powerline", Promise.resolve());
  await Promise.resolve();
  await Promise.resolve();
  expect(turns.getStats()).toMatchObject({ holder: "dispatch", queued: 1 });
  held.open();
  await Promise.all([slow, queued]);
  expect(turns.getStats()).toEqual({ holder: null, heldMs: 0, queued: 0 });
});

describe("a doctor click", () => {
  const edge = (over: Partial<DoctorEdge>): DoctorEdge =>
    ({
      install: HEALTHY_INSTALL_EDGE,
      ...healthyDaemonEdge(),
      ...healthyDataEdge(),
      ...noManagedSettings(),
      loadConfig: () => ({ layers: [], error: null, advisories: [], config: EMPTY_DEFAULT }),
      probeTmux: async () => ({ kind: "failed", reason: "no tmux" }),
      ...over,
    }) as DoctorEdge;

  test("cut during its probes files nothing", async () => {
    const { sessionState, ctx, turns } = setup();
    sessionState.set(SID, SESSION_CLIENT_HINTS_KEY, "{}");
    const before = sessionState.revision(SID);
    const held = gate();
    const healthy = healthyDaemonEdge().daemons;
    const run = VERBS.get(VERB_DOCTOR_RUN)!(encodeURIComponent(SID), {
      ...ctx,
      doctorStores: emptyStores(),
      doctor: edge({ daemons: () => held.wait.then(healthy) }),
    });
    await new Promise((resolve) => setImmediate(resolve));
    turns.close();
    held.open();
    await expect(run).rejects.toBeInstanceOf(DaemonClosing);
    expect(sessionState.revision(SID)).toBe(before);
  });

  test("a probe the rate limit refused stays the click's BAD_REQUEST", async () => {
    const { sessionState, ctx } = setup();
    sessionState.set(SID, SESSION_CLIENT_HINTS_KEY, "{}");
    await expect(
      VERBS.get(VERB_DOCTOR_RUN)!(encodeURIComponent(SID), {
        ...ctx,
        doctorStores: emptyStores(),
        doctor: edge({
          daemons: async () => {
            throw new DoctorBusy("the processes");
          },
        }),
      }),
    ).rejects.toThrow(/processes/);
  });
});

describe("a click's real launch", () => {
  test("hung, it times out and gives the turn back", async () => {
    const { ctx, turns } = setup();
    const launcher = createLauncher({});
    const hung = {
      ...launcher,
      launch: (opts: Parameters<Launcher["launch"]>[0]) =>
        launcher.launch({ ...opts, bin: "/bin/sleep", args: ["30"], timeoutMs: 100, stdinInput: undefined }),
    } as Launcher;
    await expect(
      VERBS.get(VERB_COPY)!("x", { ...ctx, launcher: hung }),
    ).rejects.toThrow(/pbcopy failed/);
    expect(turns.getStats().holder).toBeNull();
  });

  test("a setsid descendant holding stdout leaves the loop answering while it lives", async () => {
    const { ctx } = setup();
    const launcher = createLauncher({});
    const script = "import os,time\nif os.fork()==0:\n  os.setsid()\n  time.sleep(3)\n  os._exit(0)\nos._exit(0)\n";
    const holder = {
      ...launcher,
      launch: (opts: Parameters<Launcher["launch"]>[0]) =>
        launcher.launch({ ...opts, bin: "python3", args: ["-c", script], stdinInput: undefined }),
    } as Launcher;
    let ticks = 0;
    const ticking = setInterval(() => ticks++, 10);
    const started = performance.now();
    await VERBS.get(VERB_COPY)!("x", { ...ctx, launcher: holder });
    clearInterval(ticking);
    expect(performance.now() - started).toBeLessThan(2500);
    expect(ticks).toBeGreaterThan(0);
  });
});

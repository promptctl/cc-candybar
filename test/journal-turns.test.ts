import { TEST_LINKS } from "./helpers/link-signer";
import { MAIN_NAME } from "../src/daemon/home";
// A journal turn is synchronous (src/daemon/journal-turns.ts): its body runs
// to completion in the call that takes it, so nothing comes between a
// click's first write and its commit, and no turn waits on another's work.
// What a click would wait on is an effect performed after its turn; a doctor
// click's probes park here on a gate, in no turn. The click-path cases drive
// `replyTo`, the daemon's real click arm.

import { JournalTurns } from "../src/daemon/journal-turns";
import { MenuIdle } from "../src/daemon/menu-idle";
import type { DaemonParts } from "../src/daemon/daemon-parts";
import { replyTo } from "../src/daemon/reply";
import { DaemonClosing } from "../src/daemon/verb-error";
import { SessionState, SINGLE_RUN } from "../src/daemon/session-state";
import { SettingsHistory } from "../src/daemon/settings-history";
import { closeIdleMenus, VERBS, type VerbContext } from "../src/daemon/verbs";
import { SESSION_CLIENT_HINTS_KEY } from "../src/daemon/foundations/session-keys";
import { lastClickError } from "../src/daemon/click-error";
import {
  VERB_COPY,
  VERB_PROBE,
  VERB_DOCTOR_RUN,
  VERB_SET_STATE,
  VERB_RANGE,
  VERB_UNDO,
  effectsUrl,
  encodeSegments,
} from "../src/click/wire";
import type { Launcher } from "../src/proc/launch";
import { instantOf } from "../src/utils/instant";
import { systemLauncher } from "../src/proc/system-launcher";
import { DoctorBusy } from "../src/doctor/busy";
import type { DoctorEdge } from "../src/doctor/edge";
import { emptyStores, healthyDaemonEdge, healthyDataEdge, noManagedSettings, HEALTHY_INSTALL_EDGE } from "./helpers/doctor-facts";
import { applyClick, clickUrl, recordRender, testVerbContext } from "./helpers/click";
import { EMPTY_DEFAULT } from "./helpers/parse-and-validate";
import { systemTimekeeper } from "../src/time";

const SID = "s1";
const IDLE = { idleS: 30, timeoutS: 30, stillIdle: () => true, closed: () => {} };

function gate(): { wait: Promise<void>; open: () => void } {
  let open = (): void => {};
  const wait = new Promise<void>((resolve) => (open = resolve));
  return { wait, open };
}

const edge = (over: Partial<DoctorEdge>): DoctorEdge =>
  ({
    install: HEALTHY_INSTALL_EDGE,
    ...healthyDaemonEdge(),
    ...healthyDataEdge(),
    ...noManagedSettings(),
    loadConfig: () => ({ layers: [], error: null, warning: null, unused: [], config: EMPTY_DEFAULT }),
    probeTmux: async () => ({ kind: "failed", reason: "no tmux" }),
    ...over,
  }) as DoctorEdge;

// A doctor edge whose daemons probe parks until `parked` settles.
const parkedEdge = (parked: Promise<unknown>): DoctorEdge =>
  edge({ daemons: () => parked.then(() => healthyDaemonEdge().daemons()) });

// `rawHistory`: a history over the store itself, outside the write-in-turn
// instrument, for a case whose navigation commit always throws.
function setup({ rawHistory = false } = {}) {
  const sessionState = new SessionState(SINGLE_RUN);
  recordRender(sessionState, SID);
  sessionState.set(SID, SESSION_CLIENT_HINTS_KEY, "{}");
  const logged: string[] = [];
  const turns = new JournalTurns();
  const ctx: VerbContext = {
    ...testVerbContext(
      sessionState,
      rawHistory ? new SettingsHistory(sessionState, () => {}) : undefined,
      EMPTY_DEFAULT,
      undefined,
      turns,
    ),
    log: (_level, msg) => logged.push(msg),
    doctorStores: emptyStores(),
  };
  // A click writing `theme`, then running the doctor, then writing `style`,
  // whose doctor parks on `parked`.
  const click = (theme: string, style: string, parked: Promise<unknown>) =>
    applyClick(
      effectsUrl(MAIN_NAME, [
        { verb: VERB_SET_STATE, args: [SID, "theme", theme] },
        { verb: VERB_DOCTOR_RUN, args: [SID] },
        { verb: VERB_SET_STATE, args: [SID, "endcaps", style] },
      ]),
      { ...ctx, doctor: parkedEdge(parked) },
    );
  const reports = () => logged.filter((l) => l.startsWith("doctor: "));
  return { sessionState, ctx, turns, logged, click, reports };
}

async function drain(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

const undoDepth = (ctx: VerbContext): number =>
  ctx.history.depth(SID).undo;

describe("a turn", () => {
  test("runs its body in the call that takes it, held while it runs, and answers its value", () => {
    const turns = new JournalTurns();
    const held: Array<string | null> = [];
    expect(turns.take("t", () => (held.push(turns.inTurn()), 7))).toBe(7);
    expect(held).toEqual(["t"]);
    expect(turns.inTurn()).toBeNull();
  });

  test("an async body fails to build", () => {
    const turns = new JournalTurns();
    // @ts-expect-error a turn body that awaits would write outside its turn
    void turns.take("t", async () => {});
  });

  test("a body that throws ends its turn, and the take throws what it threw", () => {
    const turns = new JournalTurns();
    expect(() =>
      turns.take("t", () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(turns.inTurn()).toBeNull();
  });

  test("a take inside a take is refused, naming both", () => {
    const turns = new JournalTurns();
    expect(() => turns.take("outer", () => turns.take("inner", () => {}))).toThrow(
      "journal: inner took a turn inside outer's",
    );
  });

  test("a take after close is refused as the close", () => {
    const turns = new JournalTurns();
    turns.close();
    expect(() => turns.take("t", () => {})).toThrow(DaemonClosing);
  });
});

describe("a click lands whole in one turn", () => {
  test("a dispatch's writes around a doctor step land as one undo step before its probes run, and the report lands after", async () => {
    const { sessionState, ctx, turns, click, reports } = setup();
    const held = gate();
    const { performed } = await click("nord", "plain", held.wait);
    await drain();
    expect(sessionState.get(SID, "theme")).toBe("nord");
    expect(sessionState.get(SID, "endcaps")).toBe("plain");
    expect(undoDepth(ctx)).toBe(1);
    expect(turns.getStats().gathers).toBe(1);
    expect(reports()).toEqual([]);
    held.open();
    await performed;
    expect(reports()).toHaveLength(1);
    expect(turns.getStats().gathers).toBe(0);
    expect(undoDepth(ctx)).toBe(1);
  });

  test("an idle close while a doctor's probes park lands at once, a step of its own", async () => {
    const { ctx, click } = setup();
    const held = gate();
    const { performed } = await click("nord", "plain", held.wait);
    await drain();
    closeIdleMenus(SID, IDLE, ctx);
    expect(undoDepth(ctx)).toBe(1);
    held.open();
    await performed;
  });
});

describe("the idle close decides in its turn", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test("a rejected idle turn goes to failed, and is no unhandled rejection", async () => {
    const { ctx, turns } = setup();
    let now = 1000;
    const failures: unknown[] = [];
    const idle = new MenuIdle({
      clock: systemTimekeeper,
      now: () => instantOf(new Date(now * 1000)),
      close: async (sid, closing) => closeIdleMenus(sid, closing, ctx),
      failed: (_sid, e) => failures.push(e),
    });
    const unhandled: unknown[] = [];
    const heard = (e: unknown): void => void unhandled.push(e);
    process.on("unhandledRejection", heard);
    turns.close();
    idle.observe(SID, instantOf(new Date(now * 1000)), true, 30);
    now += 30;
    jest.advanceTimersByTime(30_000);
    await jest.advanceTimersByTimeAsync(0);
    process.off("unhandledRejection", heard);
    expect(failures).toHaveLength(1);
    expect(String(failures[0])).toContain("the daemon closed");
    expect(unhandled).toEqual([]);
    idle.dispose();
  });
});

test("a navigation commit that throws leaves the settings journal committed", () => {
  // Every navigation commit throws here, an undo click's too, so the history
  // is read back directly, over the store itself.
  const { sessionState, ctx } = setup({ rawHistory: true });
  const begin = ctx.navigation.begin.bind(ctx.navigation);
  jest.spyOn(ctx.navigation, "begin").mockImplementation((store) => ({
    ...begin(store),
    commit: () => {
      throw new Error("navigation broke");
    },
  }));
  const click = VERBS.get(VERB_SET_STATE)!;
  expect(() => click(encodeSegments([SID, "theme", "nord"]), ctx)).toThrow("navigation broke");
  expect(undoDepth(ctx)).toBe(1);
  ctx.history.undo(SID);
  expect(sessionState.get(SID, "theme")).toBeNull();
});

test("a verb stamps its session's landing, though its handler threw", () => {
  const { ctx } = setup();
  const landed: string[] = [];
  const verb = VERBS.get(VERB_UNDO)!;
  expect(() =>
    verb(encodeSegments([SID]), {
      ...ctx,
      clickLanded: (sid) => landed.push(sid),
    }),
  ).toThrow("nothing to undo");
  expect(landed).toEqual([SID]);
});

describe("the click path", () => {
  function parts(ctx: VerbContext, linkUrl = "") {
    const { arrival: _a, ...verbCtx } = ctx;
    const events: string[] = [];
    const given = {
      clock: { monotonic: () => performance.now(), now: () => Date.now() },
      links: TEST_LINKS,
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
        { kind: "click", url: `cc-candybar://to/main/${verb}/${value}` } as Parameters<typeof replyTo>[1],
        () => false,
        systemTimekeeper.monotonic(),
        gone,
      );
    // The reply's click line: a refused click's turn still committed, so its
    // apply line is logged ahead of it.
    const clickLine = () => events.find((l) => l.startsWith("click "));
    return { send, events, clickLine };
  }

  test("a BadVerbArgs thrown in the handler reaches the client", async () => {
    const { ctx } = setup();
    const { send } = parts(ctx);
    const { resp } = await send(VERB_UNDO, encodeSegments([SID]));
    expect(resp).toMatchObject({
      ok: false,
      code: "BAD_REQUEST",
      error: expect.stringContaining("nothing to undo"),
    });
  });

  test("a status-line link naming a verb re-enters without deadlock", async () => {
    const { ctx } = setup();
    const url = `cc-candybar://to/main/${VERB_UNDO}/${encodeSegments([SID])}`;
    const { send } = parts(ctx, url);
    const { resp } = await send(VERB_RANGE, "ignored");
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
    const { send, clickLine } = parts(ctx);
    await send(VERB_UNDO, encodeSegments([SID]));
    expect(clickLine()).toContain("closing=");
  });

  test("a click whose client left before it ran never lands, and undoes no toggle", async () => {
    const { sessionState, ctx } = setup();
    const { send, clickLine } = parts(ctx);
    await send(VERB_SET_STATE, encodeSegments([SID, "theme", "dracula"]), () => true);
    expect(sessionState.get(SID, "theme")).toBeNull();
    expect(clickLine()).toContain("abandoned=1");
  });

  test("a probe link whose client left still arrives: it takes no turn, so no leaving refuses it", async () => {
    const { ctx } = setup();
    const { send } = parts(ctx);
    const nonce = "01234567-89ab-cdef-0123-456789abcdef";
    await send(VERB_PROBE, nonce, () => true);
    expect(ctx.probes.list().map((p) => p.nonce)).toEqual([nonce]);
  });
});

describe("a doctor click", () => {
  test("closed during its probes files nothing, and its outcome is said at info", async () => {
    const { sessionState, ctx, turns, logged } = setup();
    const before = sessionState.revision(SID);
    const held = gate();
    const { performed } = await applyClick(
      `cc-candybar://to/main/${VERB_DOCTOR_RUN}/${encodeURIComponent(SID)}`,
      { ...ctx, doctor: parkedEdge(held.wait) },
    );
    await drain();
    turns.close();
    held.open();
    await performed;
    expect(sessionState.revision(SID)).toBe(before);
    expect(logged).toContainEqual(expect.stringMatching(/^apply: effect-done not applied \(doctor:run gathered\): DaemonClosing/));
  });

  test("queued behind the close, its gather spawns no probe, and its outcome is said at info", async () => {
    const { ctx, turns, logged } = setup();
    const held = gate();
    let probes = 0;
    const doctor = edge({
      daemons: () => {
        probes++;
        return held.wait.then(() => healthyDaemonEdge().daemons());
      },
    });
    const url = `cc-candybar://to/main/${VERB_DOCTOR_RUN}/${encodeURIComponent(SID)}`;
    const first = await applyClick(url, { ...ctx, doctor });
    const second = await applyClick(url, { ...ctx, doctor });
    await drain();
    turns.close();
    held.open();
    await Promise.all([first.performed, second.performed]);
    expect(probes).toBe(1);
    expect(logged).toContainEqual(
      expect.stringMatching(
        /^apply: effect-done not applied \(doctor:run failed: the daemon closed: doctor refused\): DaemonClosing/,
      ),
    );
  });

  test("a probe that faults is held on the bar in its own words, and logged whole at error", async () => {
    const { sessionState, ctx } = setup();
    const errors: string[] = [];
    await clickUrl(`cc-candybar://to/main/${VERB_DOCTOR_RUN}/${encodeURIComponent(SID)}`, {
      ...ctx,
      log: (level, msg) => void (level === "error" && errors.push(msg)),
      doctor: edge({
        daemons: async () => {
          throw new TypeError("probe bug");
        },
      }),
    });
    expect(lastClickError(sessionState, SID)?.text).toBe("probe bug");
    expect(errors).toEqual([
      expect.stringMatching(/^apply: doctor:run threw: TypeError: probe bug\n\s+at /),
    ]);
  });

  test("a probe the rate limit refused is the step's failure, held on the bar", async () => {
    const { sessionState, ctx } = setup();
    await clickUrl(`cc-candybar://to/main/${VERB_DOCTOR_RUN}/${encodeURIComponent(SID)}`, {
      ...ctx,
      doctor: edge({
        daemons: async () => {
          throw new DoctorBusy("the processes");
        },
      }),
    });
    expect(lastClickError(sessionState, SID)?.text).toMatch(/processes/);
  });
});

describe("a click's real launch", () => {
  const COPY = `cc-candybar://to/main/${VERB_COPY}/${encodeSegments([SID, "x"])}`;

  test("hung, it times out, holding no turn, and its effect says so", async () => {
    const { ctx, turns, logged } = setup();
    const launcher = systemLauncher({ inherited: process.env }, systemTimekeeper);
    const hung = {
      ...launcher,
      launch: (opts: Parameters<Launcher["launch"]>[0]) => {
        expect(turns.inTurn()).toBeNull();
        return launcher.launch({ ...opts, bin: "/bin/sleep", args: ["30"], timeoutMs: 100, stdinInput: undefined });
      },
    } as Launcher;
    await clickUrl(COPY, { ...ctx, launcher: hung });
    expect(logged.filter((l) => l.startsWith("apply kind=effect-done"))).toEqual([
      expect.stringMatching(/ effect=launch:pbcopy outcome=failed said="pbcopy failed \(timed out/),
    ]);
  });

  test("a setsid descendant holding stdout leaves the loop answering while it lives", async () => {
    const { ctx } = setup();
    const launcher = systemLauncher({ inherited: process.env }, systemTimekeeper);
    const script = "import os,time\nif os.fork()==0:\n  os.setsid()\n  time.sleep(3)\n  os._exit(0)\nos._exit(0)\n";
    const holder = {
      ...launcher,
      launch: (opts: Parameters<Launcher["launch"]>[0]) =>
        launcher.launch({ ...opts, bin: "python3", args: ["-c", script], stdinInput: undefined }),
    } as Launcher;
    let ticks = 0;
    const ticking = setInterval(() => ticks++, 10);
    const started = performance.now();
    await clickUrl(COPY, { ...ctx, launcher: holder });
    clearInterval(ticking);
    expect(performance.now() - started).toBeLessThan(2500);
    expect(ticks).toBeGreaterThan(0);
  });
});

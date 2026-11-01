// A click's read-only launches run ahead of its journal turn, and its session's
// queue keeps arrival order across them (candybar-launch-q7o7.fqw). Doctor
// clicks here are real verbs over a fake doctor edge whose process probe parks
// on a gate; the click-path cases drive `replyTo`, the daemon's real click arm.

import { JournalTurns } from "../src/daemon/journal-turns";
import { MenuIdle } from "../src/daemon/menu-idle";
import type { DaemonParts } from "../src/daemon/daemon-parts";
import { replyTo } from "../src/daemon/reply";
import { SessionState } from "../src/daemon/session-state";
import {
  SESSION_CLIENT_HINTS_KEY,
  VERBS,
  type VerbContext,
  type VerbHandler,
} from "../src/daemon/verbs";
import {
  VERB_COPY,
  VERB_COPY_DIAGNOSTIC,
  VERB_DISPATCH,
  VERB_DOCTOR_MARK,
  VERB_DOCTOR_PROBE,
  VERB_DOCTOR_RUN,
  VERB_SET_CONFIG,
  VERB_SLASH,
  VERB_TOOLBAR_TOGGLE,
  effectsUrl,
  encodeSegments,
} from "../src/click/wire";
import { ClickAbandoned } from "../src/daemon/verb-error";
import { createLauncher, type Launcher, type LaunchResult } from "../src/proc/launch";
import { productionEdge, type DoctorEdge } from "../src/doctor/edge";
import { instantOf } from "../src/utils/instant";
import {
  emptyStores,
  healthyDaemonEdge,
  healthyDataEdge,
  HEALTHY_INSTALL_EDGE,
  noManagedSettings,
} from "./helpers/doctor-facts";
import { recordRender, testVerbContext } from "./helpers/click";
import { EMPTY_DEFAULT, parseAndValidate } from "./helpers/parse-and-validate";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { listResolvablePaletteNames } from "../src/themes/policy";
import { durableConfig } from "./helpers/durable-config";

const ALLOWED = new Set(listResolvablePaletteNames());
const RULE = "─".repeat(60);
const IDLE_SCREEN = ["⏺ Done.", "", "", `${RULE} probe ─`, "❯ ", RULE, "  ⏸ manual mode on"];
const NONCE = "01234567-89ab-cdef-0123-456789abcdef";
const A = "session-a";
const B = "session-b";
const LAUNCHED = { ok: true, stdout: "", stderr: "", exitCode: 0 } as LaunchResult;
type Load = ReturnType<DoctorEdge["loadConfig"]>;
const LOAD = { layers: [], error: null, warning: null, unused: [], config: EMPTY_DEFAULT } as unknown as Load;
const FAILED_LOAD = { ...LOAD, error: "the file changed", config: { ...EMPTY_DEFAULT } } as Load;

function gate(): { wait: Promise<void>; open: () => void } {
  let open = (): void => {};
  const wait = new Promise<void>((resolve) => (open = resolve));
  return { wait, open };
}

async function drain(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

const edge = (over: Partial<DoctorEdge>): DoctorEdge =>
  ({
    install: HEALTHY_INSTALL_EDGE,
    ...healthyDaemonEdge(),
    ...healthyDataEdge(),
    ...noManagedSettings(),
    loadConfig: () => LOAD,
    probeTmux: async () => ({ kind: "failed", reason: "no tmux" }),
    ...over,
  }) as DoctorEdge;

function setup(over: Partial<DoctorEdge> = {}) {
  const sessionState = new SessionState();
  const logged: string[] = [];
  const turns = new JournalTurns({
    log: () => {},
    monotonic: () => performance.now(),
  });
  for (const sid of [A, B]) {
    recordRender(sessionState, sid);
    sessionState.set(sid, SESSION_CLIENT_HINTS_KEY, "{}");
  }
  const held = gate();
  const healthy = healthyDaemonEdge().daemons;
  const gathers: string[] = [];
  const ctx: VerbContext = {
    ...testVerbContext(sessionState, undefined, EMPTY_DEFAULT),
    journalTurns: turns,
    log: (_level, line) => logged.push(line),
    doctorStores: emptyStores(),
    doctor: edge({
      daemons: async () => {
        gathers.push(`holder=${turns.getStats().holder}`);
        await held.wait;
        return healthy();
      },
      ...over,
    }),
  };
  const toggled = (sid: string) => sessionState.get(sid, "toolbar-expanded");
  const doctor = (sid: string, c: VerbContext = ctx) =>
    VERBS.get(VERB_DOCTOR_RUN)!(encodeURIComponent(sid), c);
  const toggle = (sid: string, c: VerbContext = ctx) =>
    VERBS.get(VERB_TOOLBAR_TOGGLE)!(encodeURIComponent(sid), c);
  const doDoctorThen = (c: VerbContext = ctx) => {
    const url = effectsUrl([
      { verb: VERB_DOCTOR_RUN, args: [A] },
      { verb: VERB_TOOLBAR_TOGGLE, args: [A] },
    ]);
    return VERBS.get(VERB_DISPATCH)!(url.slice(url.lastIndexOf("/") + 1), c);
  };
  const reports = () => logged.filter((l) => l.startsWith("doctor: "));
  return { sessionState, logged, turns, held, gathers, ctx, toggled, doctor, toggle, doDoctorThen, reports };
}

describe("a gather holds no turn", () => {
  test("session B's click lands while A's doctor gather parks, and A's report lands", async () => {
    const { turns, held, gathers, doctor, toggle, toggled, reports } = setup();
    const a = doctor(A);
    await drain();
    expect(gathers).toEqual(["holder=null"]);
    expect(turns.getStats().holder).toBeNull();
    await toggle(B);
    expect(toggled(B)).toBe("1");
    expect(reports()).toEqual([]);
    held.open();
    await a;
    expect(reports()).toHaveLength(1);
  });

  test("a doctor click whose client left during the gather still files its report", async () => {
    const { held, doctor, ctx, reports } = setup();
    let gone = false;
    const a = doctor(A, { ...ctx, clientGone: () => gone });
    await drain();
    gone = true;
    held.open();
    await a;
    expect(reports()).toHaveLength(1);
  });

  test("a `do` of doctor then a write whose client left during the gather lands both", async () => {
    const { held, doDoctorThen, ctx, toggled, reports } = setup();
    let gone = false;
    const a = doDoctorThen({ ...ctx, clientGone: () => gone });
    await drain();
    gone = true;
    held.open();
    await a;
    expect(reports()).toHaveLength(1);
    expect(toggled(A)).toBe("1");
  });

  test("doctor-probe answers at once with the turn held", async () => {
    const { ctx, turns } = setup();
    const parked = gate();
    const launcher = { ...ctx.launcher, launch: () => parked.wait.then(() => LAUNCHED) } as Launcher;
    const holding = VERBS.get(VERB_COPY)!("x", { ...ctx, launcher });
    await drain();
    expect(turns.getStats().holder).toBe(VERB_COPY);
    await VERBS.get(VERB_DOCTOR_PROBE)!(NONCE, {
      ...ctx,
      clientGone: () => true,
      arrival: { via: "link", handler: null },
    });
    expect(ctx.probes.list().map((p) => p.nonce)).toEqual([NONCE]);
    expect(turns.getStats().holder).toBe(VERB_COPY);
    parked.open();
    await holding;
  });
});

describe("one session's order", () => {
  test("a toggle arriving after a doctor click lands after it", async () => {
    const { held, doctor, toggle, toggled, reports } = setup();
    const a = doctor(A);
    const later = toggle(A);
    await drain();
    expect(toggled(A)).toBeNull();
    held.open();
    await Promise.all([a, later]);
    expect(reports()).toHaveLength(1);
    expect(toggled(A)).toBe("1");
  });

  test("two doctor-marks land in arrival order", async () => {
    const order: string[] = [];
    const first = gate();
    let probes = 0;
    const { ctx } = setup({
      daemons: async () => {
        if (++probes === 1) await first.wait;
        return healthyDaemonEdge().daemons();
      },
    });
    const logging: VerbContext = {
      ...ctx,
      log: (_l, line) => {
        if (line.startsWith("doctor: ")) order.push(`report${order.length + 1}`);
      },
    };
    const refuse = (m: string) =>
      VERBS.get(VERB_DOCTOR_MARK)!(encodeSegments([A, "nerdFont", m]), logging)
        .catch((e: unknown) => order.push(`${m}: ${String(e).includes("mark") ? "refused" : e}`));
    const one = refuse("drawn");
    const two = refuse("boxes");
    await drain();
    expect(order).toEqual([]);
    expect(probes).toBe(1);
    first.open();
    await Promise.all([one, two]);
    expect(order).toEqual(["drawn: refused", "boxes: refused"]);
  });

  test("a later click whose client left while queued behind the gather is refused, and writes nothing", async () => {
    const { held, doctor, toggle, ctx, toggled } = setup();
    const a = doctor(A);
    const later = toggle(A, { ...ctx, clientGone: () => true });
    const refused = expect(later).rejects.toBeInstanceOf(ClickAbandoned);
    held.open();
    await a;
    await refused;
    expect(toggled(A)).toBeNull();
  });

  test("a `do` of doctor then toggle whose client leaves in the turn wait, after its gather, is refused", async () => {
    const { held, doDoctorThen, ctx, toggled, reports } = setup();
    const parked = gate();
    let gone = false;
    const launcher = { ...ctx.launcher, launch: () => parked.wait.then(() => LAUNCHED) } as Launcher;
    const holding = VERBS.get(VERB_COPY)!("x", { ...ctx, launcher });
    await drain();
    const a = doDoctorThen({ ...ctx, clientGone: () => gone });
    held.open();
    await drain();
    gone = true;
    const refused = expect(a).rejects.toBeInstanceOf(ClickAbandoned);
    parked.open();
    await holding;
    await refused;
    expect(reports()).toEqual([]);
    expect(toggled(A)).toBeNull();
  });
});

describe("a gather is a snapshot of one config", () => {
  test("a `do` of set-config then doctor judges the written config", async () => {
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
      const healthy = healthyDaemonEdge().daemons;
      const ctx: VerbContext = {
        ...testVerbContext(sessionState, fixture.historyFor(sessionState), config),
        doctorStores: emptyStores(),
        doctor: edge({
          daemons: () => {
            seen.push(fixture.text());
            return healthy();
          },
        }),
      };
      const url = effectsUrl([
        { verb: VERB_SET_CONFIG, args: [A, "palette", [...ALLOWED][0]!] },
        { verb: VERB_DOCTOR_RUN, args: [A] },
      ]);
      await VERBS.get(VERB_DISPATCH)!(url.slice(url.lastIndexOf("/") + 1), ctx);
      expect(seen).toHaveLength(1);
      expect(seen[0]).toContain("palette");
    } finally {
      fixture.dispose();
    }
  });

  test("a config write landing during a gather makes the click re-gather in its turn, and the report matches it", async () => {
    let load = LOAD;
    const { held, gathers, doctor, reports } = setup({ loadConfig: () => load });
    const a = doctor(A);
    await drain();
    load = FAILED_LOAD;
    held.open();
    await a;
    expect(gathers).toEqual(["holder=null", `holder=${VERB_DOCTOR_RUN}`]);
    expect(reports()).toHaveLength(1);
    expect(reports()[0]).toContain("config=failed(");
  });

  test("the re-gather asks the real rate limiter nothing twice", async () => {
    const launcher = createLauncher({});
    let load = LOAD;
    const real = productionEdge(launcher, () => load);
    const parked = gate();
    let daemons = 0;
    const { ctx, reports, sessionState } = setup();
    // Inside tmux, so the gather spawns the rate-limited tmux probe.
    sessionState.set(
      A,
      SESSION_CLIENT_HINTS_KEY,
      JSON.stringify({ tmux: { pane: "%1", socket: "/tmp/fqw-no-such-socket", truecolor: null } }),
    );
    const c: VerbContext = {
      ...ctx,
      doctor: {
        ...real,
        ...healthyDataEdge(),
        install: HEALTHY_INSTALL_EDGE,
        daemons: async () => {
          if (++daemons === 1) await parked.wait;
          return healthyDaemonEdge().daemons();
        },
      },
    };
    const a = VERBS.get(VERB_DOCTOR_RUN)!(encodeURIComponent(A), c);
    await new Promise((resolve) => setTimeout(resolve, 50));
    load = FAILED_LOAD;
    parked.open();
    await a;
    expect(daemons).toBe(2);
    expect(reports()[0]).toContain("config=failed(");
  });
});

test("a `do` of doctor then toggle with a failed probe still toggles and shows the error on the bar", async () => {
  const { doDoctorThen, sessionState, toggled, reports } = setup({
    daemons: async () => {
      throw new Error("ps broke");
    },
  });
  await expect(doDoctorThen()).rejects.toThrow("ps broke");
  expect(toggled(A)).toBe("1");
  expect(reports()).toEqual([]);
  expect(sessionState.get(A, "click.error")).toContain("ps broke");
});

test("a slash click re-checks nothing outside the turn: read and typing share it", async () => {
  const { ctx, turns, sessionState } = setup();
  sessionState.set(
    A,
    SESSION_CLIENT_HINTS_KEY,
    JSON.stringify({ tmux: { pane: "%1", socket: "/tmp/s", truecolor: null } }),
  );
  const config = parseAndValidate(
    "<user>",
    `{ actions: { c: { slash: "/compact" } } }`,
    ALLOWED,
    DEFAULT_DSL_CONFIG,
  );
  const holders: Array<string | null> = [];
  await VERBS.get(VERB_SLASH)!(encodeSegments([A, "/compact"]), {
    ...ctx,
    configFor: () => config,
    claudeInput: {
      read: async () => {
        holders.push(turns.getStats().holder);
        return { inMode: false, screen: IDLE_SCREEN };
      },
      type: async () => {
        holders.push(turns.getStats().holder);
        return { kind: "typed" };
      },
    },
  });
  expect(holders).toEqual([VERB_SLASH, VERB_SLASH]);
});

test("a watcher reload during a parked pbcopy starts no `by=click` setup", async () => {
  const { ctx } = setup();
  const parked = gate();
  const quiet = { band: false } as never as ReturnType<VerbContext["lanes"]["of"]>;
  const moved = { band: true } as never as typeof quiet;
  let now = quiet;
  const moves: unknown[][] = [];
  const launcher = { ...ctx.launcher, launch: () => parked.wait.then(() => LAUNCHED) } as Launcher;
  const copying = VERBS.get(VERB_COPY_DIAGNOSTIC)!(encodeSegments([A, "request", "k"]), {
    ...ctx,
    launcher,
    diagnosticCopy: () => "text",
    lanes: { of: () => now, clicked: (...args) => moves.push(args) },
  });
  await drain();
  now = moved;
  parked.open();
  await copying;
  expect(moves).toEqual([[A, moved, moved]]);
});

describe("the idle clock", () => {
  function clock() {
    let now = 1000;
    const closes: string[] = [];
    const idle = new MenuIdle({
      now: () => instantOf(new Date(now * 1000)),
      close: async (sid, closing) => {
        closing.closed();
        closes.push(sid);
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
    c.idle.observe("s", c.at(), true, 30);
    c.idle.clickArrived("s");
    expect(c.idle.getStats()).toMatchObject({ armed: 0, pending: 1 });
    await c.advance(60);
    expect(c.closes).toEqual([]);
    expect(c.idle.getStats().armed).toBe(0);
    c.idle.clicked("s", c.at());
    c.idle.clickSettled("s");
    expect(c.idle.getStats()).toMatchObject({ armed: 1, pending: 0 });
    await c.advance(30);
    expect(c.closes).toEqual(["s"]);
    c.idle.dispose();
  });

  test("an abandoned click does not move the clock", async () => {
    const c = clock();
    c.idle.observe("s", c.at(), true, 30);
    await c.advance(20);
    c.idle.clickArrived("s");
    await c.advance(5);
    c.idle.clickSettled("s");
    expect(c.idle.since("s", c.at())).toBe(1000);
    await c.advance(5);
    expect(c.closes).toEqual(["s"]);
    c.idle.dispose();
  });

  test("eviction of an abandoned click's record leaves pending intact, and settling throws nothing", async () => {
    const c = clock();
    c.idle.clicked("s", c.at());
    c.idle.clickArrived("s");
    for (let i = 0; i < 256; i++) c.idle.clicked(`other${i}`, c.at());
    expect(c.idle.getStats().pending).toBe(1);
    expect(() => c.idle.clickSettled("s")).not.toThrow();
    expect(c.idle.getStats().pending).toBe(0);
    c.idle.dispose();
  });
});

test("the click path counts a click pending from arrival, through a refusal, and logs gatherMs", async () => {
  const { ctx, held } = setup();
  const idle = new MenuIdle({
    now: () => instantOf(new Date()),
    close: async () => {},
    failed: () => {},
  });
  const { arrival: _a, turnWaited: _t, gatherTook: _g, clientGone: _c, ...verbCtx } = ctx;
  const events: string[] = [];
  const parts = {
    clock: { monotonic: () => performance.now(), date: () => new Date() },
    menuIdle: idle,
    payloadProviders: {},
    log: (_level: string, line: string) => events.push(line),
    verbCtx,
  } as unknown as DaemonParts;
  const send = (gone: () => boolean) =>
    replyTo(
      parts,
      { kind: "click", verb: VERB_DOCTOR_RUN, value: encodeURIComponent(A) } as Parameters<typeof replyTo>[1],
      () => false,
      performance.now(),
      gone,
    );
  const sent = send(() => false);
  await drain();
  expect(idle.getStats().pending).toBe(1);
  held.open();
  await sent;
  expect(idle.getStats().pending).toBe(0);
  expect(events[0]).toMatch(/ gatherMs=\d+ /);
  await send(() => true);
  expect(idle.getStats().pending).toBe(0);
  idle.dispose();
});

test("tsc refuses `ctx.launcher` in a VerbHandler", () => {
  const handler: VerbHandler = async (_value, ctx) => {
    // @ts-expect-error A handler reaches launches through the turn alone.
    void ctx.launcher;
    // @ts-expect-error As above.
    void ctx.doctor;
    // @ts-expect-error As above.
    void ctx.claudeInput;
  };
  expect(handler).toBeDefined();
});

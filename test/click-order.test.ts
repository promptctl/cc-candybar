import { MAIN_NAME } from "../src/daemon/home";
// A doctor click's probes are an effect: its turn describes them, the
// performer gathers after the turn, one gather at a time daemon-wide, and the
// step lands with the outcome in a turn of its own, if what the gather read
// still stands. Doctor clicks here run through Apply over a fake doctor edge
// whose process probe parks on a gate; the click-path cases drive `replyTo`,
// the daemon's real click arm.

import { JournalTurns } from "../src/daemon/journal-turns";
import { HOST, locs } from "./helpers/host";
import { SessionState } from "../src/daemon/session-state";
import { VERBS, type VerbContext, type VerbHandler } from "../src/daemon/verbs";
import { SESSION_CLIENT_HINTS_KEY } from "../src/daemon/foundations/session-keys";
import {
  VERB_COPY,
  VERB_COPY_DIAGNOSTIC,
  VERB_DISPATCH,
  VERB_DOCTOR_MARK,
  VERB_DOCTOR_PROBE,
  VERB_DOCTOR_RUN,
  VERB_SET_CONFIG,
  VERB_SET_STATE,
  VERB_SLASH,
  VERB_TOOLBAR_TOGGLE,
  effectsUrl,
  encodeSegments,
} from "../src/click/wire";
import { clickErrors, lastClickError } from "../src/daemon/click-error";
import { DoctorBusy } from "../src/doctor/busy";
import { systemLauncher } from "../src/proc/system-launcher";
import { productionEdge, type DoctorEdge } from "../src/doctor/edge";
import {
  emptyStores,
  healthyDaemonEdge,
  healthyDataEdge,
  HEALTHY_INSTALL_EDGE,
  noManagedSettings,
} from "./helpers/doctor-facts";
import { applyClick, applyClickAnswered, clickUrl, recordRender, testVerbContext } from "./helpers/click";
import { EMPTY_DEFAULT, parseAndValidate } from "./helpers/parse-and-validate";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { listResolvablePaletteNames } from "../src/themes/policy";
import { durableConfig } from "./helpers/durable-config";
import { systemTimekeeper } from "../src/time";

const ALLOWED = new Set(listResolvablePaletteNames());
const RULE = "─".repeat(60);
const IDLE_SCREEN = ["⏺ Done.", "", "", `${RULE} probe ─`, "❯ ", RULE, "  ⏸ manual mode on"];
const NONCE = "01234567-89ab-cdef-0123-456789abcdef";
const A = "session-a";
const B = "session-b";
type Load = ReturnType<DoctorEdge["loadConfig"]>;
const LOAD = { layers: [], error: null, warning: null, unused: [], config: EMPTY_DEFAULT } as unknown as Load;
// As production: a reload that fails keeps the config it had.
const FAILED_LOAD = { ...LOAD, error: "the file changed" } as Load;

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
  const turns = new JournalTurns();
  for (const sid of [A, B]) {
    recordRender(sessionState, sid);
    sessionState.set(sid, SESSION_CLIENT_HINTS_KEY, "{}");
  }
  const held = gate();
  const healthy = healthyDaemonEdge().daemons;
  const gathers: string[] = [];
  const ctx: VerbContext = {
    ...testVerbContext(sessionState, undefined, EMPTY_DEFAULT, undefined, turns),
    log: (_level, line) => logged.push(line),
    doctorStores: emptyStores(),
    doctor: edge({
      daemons: async () => {
        gathers.push(`holder=${turns.inTurn()}`);
        await held.wait;
        return healthy();
      },
      ...over,
    }),
  };
  const toggled = (sid: string) => sessionState.get(sid, "toolbar-expanded");
  // A click through Apply: answers once its turn has landed, with the handle
  // that settles once its effects (a doctor's report) have landed too.
  const clickOf = (url: string, c: VerbContext, gone?: () => boolean) =>
    applyClick(url, c, gone);
  const doctor = (sid: string, c: VerbContext = ctx, gone?: () => boolean) =>
    clickOf(`cc-candybar://to/main/${VERB_DOCTOR_RUN}/${encodeURIComponent(sid)}`, c, gone);
  const toggle = (sid: string, c: VerbContext = ctx) =>
    clickOf(`cc-candybar://to/main/${VERB_TOOLBAR_TOGGLE}/${encodeURIComponent(sid)}`, c);
  const doDoctorThen = (c: VerbContext = ctx, gone?: () => boolean) =>
    clickOf(
      effectsUrl(MAIN_NAME, [
        { verb: VERB_DOCTOR_RUN, args: [A] },
        { verb: VERB_TOOLBAR_TOGGLE, args: [A] },
      ]),
      c,
      gone,
    );
  const reports = () => logged.filter((l) => l.startsWith("doctor: "));
  const effectLines = () => logged.filter((l) => l.startsWith("apply kind=effect-done"));
  return { sessionState, logged, turns, held, gathers, ctx, toggled, doctor, toggle, doDoctorThen, reports, effectLines };
}

describe("a gather holds no turn", () => {
  test("session B's click lands while A's doctor gather parks, and A's report lands", async () => {
    const { held, gathers, doctor, toggle, toggled, reports } = setup();
    const a = await doctor(A);
    await drain();
    expect(gathers).toEqual(["holder=null"]);
    await toggle(B);
    expect(toggled(B)).toBe("1");
    expect(reports()).toEqual([]);
    held.open();
    await a.performed;
    expect(reports()).toHaveLength(1);
  });

  test("two sessions' doctor gathers run one at a time, while a toggle passes both", async () => {
    const { turns, held, gathers, doctor, toggle, toggled, reports } = setup();
    const a = await doctor(A);
    const b = await doctor(B);
    await drain();
    expect(gathers).toHaveLength(1);
    expect(turns.getStats().gathers).toBe(2);
    await toggle("session-c");
    expect(toggled("session-c")).toBe("1");
    held.open();
    await Promise.all([a.performed, b.performed]);
    expect(reports()).toHaveLength(2);
  });

  test("a doctor click whose client left during the gather still files its report", async () => {
    const { held, doctor, ctx, reports } = setup();
    let gone = false;
    const a = await doctor(A, ctx, () => gone);
    await drain();
    gone = true;
    held.open();
    await a.performed;
    expect(reports()).toHaveLength(1);
  });

  test("a `do` of doctor then a write lands the write before the probes run, and the report after", async () => {
    const { held, doDoctorThen, toggled, reports } = setup();
    const a = await doDoctorThen();
    await drain();
    expect(toggled(A)).toBe("1");
    expect(reports()).toEqual([]);
    held.open();
    await a.performed;
    expect(reports()).toHaveLength(1);
  });

  test("two doctor steps of one click gather one after the other, each in no turn", async () => {
    const { held, gathers, ctx, reports } = setup();
    const twice = await applyClick(
      effectsUrl(MAIN_NAME, [
        { verb: VERB_DOCTOR_RUN, args: [A] },
        { verb: VERB_DOCTOR_RUN, args: [A] },
      ]),
      ctx,
    );
    held.open();
    await twice.performed;
    expect(gathers).toEqual(["holder=null", "holder=null"]);
    expect(reports()).toHaveLength(2);
  });

  test("doctor-probe answers at once while a doctor's probes park, whoever left", async () => {
    const { ctx, held, doctor } = setup();
    const a = await doctor(B);
    await drain();
    VERBS.get(VERB_DOCTOR_PROBE)!(NONCE, {
      ...ctx,
      arrival: { via: "link", delivery: { kind: "cli" } },
      gone: () => true,
    });
    expect(ctx.probes.list().map((p) => p.nonce)).toEqual([NONCE]);
    held.open();
    await a.performed;
  });
});

describe("one session's order", () => {
  test("a later click of the session lands while its doctor's probes run; the report still lands over inputs it did not move", async () => {
    const { held, doctor, toggle, toggled, reports } = setup();
    const a = await doctor(A);
    await drain();
    await toggle(A);
    expect(toggled(A)).toBe("1");
    expect(reports()).toEqual([]);
    held.open();
    await a.performed;
    expect(reports()).toHaveLength(1);
  });

  test("two doctor clicks of one session reach their verdicts in the order they were clicked", async () => {
    const first = gate();
    let probes = 0;
    const { ctx, logged } = setup({
      daemons: async () => {
        if (++probes === 1) await first.wait;
        return healthyDaemonEdge().daemons();
      },
    });
    const marked = await applyClick(
      `cc-candybar://to/main/${VERB_DOCTOR_MARK}/${encodeSegments([A, "nerdFont", "drawn"])}`,
      ctx,
    );
    const run = await doctorRunOf(A, ctx);
    await drain();
    expect(probes).toBe(1);
    first.open();
    await Promise.all([marked.performed, run.performed]);
    const said = logged.filter(
      (l) => l.startsWith("doctor: ") || l.startsWith("apply kind=effect-done"),
    );
    expect(said).toEqual([
      expect.stringMatching(/^apply kind=effect-done .* effect=doctor:mark outcome=failed said="doctor-mark: .*nothing to (mark|look at)/),
      expect.stringMatching(/^doctor: /),
      expect.stringMatching(/^apply kind=effect-done .* effect=doctor:run outcome=ok /),
    ]);
  });
});

const doctorRunOf = (sid: string, ctx: VerbContext) =>
  applyClick(`cc-candybar://to/main/${VERB_DOCTOR_RUN}/${encodeURIComponent(sid)}`, ctx);

describe("a gather is a snapshot of what it read", () => {
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
        ...testVerbContext(sessionState, fixture.historyFor(sessionState), config, fixture.host),
        doctorStores: emptyStores(),
        doctor: edge({
          daemons: () => {
            seen.push(fixture.text());
            return healthy();
          },
        }),
      };
      await clickUrl(
        effectsUrl(MAIN_NAME, [
          { verb: VERB_SET_CONFIG, args: [A, "palette", [...ALLOWED][0]!] },
          { verb: VERB_DOCTOR_RUN, args: [A] },
        ]),
        ctx,
      );
      expect(seen).toHaveLength(1);
      expect(seen[0]).toContain("palette");
    } finally {
      fixture.dispose();
    }
  });

  test("a config write landing during a gather makes the performer gather once more, in no turn, and the report matches it", async () => {
    let load = LOAD;
    const { held, gathers, doctor, reports } = setup({ loadConfig: () => load });
    const a = await doctor(A);
    await drain();
    load = FAILED_LOAD;
    held.open();
    await a.performed;
    expect(gathers).toEqual(["holder=null", "holder=null"]);
    expect(reports()).toHaveLength(1);
    expect(reports()[0]).toContain("config=failed(");
  });

  test("a resize during the probes moves nothing the doctor reads: one gather, and its report lands", async () => {
    let probes = 0;
    const { ctx, sessionState, reports } = setup({
      daemons: async () => {
        probes++;
        ctx.journalTurns.take("request", () =>
          sessionState.set(A, SESSION_CLIENT_HINTS_KEY, JSON.stringify({ termCols: 80 + probes })),
        );
        return healthyDaemonEdge().daemons();
      },
    });
    await clickUrl(`cc-candybar://to/main/${VERB_DOCTOR_RUN}/${encodeURIComponent(A)}`, ctx);
    expect(probes).toBe(1);
    expect(reports()).toHaveLength(1);
  });

  test("a pick the doctor reads, written by the session's next click during the probes, is gathered again", async () => {
    let probes = 0;
    const first = gate();
    const { ctx, reports } = setup({
      daemons: async () => {
        if (++probes === 1) await first.wait;
        return healthyDaemonEdge().daemons();
      },
    });
    const a = await doctorRunOf(A, ctx);
    await drain();
    await clickUrl(`cc-candybar://to/main/${VERB_SET_STATE}/${encodeSegments([A, "theme", "nord"])}`, ctx);
    first.open();
    await a.performed;
    expect(probes).toBe(2);
    expect(reports()).toHaveLength(1);
  });

  test("inputs that move through both gathers refuse the step loudly, and no report is filed", async () => {
    let probes = 0;
    const { ctx, sessionState, reports } = setup({
      daemons: async () => {
        probes++;
        // Each gather's hints are gone by the time it ends: a request recorded
        // a Claude Code config directory the doctor reads while the probes ran.
        ctx.journalTurns.take("request", () =>
          sessionState.set(
            A,
            SESSION_CLIENT_HINTS_KEY,
            JSON.stringify({ claudeConfigDir: `/claude-${probes}` }),
          ),
        );
        return healthyDaemonEdge().daemons();
      },
    });
    await clickUrl(`cc-candybar://to/main/${VERB_DOCTOR_RUN}/${encodeURIComponent(A)}`, ctx);
    expect(probes).toBe(2);
    expect(reports()).toEqual([]);
    expect(lastClickError(sessionState, A)?.text).toBe(
      `doctor: the session's ${SESSION_CLIENT_HINTS_KEY} changed during the doctor's probes — click again`,
    );
  });

  test("the re-gather asks the real rate limiter nothing twice", async () => {
    const launcher = systemLauncher({ inherited: process.env }, systemTimekeeper);
    let load = LOAD;
    const real = productionEdge(launcher, () => load, HOST);
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
    const a = await doctorRunOf(A, c);
    await new Promise((resolve) => setTimeout(resolve, 50));
    load = FAILED_LOAD;
    parked.open();
    await a.performed;
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
  const { performed } = await doDoctorThen();
  await performed;
  expect(toggled(A)).toBe("1");
  expect(reports()).toEqual([]);
  expect(sessionState.get(A, "click.error")).toContain("ps broke");
});

test("a dispatch's refused step and its doctor's refusal both show on the bar, in order", async () => {
  const { ctx, sessionState } = setup({
    daemons: async () => {
      throw new DoctorBusy("the processes");
    },
  });
  const { answer, performed } = await applyClickAnswered(
    effectsUrl(MAIN_NAME, [
      { verb: VERB_SET_STATE, args: [A, "no-such-key", "x"] },
      { verb: VERB_DOCTOR_RUN, args: [A] },
    ]),
    ctx,
  );
  expect(answer).not.toBeNull();
  await performed;
  expect(clickErrors(sessionState, A).map((e) => e.text)).toEqual([
    expect.stringMatching(/^set-state: /),
    expect.stringMatching(/processes/),
  ]);
});

test("tsc refuses `ctx.launcher` in a VerbHandler, and an async handler", () => {
  const handler: VerbHandler = (_value, ctx) => {
    // @ts-expect-error A handler reaches launches through the turn alone.
    void ctx.launcher;
    // @ts-expect-error As above.
    void ctx.doctor;
    // @ts-expect-error As above.
    void ctx.claudeInput;
  };
  // @ts-expect-error A handler is synchronous: one that awaits would write
  // after its turn.
  const awaiting: VerbHandler = async () => {};
  expect([handler, awaiting]).toHaveLength(2);
});

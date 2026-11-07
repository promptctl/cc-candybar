// A request takes its turn (src/daemon/apply.ts): its arm records what the
// client said in a journal turn and draws once the turn is over. A turn is
// synchronous, so a request waits behind no other session's work, and no
// draw can run inside a click's turn: a click is drawn whole or not at all. A
// doctor click's probes run after its turn, in none, so a request sent while
// they park draws at once. Driven through Apply over the real journal turns
// and the real click arm; the daemon's draw is a fake that reads what a frame
// would read, the session's state as the draw begins.
//
// [LAW:behavior-not-structure] The cases read the store as the draw does and
// the facts the request's line carries.

import { MAIN_NAME } from "../src/daemon/home";
import {
  effectsUrl,
  VERB_DISPATCH,
  VERB_DOCTOR_RUN,
  VERB_TOOLBAR_TOGGLE,
} from "../src/click/wire";
import { applyRequest } from "../src/daemon/apply";
import { encodeRenderOrigin } from "../src/daemon/foundations/render-origin";
import type { RequestAnswer } from "../src/daemon/draw-bar";
import { SESSION_CLIENT_HINTS_KEY } from "../src/daemon/foundations/session-keys";
import { JournalTurns } from "../src/daemon/journal-turns";
import type { CheckedRenderRequest } from "../src/daemon/render-checkpoint";
import type { RequestFacts } from "../src/daemon/request-event";
import { sessionIdOf } from "../src/daemon/session-id";
import { SessionState, SINGLE_RUN } from "../src/daemon/session-state";
import { DaemonClosing } from "../src/daemon/verb-error";
import { PERFORMED } from "../src/daemon/effect-outcome";
import type { LaneSetupEffect } from "../src/daemon/lane-setup";
import type { Effect } from "../src/daemon/effect";
import { doctorReportKeys } from "../src/doctor/report";
import type { VerbContext } from "../src/daemon/verbs";
import type { DoctorEdge } from "../src/doctor/edge";
import { instantOf } from "../src/utils/instant";
import { MISMATCH_RACE_S } from "../src/daemon/mismatch-runs";
import type { SessionPane } from "../src/daemon/session-pane";
import { applyClick, recordRender, TEST_STORED_ROOT, testVerbContext } from "./helpers/click";
import {
  emptyStores,
  HEALTHY_INSTALL_EDGE,
  healthyDaemonEdge,
  healthyDataEdge,
  noManagedSettings,
} from "./helpers/doctor-facts";
import { NO_REPOS } from "./helpers/repo-gate";
import { heldClock } from "./helpers/held-clock";
import { plusMs } from "../src/time";
import { EMPTY_DEFAULT } from "./helpers/parse-and-validate";
import { CLAUDE_START } from "./helpers/claude-record";

const SID = "session-a";
const OTHER = "session-b";
const DIR = "/tmp/proj";
const START = new Date("2026-11-05T12:00:00Z");
const AT = instantOf(START);
const TOOLBAR = "toolbar-expanded";
type Load = ReturnType<DoctorEdge["loadConfig"]>;
const LOAD = {
  layers: [],
  error: null,
  warning: null,
  unused: [],
  repos: NO_REPOS,
  config: EMPTY_DEFAULT,
} as unknown as Load;

function gate(): { wait: Promise<void>; open: () => void } {
  let open = (): void => {};
  const wait = new Promise<void>((resolve) => (open = resolve));
  return { wait, open };
}

async function drain(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

// A render request past the checkpoint, as the arm reads it: its session,
// its hints and the config inputs it named.
const REQUESTED = { projectDir: DIR, cwd: DIR, target: { source: "search" } } as const;
const CLAUDE = { pid: 4242, startTime: CLAUDE_START, configDir: undefined };
const RUNS: SessionPane = { kind: "runs", tmux: null, claude: CLAUDE };
const request = (termCols: number, sid = SID, pane: SessionPane = RUNS): CheckedRenderRequest =>
  ({
    sessionId: sessionIdOf(sid),
    hints: { termCols },
    requested: REQUESTED,
    originRecord: encodeRenderOrigin(REQUESTED, TEST_STORED_ROOT),
    pane,
  }) as unknown as CheckedRenderRequest;

const toggle = { verb: VERB_TOOLBAR_TOGGLE, args: [SID] } as const;
const doctor = { verb: VERB_DOCTOR_RUN, args: [SID] } as const;

// What the fake draw read as it began: the state a frame would be drawn from,
// and whether any turn was held.
interface Drawn {
  readonly toolbar: string | null;
  readonly hints: string | null;
  readonly report: boolean;
  readonly holder: string | null;
}

const ANSWER: RequestAnswer = {
  resp: { ok: true, output: "" },
  motion: "still",
  answersClick: [],
  pipeShown: null,
  delivered: () => {},
};

// The click path over a doctor edge whose process probe parks on a gate, and
// the request arm's parts over the same context, so both write through the
// ordering instrument the context holds (test/helpers/click.ts).
function rig() {
  const clock = heldClock(START);
  // How many times the store persisted: a write that changes nothing still
  // persists and fires the session's atom, which the revision does not show.
  const persisted = { saves: 0 };
  const sessionState = new SessionState(SINGLE_RUN, {
    load: () => ({}),
    save: () => void persisted.saves++,
    flush: () => {},
  });
  const turns = new JournalTurns();
  for (const sid of [SID, OTHER]) {
    recordRender(sessionState, sid, DIR);
    sessionState.set(sid, SESSION_CLIENT_HINTS_KEY, "{}");
  }
  const parked = gate();
  const healthy = healthyDaemonEdge().daemons;
  const ctx: VerbContext = {
    ...testVerbContext(sessionState, undefined, EMPTY_DEFAULT, undefined, turns),
    doctorStores: emptyStores(),
    doctor: {
      install: HEALTHY_INSTALL_EDGE,
      ...healthyDataEdge(),
      ...noManagedSettings(),
      loadConfig: () => LOAD,
      probeTmux: async () => ({ kind: "failed", reason: "no tmux" }),
      remoteLogin: async () => {
        throw new Error("doctor: no process edge in this test");
      },
      fontInUse: async () => {
        throw new Error("doctor: no font edge in this test");
      },
      daemons: () => parked.wait.then(healthy),
    },
  };
  const { arrival: _arrival, described: _described, ...verbCtx } = ctx;
  const drawn: Drawn[] = [];
  // A draw that waits on its sources until `sources` settles, as a request
  // whose view declares a source not answered yet, then reads the session.
  let sources: Promise<void> = Promise.resolve();
  const parts = {
    verbCtx,
    log: ctx.log,
    draw: async (req: CheckedRenderRequest): Promise<RequestAnswer> => {
      await sources;
      drawn.push({
        toolbar: sessionState.get(req.sessionId, TOOLBAR),
        hints: sessionState.get(req.sessionId, SESSION_CLIENT_HINTS_KEY),
        report:
          sessionState.get(req.sessionId, doctorReportKeys("utf8").verdict) !== null,
        holder: turns.inTurn(),
      });
      return ANSWER;
    },
  };
  const render = (termCols: number, sid = SID, pane: SessionPane = RUNS, arrived = clock.monotonic()) => {
    const facts: RequestFacts = [];
    const answered = applyRequest(
      {
        kind: "request",
        req: request(termCols, sid, pane),
        at: AT,
        arrived,
        waitEndsAt: clock.monotonic(),
        facts,
      },
      parts,
    );
    return { answered, facts };
  };
  const waitOn = (wait: Promise<void>) => (sources = wait);
  return { clock, sessionState, persisted, turns, parked, ctx, drawn, render, waitOn };
}

describe("a request takes its turn", () => {
  test("a request for one session, sent while another's dispatch parks in its doctor step's probes, draws at once and in no turn", async () => {
    const r = rig();
    const click = await applyClick(
      effectsUrl(MAIN_NAME, [
        { verb: VERB_TOOLBAR_TOGGLE, args: [OTHER] },
        { verb: VERB_DOCTOR_RUN, args: [OTHER] },
        { verb: VERB_TOOLBAR_TOGGLE, args: [OTHER] },
      ]),
      r.ctx,
    );
    await drain();
    expect(r.turns.getStats().gathers).toBe(1);
    const { answered, facts } = r.render(60);
    await answered;
    expect(r.drawn).toEqual([
      { toolbar: null, hints: JSON.stringify({ termCols: 60 }), report: false, holder: null },
    ]);
    expect(facts).toEqual([
      ["revision", String(r.sessionState.revision(SID))],
      ["effects", "-"],
      ["mismatch", "-"],
    ]);
    r.parked.open();
    await click.performed;
  });

  test("a draw while a click's doctor step parks reads the click whole, its report not yet landed; after, the report", async () => {
    const r = rig();
    const click = await applyClick(effectsUrl(MAIN_NAME, [toggle, doctor, toggle]), r.ctx);
    await drain();
    await r.render(60).answered;
    r.parked.open();
    await click.performed;
    await r.render(60).answered;
    // Both toggles landed in the click's one turn: never the first alone.
    expect(r.drawn).toEqual([
      { toolbar: null, hints: JSON.stringify({ termCols: 60 }), report: false, holder: null },
      { toolbar: null, hints: JSON.stringify({ termCols: 60 }), report: true, holder: null },
    ]);
  });

  test("a click that lands while a request's draw waits on its sources is drawn whole: its writes are all in, in no turn", async () => {
    const r = rig();
    const sources = gate();
    r.waitOn(sources.wait);
    const { answered } = r.render(60);
    await drain();
    // The click lands while the draw waits, then parks in its doctor's
    // probes; every write it made passed the instrument inside its turn.
    const click = await applyClick(effectsUrl(MAIN_NAME, [toggle, doctor]), r.ctx);
    sources.open();
    await answered;
    expect(r.drawn).toEqual([
      { toolbar: "1", hints: JSON.stringify({ termCols: 60 }), report: false, holder: null },
    ]);
    r.parked.open();
    await click.performed;
  });

  test("a request after the daemon closed is refused as the close, having drawn and written nothing", async () => {
    const r = rig();
    r.turns.close();
    const refused = await r.render(60).answered.then(
      () => null,
      (e: unknown) => e,
    );
    // The render edge reads the class, as a click's does: `closing`, at info.
    expect(refused).toBeInstanceOf(DaemonClosing);
    expect(r.drawn).toEqual([]);
    expect(r.sessionState.get(SID, SESSION_CLIENT_HINTS_KEY)).toBe("{}");
  });

  test("a request that says what the last one said writes nothing: the store persists nothing and the revision stands", async () => {
    const r = rig();
    await r.render(60).answered;
    const revision = r.sessionState.revision(SID);
    const saves = r.persisted.saves;
    const { answered, facts } = r.render(60);
    await answered;
    expect(r.persisted.saves).toBe(saves);
    expect(r.sessionState.revision(SID)).toBe(revision);
    expect(facts).toEqual([
      ["revision", String(revision)],
      ["effects", "-"],
      ["mismatch", "-"],
    ]);
  });

  test("a request's run of mismatched pane stamps lands in its turn, and its line says so", async () => {
    const r = rig();
    const runs = r.ctx.mismatchRuns;
    const mismatched: SessionPane = { kind: "mismatched", tmux: null, claude: CLAUDE, held: "session-b", why: "its Claude Code holds session-b" };
    const opened = r.clock.monotonic();
    await r.render(60, SID, mismatched, opened).answered;
    expect(runs.of(SID, mismatched)).toEqual({ since: opened, lasted: false });
    const past = r.render(60, SID, mismatched, plusMs(opened, (MISMATCH_RACE_S + 1) * 1000));
    await past.answered;
    expect(runs.lasted(SID, mismatched)).toBe(true);
    expect(past.facts).toContainEqual(["mismatch", `lasted ${(MISMATCH_RACE_S + 1) * 1000}ms`]);
    await r.render(60).answered;
    expect(runs.of(SID, mismatched)).toBeNull();
  });
});

// [LAW:no-ambient-temporal-coupling] What a request's arrival settles is its
// turn's: the lane setups its session's clicks owed take their place in their
// lane's order as the turn ends, so a click on that lane made while the draw
// waits is performed after them, and a draw that fails loses none.
describe("a request's arrival settles in its turn", () => {
  const setup = (on: boolean, by: LaneSetupEffect["by"]): LaneSetupEffect => ({
    kind: "lane-setup",
    sessionId: SID,
    lane: "statusline",
    on,
    by,
  });

  function arrivalRig(
    draw: () => Promise<RequestAnswer>,
    arrives: readonly Effect[] = [setup(true, "owed")],
    // What a setup waits on before it ends.
    setupEnds: Promise<void> = Promise.resolve(),
  ) {
    const clock = heldClock(START);
    const sessionState = new SessionState(SINGLE_RUN);
    recordRender(sessionState, SID, DIR);
    const turns = new JournalTurns();
    const performed: string[] = [];
    // The request settles the setup its session's earlier click owed; the
    // click after it moves the lane back.
    let owed: readonly Effect[] = arrives;
    const base = testVerbContext(sessionState, undefined, EMPTY_DEFAULT, undefined, turns);
    const ctx: VerbContext = {
      ...base,
      lanes: {
        ...base.lanes,
        arrived: () => {
          const settled = owed;
          owed = [];
          return settled;
        },
        clicked: () => [setup(false, "click")],
        setup: async ({ on, by }) => {
          await setupEnds;
          performed.push(`${on ? "on" : "off"} by=${by}`);
          return PERFORMED;
        },
      },
      applyUpdate: async () => void performed.push("update"),
    };
    const { arrival: _arrival, described: _described, ...verbCtx } = ctx;
    const facts: RequestFacts = [];
    const render = () =>
      applyRequest(
        { kind: "request", req: request(60), at: AT, arrived: clock.monotonic(), waitEndsAt: clock.monotonic(), facts },
        { verbCtx, log: ctx.log, draw },
      );
    return { ctx, facts, performed, render };
  }

  test("a click made while the request's draw waits is performed after the setups the request settled", async () => {
    const sources = gate();
    const r = arrivalRig(async () => {
      await sources.wait;
      return ANSWER;
    });
    const answered = r.render();
    await drain();
    // The draw still waits, and the setup it settled is already performed,
    // named on the request's line.
    expect(r.performed).toEqual(["on by=owed"]);
    expect(r.facts).toContainEqual(["effects", "lane-setup:statusline-on"]);
    const click = await applyClick(effectsUrl(MAIN_NAME, [toggle]), r.ctx);
    await click.performed;
    sources.open();
    await answered;
    expect(r.performed).toEqual(["on by=owed", "off by=click"]);
  });

  // [LAW:no-ambient-temporal-coupling] A setup's step in a pane takes the
  // pane's place only once it is reached, so whatever its event described
  // after it would wait on it: an event's setups run after its other
  // effects, in whatever order they were described.
  test("an event's setups run after its other effects, though described first", async () => {
    let release!: () => void;
    const r = arrivalRig(
      async () => ANSWER,
      [setup(true, "owed"), { kind: "apply-update" }],
      new Promise<void>((resolve) => (release = resolve)),
    );
    await r.render();
    await drain();
    expect(r.performed).toEqual(["update"]);
    release();
    await drain();
    expect(r.performed).toEqual(["update", "on by=owed"]);
  });

  test("a draw that fails loses none of the setups its request settled", async () => {
    const r = arrivalRig(async () => {
      throw new Error("the draw failed");
    });
    await expect(r.render()).rejects.toThrow("the draw failed");
    await drain();
    expect(r.performed).toEqual(["on by=owed"]);
  });
});

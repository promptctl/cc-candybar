// A request takes its turn (src/daemon/apply.ts): its arm records what the
// client said in a journal turn and draws once the turn is over, so a request
// that arrives while a click's turn is held draws the click whole, never its
// first write beside the request's hints; and it waits behind turns alone,
// never behind a click's gather. Driven through Apply over the real journal
// turns and the real click arm; the daemon's draw is a fake that reads what a
// frame would read, the session's state as the draw begins.
//
// [LAW:behavior-not-structure] The cases read the store as the draw does and
// the facts the request's line carries; how the turn is queued is the
// journal's own (test/journal-turns.test.ts).

import {
  effectsUrl,
  VERB_DISPATCH,
  VERB_DOCTOR_RUN,
  VERB_TOOLBAR_TOGGLE,
} from "../src/click/wire";
import { apply } from "../src/daemon/apply";
import type { RequestAnswer } from "../src/daemon/draw-bar";
import { SESSION_CLIENT_HINTS_KEY } from "../src/daemon/foundations/session-keys";
import { JournalTurns } from "../src/daemon/journal-turns";
import type { CheckedRenderRequest } from "../src/daemon/render-checkpoint";
import type { RequestFacts } from "../src/daemon/request-event";
import { sessionIdOf } from "../src/daemon/session-id";
import { SessionState } from "../src/daemon/session-state";
import { DaemonClosing } from "../src/daemon/verb-error";
import type { VerbContext } from "../src/daemon/verbs";
import type { DoctorEdge } from "../src/doctor/edge";
import { instantOf } from "../src/utils/instant";
import { applyClick, recordRender, testVerbContext } from "./helpers/click";
import {
  emptyStores,
  HEALTHY_INSTALL_EDGE,
  healthyDaemonEdge,
  healthyDataEdge,
  noManagedSettings,
} from "./helpers/doctor-facts";
import { heldClock } from "./helpers/held-clock";
import { EMPTY_DEFAULT } from "./helpers/parse-and-validate";

const SID = "session-a";
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
const request = (termCols: number): CheckedRenderRequest =>
  ({
    sessionId: sessionIdOf(SID),
    hints: { termCols },
    requested: { projectDir: DIR, cwd: DIR, target: { source: "search" } },
  }) as unknown as CheckedRenderRequest;

const toggle = { verb: VERB_TOOLBAR_TOGGLE, args: [SID] } as const;
const doctor = { verb: VERB_DOCTOR_RUN, args: [SID] } as const;

// What the fake draw read as it began: the state a frame would be drawn from,
// and whether any turn was held.
interface Drawn {
  readonly toolbar: string | null;
  readonly hints: string | null;
  readonly holder: string | null;
}

const ANSWER: RequestAnswer = {
  resp: { ok: true, output: "" },
  motion: "still",
  answersClick: null,
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
  const sessionState = new SessionState({
    load: () => ({}),
    save: () => void persisted.saves++,
    flush: () => {},
  });
  const turns = new JournalTurns({
    log: () => {},
    monotonic: () => clock.monotonic(),
  });
  recordRender(sessionState, SID, DIR);
  sessionState.set(SID, SESSION_CLIENT_HINTS_KEY, "{}");
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
  const { arrival: _arrival, asker: _asker, described: _described, ...verbCtx } = ctx;
  const drawn: Drawn[] = [];
  const parts = {
    verbCtx,
    log: ctx.log,
    draw: async (): Promise<RequestAnswer> => {
      drawn.push({
        toolbar: sessionState.get(SID, TOOLBAR),
        hints: sessionState.get(SID, SESSION_CLIENT_HINTS_KEY),
        holder: turns.getStats().holder,
      });
      return ANSWER;
    },
  };
  const render = (termCols: number) => {
    const facts: RequestFacts = [];
    const answered = apply(
      {
        kind: "request",
        req: request(termCols),
        at: AT,
        waitEndsAt: clock.monotonic(),
        facts,
      },
      parts,
    );
    return { answered, facts };
  };
  return { clock, sessionState, persisted, turns, parked, ctx, drawn, render };
}

describe("a request takes its turn", () => {
  test("a request that arrives while a click's turn is held draws once the click has landed whole, at the request's width", async () => {
    const r = rig();
    // The click's first write lands, then its doctor gathers inside the turn,
    // parked: the turn is held with the toolbar toggled and the second toggle
    // still to come.
    const click = applyClick(effectsUrl([toggle, doctor, toggle]), r.ctx);
    await drain();
    expect(r.turns.getStats().holder).toBe(VERB_DISPATCH);
    expect(r.sessionState.get(SID, TOOLBAR)).toBe("1");

    const { answered, facts } = r.render(60);
    let done = false;
    void answered.then(() => (done = true));
    r.clock.advance(30);
    await drain();
    // The request waits for the turn: nothing drawn, nothing written.
    expect(done).toBe(false);
    expect(r.drawn).toEqual([]);
    expect(r.sessionState.get(SID, SESSION_CLIENT_HINTS_KEY)).toBe("{}");

    r.parked.open();
    await click;
    await answered;
    // Drawn after the click's turn, from the state it left: the toolbar back
    // as it was, the request's hints recorded, no turn held while drawing.
    expect(r.drawn).toEqual([
      { toolbar: null, hints: JSON.stringify({ termCols: 60 }), holder: null },
    ]);
    expect(facts).toEqual([
      ["turnWait", "30ms"],
      ["revision", String(r.sessionState.revision(SID))],
    ]);
  });

  test("a request waits behind turns alone: a click parked in its head gather, before any turn, delays it by nothing", async () => {
    const r = rig();
    const click = applyClick(effectsUrl([doctor]), r.ctx);
    await drain();
    expect(r.turns.getStats()).toMatchObject({ holder: null, gathers: 1 });
    const { answered, facts } = r.render(60);
    r.clock.advance(30);
    await answered;
    expect(r.turns.getStats().gathers).toBe(1);
    expect(r.drawn).toEqual([
      { toolbar: null, hints: JSON.stringify({ termCols: 60 }), holder: null },
    ]);
    expect(facts[0]).toEqual(["turnWait", "0ms"]);
    r.parked.open();
    await click;
  });

  test("a request queued behind a held turn when the daemon closes is refused as the close, having drawn and written nothing", async () => {
    const r = rig();
    const click = applyClick(effectsUrl([toggle, doctor, toggle]), r.ctx);
    await drain();
    expect(r.turns.getStats().holder).toBe(VERB_DISPATCH);
    const { answered, facts } = r.render(60);
    const refused = answered.then(
      () => null,
      (e: unknown) => e,
    );
    await drain();
    // The close refuses what is queued as its turn arrives, once the held
    // turn has ended.
    r.turns.close();
    r.parked.open();
    await click.catch(() => {});
    // The render edge reads the class, as a click's does: `closing`, at info.
    expect(await refused).toBeInstanceOf(DaemonClosing);
    expect(r.drawn).toEqual([]);
    expect(r.sessionState.get(SID, SESSION_CLIENT_HINTS_KEY)).toBe("{}");
    expect(facts).toEqual([]);
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
      ["turnWait", "0ms"],
      ["revision", String(revision)],
    ]);
  });
});

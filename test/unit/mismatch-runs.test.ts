// candybar-gather-renderer-76bb.1dh.2d2: a mismatched pane stamp is the
// /clear rewrite race until its session's run of them outlasts it; only a
// confirmed tick from the same Claude Code, of any session, ends a run, and its
// first tick of a session dates the rewrite a straggler races.

import {
  MISMATCH_RACE_S,
  MISMATCH_RUNS_KEPT,
  MismatchRuns,
  mismatchFact,
} from "../../src/daemon/mismatch-runs";
import type { ClaudeProcess, SessionPane } from "../../src/daemon/session-pane";
import { SINGLE_RUN } from "../../src/daemon/session-state";
import type { Monotonic } from "../../src/time";

// [LAW:no-ambient-temporal-coupling] Every reading a case takes is its own:
// seconds after the /clear that rewrote the record, on the monotonic clock.
const CLEARED = 50_000;
const after = (s: number): Monotonic => (CLEARED + s * 1000) as Monotonic;

const PANE_CLAUDE: ClaudeProcess = { pid: 4242, configDir: undefined };
const OTHER_CLAUDE: ClaudeProcess = { pid: 5151, configDir: undefined };

// A tick from `claude`, whose record holds `held` when it is not the session's.
const mismatched = (held: string, claude = PANE_CLAUDE): SessionPane => ({
  kind: "mismatched",
  tmux: null,
  claude,
  held,
  why: `the Claude Code that ran its statusline (pid ${claude.pid}) holds session ${held}`,
});
const runs = (claude = PANE_CLAUDE): SessionPane => ({ kind: "runs", tmux: null, claude });
const shell: SessionPane = { kind: "unconfirmed", tmux: null, why: "its parent keeps no record" };

describe("a session's run of mismatched stamps", () => {
  test("a cleared session's stragglers inside the race open a run that has not lasted", () => {
    const owner = new MismatchRuns(SINGLE_RUN);
    owner.record("A", mismatched("B"), after(1));
    expect(owner.record("A", mismatched("B"), after(MISMATCH_RACE_S))).toEqual({
      since: after(1),
      lasted: false,
    });
    expect(owner.lasted("A", PANE_CLAUDE)).toBe(false);
  });

  test("a mismatched tick past the race after the run opened marks it lasted, however far apart its ticks", () => {
    const owner = new MismatchRuns(SINGLE_RUN);
    owner.record("B", mismatched("A"), after(0));
    owner.record("B", mismatched("A"), after(MISMATCH_RACE_S + 1));
    expect(owner.lasted("B", PANE_CLAUDE)).toBe(true);
    // A Claude Code with no refresh interval ticks only on events.
    expect(owner.record("B", mismatched("A"), after(3600))).toEqual({ since: after(0), lasted: true });
    expect(owner.lasted("B", PANE_CLAUDE)).toBe(true);
  });

  test("the new session's confirmed tick ends the cleared session's run, so its resume's forerunner opens a fresh one", () => {
    const owner = new MismatchRuns(SINGLE_RUN);
    owner.record("A", mismatched("B"), after(1));
    owner.record("B", runs(), after(2));
    expect(owner.of("A", PANE_CLAUDE)).toBeNull();
    // An hour on, `/resume A` in the same Claude Code: its first tick beats
    // the record's rewrite, inside its own race.
    expect(owner.record("A", mismatched("B"), after(3600))).toEqual({ since: after(3600), lasted: false });
  });

  test("a straggler after the new session's first confirmed tick is the race, so its resume's forerunner opens a fresh run", () => {
    const owner = new MismatchRuns(SINGLE_RUN);
    owner.record("B", runs(), after(0.3));
    expect(owner.record("A", mismatched("B"), after(1))).toBeNull();
    // B goes on ticking: its record was rewritten when its first tick came.
    owner.record("B", runs(), after(5));
    expect(owner.record("A", mismatched("B"), after(MISMATCH_RACE_S))).toBeNull();
    // An idle hour on, `/resume A` beats the record's rewrite.
    expect(owner.record("A", mismatched("B"), after(3600))).toEqual({ since: after(3600), lasted: false });
    expect(owner.record("A", mismatched("B"), after(3600 + MISMATCH_RACE_S + 1))?.lasted).toBe(true);
  });

  test("a record that stops being rewritten holds a session confirmed long before, so the new session's run lasts", () => {
    const owner = new MismatchRuns(SINGLE_RUN);
    owner.record("A", runs(), after(-600));
    owner.record("A", runs(), after(-1));
    owner.record("B", mismatched("A"), after(0));
    expect(owner.record("B", mismatched("A"), after(MISMATCH_RACE_S + 1))?.lasted).toBe(true);
  });

  test("a confirmed tick from another Claude Code ends no run this one opened", () => {
    const owner = new MismatchRuns(SINGLE_RUN);
    owner.record("A", mismatched("B"), after(0));
    owner.record("C", runs(OTHER_CLAUDE), after(1));
    owner.record("A", mismatched("B"), after(MISMATCH_RACE_S + 1));
    expect(owner.lasted("A", PANE_CLAUDE)).toBe(true);
  });

  test("a tick no readable Claude Code ran is in no run and leaves every run as it was", () => {
    const owner = new MismatchRuns(SINGLE_RUN);
    owner.record("A", mismatched("B"), after(0));
    expect(owner.record("A", shell, after(1))).toBeNull();
    owner.record("A", mismatched("B"), after(MISMATCH_RACE_S + 1));
    expect(owner.lasted("A", PANE_CLAUDE)).toBe(true);
  });

  test("two Claude Codes' runs of one session are each their own", () => {
    const owner = new MismatchRuns(SINGLE_RUN);
    for (let s = 0; s <= MISMATCH_RACE_S + 2; s += 2) {
      owner.record("A", mismatched("B"), after(s));
      owner.record("A", mismatched("D", OTHER_CLAUDE), after(s + 1));
    }
    expect(owner.lasted("A", PANE_CLAUDE)).toBe(true);
    expect(owner.lasted("A", OTHER_CLAUDE)).toBe(true);
    owner.record("B", runs(), after(20));
    expect(owner.of("A", PANE_CLAUDE)).toBeNull();
    expect(owner.lasted("A", OTHER_CLAUDE)).toBe(true);
  });

  test("refuses a write outside any turn", () => {
    const owner = new MismatchRuns({ inTurn: () => null });
    expect(() => owner.record("A", mismatched("B"), after(0))).toThrow(
      'mismatch runs: a write of "A" outside any turn',
    );
  });

  test("keeps the Claude Codes heard from last, so one that exited is dropped by age", () => {
    const owner = new MismatchRuns(SINGLE_RUN);
    owner.record("first", mismatched("x"), after(0));
    const other = (i: number): ClaudeProcess => ({ pid: 9000 + i, configDir: undefined });
    for (let i = 0; i < MISMATCH_RUNS_KEPT; i++) owner.record(`s${i}`, mismatched("x", other(i)), after(1));
    expect(owner.of("first", PANE_CLAUDE)).toBeNull();
    expect(owner.of("s0", other(0))).not.toBeNull();
    expect(owner.of(`s${MISMATCH_RUNS_KEPT - 1}`, other(MISMATCH_RUNS_KEPT - 1))).not.toBeNull();
  });

  test("the render line says whether there is a run, how long it has run, and whether it lasted", () => {
    expect(mismatchFact(null, after(1))).toBe("-");
    expect(mismatchFact({ since: after(0), lasted: false }, after(1.5))).toBe("1500ms");
    expect(mismatchFact({ since: after(0), lasted: true }, after(11))).toBe("lasted 11000ms");
  });
});

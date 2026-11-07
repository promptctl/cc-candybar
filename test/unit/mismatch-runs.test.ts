// candybar-gather-renderer-76bb.1dh.2d2: a mismatched pane stamp is the
// /clear rewrite race until its session's run of them outlasts it, and only a
// confirmed tick from the same Claude Code, of any session, ends a run.

import {
  MISMATCH_RACE_S,
  MISMATCH_RUNS_KEPT,
  MismatchRuns,
  mismatchFact,
} from "../../src/daemon/mismatch-runs";
import type { ClaudeProcess, SessionPane } from "../../src/daemon/session-pane";
import { SINGLE_RUN } from "../../src/daemon/session-state";
import { instantOf, type Instant } from "../../src/utils/instant";

// [LAW:no-ambient-temporal-coupling] Every instant a case reads is its own:
// seconds after the /clear that rewrote the record.
const CLEARED = instantOf(new Date("2026-11-07T06:00:00Z"));
const after = (s: number): Instant => (CLEARED + s) as Instant;

const PANE_CLAUDE: ClaudeProcess = { pid: 4242, configDir: undefined };
const OTHER_CLAUDE: ClaudeProcess = { pid: 5151, configDir: undefined };

// A tick from `claude`, whose record holds `held` when it is not the session's.
const mismatched = (held: string, claude = PANE_CLAUDE): SessionPane => ({
  kind: "mismatched",
  tmux: null,
  claude,
  why: `the Claude Code that ran its statusline (pid ${claude.pid}) holds session ${held}`,
});
const runs = (claude = PANE_CLAUDE): SessionPane => ({ kind: "runs", tmux: null, claude });
const shell: SessionPane = { kind: "unconfirmed", tmux: null, why: "its parent keeps no record" };

describe("a session's run of mismatched stamps", () => {
  test("a cleared session's stragglers inside the race open a run that has not lasted", () => {
    const owner = new MismatchRuns(SINGLE_RUN);
    owner.record("A", mismatched("B"), after(1));
    expect(owner.record("A", mismatched("B"), after(MISMATCH_RACE_S))).toEqual({
      claude: PANE_CLAUDE,
      since: after(1),
      lasted: false,
    });
    expect(owner.lasted("A")).toBe(false);
  });

  test("a mismatched tick past the race after the run opened marks it lasted, however far apart its ticks", () => {
    const owner = new MismatchRuns(SINGLE_RUN);
    owner.record("B", mismatched("A"), after(0));
    owner.record("B", mismatched("A"), after(MISMATCH_RACE_S + 1));
    expect(owner.lasted("B")).toBe(true);
    // A Claude Code with no refresh interval ticks only on events.
    expect(owner.record("B", mismatched("A"), after(3600))).toEqual({ claude: PANE_CLAUDE, since: after(0), lasted: true });
    expect(owner.lasted("B")).toBe(true);
  });

  test("the new session's confirmed tick ends the cleared session's run, so its resume's forerunner opens a fresh one", () => {
    const owner = new MismatchRuns(SINGLE_RUN);
    owner.record("A", mismatched("B"), after(1));
    owner.record("B", runs(), after(2));
    expect(owner.of("A")).toBeNull();
    // An hour on, `/resume A` in the same Claude Code: its first tick beats
    // the record's rewrite, inside its own race.
    expect(owner.record("A", mismatched("B"), after(3600))).toEqual({ claude: PANE_CLAUDE, since: after(3600), lasted: false });
  });

  test("a confirmed tick from another Claude Code ends no run this one opened", () => {
    const owner = new MismatchRuns(SINGLE_RUN);
    owner.record("A", mismatched("B"), after(0));
    owner.record("C", runs(OTHER_CLAUDE), after(1));
    owner.record("A", mismatched("B"), after(MISMATCH_RACE_S + 1));
    expect(owner.lasted("A")).toBe(true);
  });

  test("a run another Claude Code's ticks show opens afresh", () => {
    const owner = new MismatchRuns(SINGLE_RUN);
    owner.record("A", mismatched("B"), after(0));
    expect(owner.record("A", mismatched("D", OTHER_CLAUDE), after(MISMATCH_RACE_S + 1))).toEqual({
      claude: OTHER_CLAUDE,
      since: after(MISMATCH_RACE_S + 1),
      lasted: false,
    });
  });

  test("a tick no readable Claude Code ran leaves every run as it was", () => {
    const owner = new MismatchRuns(SINGLE_RUN);
    owner.record("A", mismatched("B"), after(0));
    expect(owner.record("A", shell, after(1))).toEqual({ claude: PANE_CLAUDE, since: after(0), lasted: false });
    expect(owner.record("B", shell, after(1))).toBeNull();
    owner.record("A", mismatched("B"), after(MISMATCH_RACE_S + 1));
    expect(owner.lasted("A")).toBe(true);
  });

  test("refuses a write outside any turn", () => {
    const owner = new MismatchRuns({ inTurn: () => null });
    expect(() => owner.record("A", mismatched("B"), after(0))).toThrow(
      'mismatch runs: a write of "A" outside any turn',
    );
  });

  test("keeps the newest runs, so one whose Claude Code exited unconfirmed is dropped by age", () => {
    const owner = new MismatchRuns(SINGLE_RUN);
    owner.record("first", mismatched("x"), after(0));
    for (let i = 0; i < MISMATCH_RUNS_KEPT; i++) owner.record(`s${i}`, mismatched("x", { pid: 9000 + i, configDir: undefined }), after(1));
    expect(owner.of("first")).toBeNull();
    expect(owner.of("s0")).not.toBeNull();
    expect(owner.of(`s${MISMATCH_RUNS_KEPT - 1}`)).not.toBeNull();
  });

  test("the render line says whether there is a run, since when, and whether it lasted", () => {
    expect(mismatchFact(null)).toBe("-");
    expect(mismatchFact({ claude: PANE_CLAUDE, since: after(0), lasted: false })).toBe("since 2026-11-07T06:00:00.000Z");
    expect(mismatchFact({ claude: PANE_CLAUDE, since: after(0), lasted: true })).toBe("lasted since 2026-11-07T06:00:00.000Z");
  });
});

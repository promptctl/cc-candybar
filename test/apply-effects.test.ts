import { MAIN_NAME } from "../src/daemon/home";
// A click's launches are effects (src/daemon/apply.ts): the click's turn
// describes them, the click answers once the turn has committed, the performer
// runs them after it in the order described, and each outcome comes back
// through Apply as an effect-done event, whose arm holds a failure for the
// session's bar. The store's refusal of a write outside a turn is proven to
// bite here, beside the path it guards: every rig here writes the store its
// clicks' turns hold.

import {
  VERB_APPLY_UPDATE,
  VERB_COPY,
  VERB_COPY_DIAGNOSTIC,
  effectsUrl,
  encodeSegments,
} from "../src/click/wire";
import {
  CLICK_ERROR_HOLD_S,
  clickErrors,
  clickErrorsAt,
  holdClickError,
  lastClickError,
} from "../src/daemon/click-error";
import { JournalTurns } from "../src/daemon/journal-turns";
import { SessionState, SINGLE_RUN } from "../src/daemon/session-state";
import { BadVerbArgs, type VerbContext } from "../src/daemon/verbs";
import { exits, program, readsStdin, runsFor } from "../src/proc/spawner-fake";
import { instantOf } from "../src/utils/instant";
import { systemTimekeeper, type Timekeeper } from "../src/time";
import { applyUnanswered } from "../src/daemon/apply";
import { applyClick, applyClickAnswered, clickUrl, testVerbContext } from "./helpers/click";
import { fakeLauncher, turns } from "./helpers/fake-launcher";
import { heldClock } from "./helpers/held-clock";

const SID = "s1";
const PBCOPY = "/usr/bin/pbcopy";
const AT = new Date("2026-11-05T12:00:00Z");

// On the machine's clock unless a case holds one to keep a program running.
function rig(clock: Timekeeper = systemTimekeeper) {
  const { launcher, spawner, started } = fakeLauncher(clock);
  const journalTurns = new JournalTurns();
  const sessionState = new SessionState(journalTurns);
  const logged: string[] = [];
  const warned: string[] = [];
  const ctx: VerbContext = {
    ...testVerbContext(sessionState, undefined, undefined, undefined, journalTurns),
    launcher,
    log: (level, line) => {
      logged.push(line);
      if (level === "warn") warned.push(line);
    },
    now: () => instantOf(new Date(clock.now())),
    diagnosticCopy: (sid, by, key) =>
      sid === SID && by === "request" && key === "k" ? "the diagnostic" : undefined,
  };
  const applyLines = () => logged.filter((l) => l.startsWith("apply "));
  return { spawner, started, sessionState, ctx, applyLines, warned };
}

const COPY = `cc-candybar://to/main/${VERB_COPY}/${encodeSegments([SID, "hello"])}`;
const COPY_DIAGNOSTIC = `cc-candybar://to/main/${VERB_COPY_DIAGNOSTIC}/${encodeSegments([SID, "request", "k"])}`;

describe("a copy click's launch is an effect", () => {
  test("the click answers while pbcopy still runs; the text reaches its stdin; the apply lines name the effect and its outcome", async () => {
    const clock = heldClock(AT);
    const r = rig(clock);
    // pbcopy takes a moment of the held clock to exit.
    r.spawner.program(program(PBCOPY), runsFor(50, { ...readsStdin("until-end"), runsFor: 50 }));
    const { performed } = await applyClick(COPY, r.ctx);
    let reported = false;
    void performed.then(() => (reported = true));
    await turns();
    expect(r.started().map((s) => s.bin)).toEqual([PBCOPY]);
    expect(r.started()[0]!.ended).toBeNull();
    expect(reported).toBe(false);
    expect(r.applyLines()).toEqual([
      "apply kind=click verb=copy-text sid=s1 outcome=ok effects=launch:pbcopy revision=0",
    ]);
    clock.advance(50);
    await turns();
    await performed;
    expect(r.started()[0]!.stdin).toBe("hello");
    expect(r.applyLines()).toEqual([
      "apply kind=click verb=copy-text sid=s1 outcome=ok effects=launch:pbcopy revision=0",
      expect.stringMatching(
        /^apply kind=effect-done verb=copy-text sid=s1 effect=launch:pbcopy outcome=ok said=- effects=- revision=\d+$/,
      ),
    ]);
  });

  test.each([
    [VERB_COPY, COPY],
    [VERB_COPY_DIAGNOSTIC, COPY_DIAGNOSTIC],
  ])("pbcopy exiting 1 under %s holds the click error for the session, as the next frame reads it", async (verb, url) => {
    const r = rig();
    r.spawner.program(program(PBCOPY), exits(1, "", "pbcopy: no pasteboard"));
    await clickUrl(url, r.ctx);
    const text = lastClickError(r.sessionState, SID)?.text;
    expect(text).toMatch(/^pbcopy failed \(.*no pasteboard\)$/);
    // The draw reads the hold at its own instant (src/daemon/draw-bar.ts).
    expect(clickErrorsAt(r.sessionState, SID, instantOf(new Date()), "request")).toMatchObject([
      { hold: "held", error: { text } },
    ]);
    expect(r.applyLines()[1]).toMatch(
      new RegExp(`^apply kind=effect-done verb=${verb} sid=s1 effect=launch:pbcopy outcome=failed said="pbcopy failed \\(.*no pasteboard\\)" effects=- revision=\\d+$`),
    );
    // The bar shows it, and the log still says it as a warning.
    expect(r.warned).toEqual([r.applyLines()[1]]);
  });

  // A link drawn when copy carried only its text spelled the verb `copy`. Its
  // text, a session id under ⎘ id, is never read as the click's session.
  test.each([["hello"], [SID]])("a copy link drawn before copies named their session is an unknown verb naming no session (text %s)", async (text) => {
    const r = rig();
    // Spelled as the minter spelled it, since it mints no verb it lacks.
    const old = `cc-candybar://to/main/dispatch/does=copy&e=${encodeURIComponent(`copy/${encodeURIComponent(text)}`)}`;
    await expect(clickUrl(old, r.ctx)).rejects.toThrow("copy");
    expect(r.started()).toEqual([]);
    expect(r.applyLines()).toEqual([
      expect.stringMatching(/^apply kind=click verb=dispatch sid=- outcome=refused /),
    ]);
    expect(lastClickError(r.sessionState, SID)).toBeNull();
  });

  test("a dispatch whose one step is refused still performs what its landed step described, and answers the refusal", async () => {
    // [LAW:effects-at-boundaries] The effects go where the writes went: the
    // fold holds the refused step on the bar and commits the rest, so the
    // landed step's launch runs, where dropping it would be a copy the user
    // believes happened.
    const r = rig();
    r.spawner.program(program(PBCOPY), exits(0));
    const url = effectsUrl(MAIN_NAME, [
      { verb: VERB_COPY_DIAGNOSTIC, args: [SID, "request", "missing"] },
      { verb: VERB_COPY_DIAGNOSTIC, args: [SID, "request", "k"] },
    ]);
    const { answer, performed } = await applyClickAnswered(url, r.ctx);
    expect(answer?.error).toBeInstanceOf(BadVerbArgs);
    expect(lastClickError(r.sessionState, SID)?.text).toMatch(/^copy-diagnostic: /);
    await performed;
    expect(r.started().map((s) => [s.bin, s.stdin])).toEqual([[PBCOPY, "the diagnostic"]]);
    expect(r.applyLines()).toEqual([
      expect.stringMatching(/^apply kind=click verb=dispatch sid=s1 outcome=refused said="dispatch: copy-diagnostic: [^"]*" effects=launch:pbcopy revision=\d+$/),
      expect.stringMatching(/^apply kind=effect-done verb=dispatch sid=s1 effect=launch:pbcopy outcome=ok /),
    ]);
  });
});

describe("a click's failures", () => {
  // [LAW:behavior-not-structure] Read as the draw reads them: each record's
  // hold at a render's instant, for whom it draws.
  test("a dispatch's refused step and its landed step's failed launch are two failures, each held from its own instant, and one answer that carried both marks both", async () => {
    const clock = heldClock(AT);
    const r = rig(clock);
    const LAUNCH_MS = 2000;
    r.spawner.program(
      program(PBCOPY),
      runsFor(LAUNCH_MS, exits(1, "", "pbcopy: no pasteboard")),
    );
    const url = effectsUrl(MAIN_NAME, [
      { verb: VERB_COPY_DIAGNOSTIC, args: [SID, "request", "missing"] },
      { verb: VERB_COPY_DIAGNOSTIC, args: [SID, "request", "k"] },
    ]);
    const { answer, performed } = await applyClickAnswered(url, r.ctx);
    expect(answer?.error).toBeInstanceOf(BadVerbArgs);
    await turns();
    clock.advance(LAUNCH_MS);
    await turns();
    await performed;

    const after = (ms: number) => instantOf(new Date(AT.getTime() + ms));
    const [refused, failed] = clickErrors(r.sessionState, SID);
    expect(refused).toMatchObject({ text: expect.stringMatching(/^copy-diagnostic: /), at: after(0) });
    expect(failed).toMatchObject({ text: expect.stringMatching(/^pbcopy failed \(.*no pasteboard\)$/), at: after(LAUNCH_MS) });
    const holds = (ms: number, by: "feed" | "request") =>
      clickErrorsAt(r.sessionState, SID, after(ms), by).map(({ error, hold }) => [error.text, hold]);
    const HOLD_MS = CLICK_ERROR_HOLD_S * 1000;
    // The launch's failure landing did not replace the refusal, nor restart its hold.
    expect(holds(LAUNCH_MS, "feed")).toEqual([
      [refused!.text, "held"],
      [failed!.text, "held"],
    ]);
    expect(holds(HOLD_MS, "feed")).toEqual([
      [refused!.text, "over"],
      [failed!.text, "held"],
    ]);
    // Past both holds, a request is owed both until an answer has carried them.
    expect(holds(HOLD_MS + LAUNCH_MS, "request")).toEqual([
      [refused!.text, "owed"],
      [failed!.text, "owed"],
    ]);
    const { arrival: _arrival, described: _described, ...verbCtx } = r.ctx;
    await applyUnanswered(
      { kind: "answered", session: SID, errors: [refused!, failed!] },
      { verbCtx, log: r.ctx.log },
      "test",
    );
    expect(holds(HOLD_MS + LAUNCH_MS, "request")).toEqual([
      [refused!.text, "over"],
      [failed!.text, "over"],
    ]);
  });
});

describe("a session's effects run in the order their turns committed", () => {
  test("the second click's act starts once the first's has reported; another session's waits on neither", async () => {
    // [LAW:no-ambient-temporal-coupling] A performer that reads before it acts
    // must see what the session's earlier effects left, so one session's
    // effects run one at a time, after each other's report; another session's
    // run beside them. The update's act is the effect here: it is a function
    // the test holds, where a launch would meet the launcher's rate window.
    const r = rig();
    let release = (): void => {};
    const parked = new Promise<void>((resolve) => (release = resolve));
    const acts: string[] = [];
    let n = 0;
    const ctx: VerbContext = {
      ...r.ctx,
      applyUpdate: async () => {
        const call = ++n;
        acts.push(`start ${call}`);
        if (call === 1) await parked;
        acts.push(`end ${call}`);
      },
    };
    const update = (sid: string) =>
      applyClick(`cc-candybar://to/main/${VERB_APPLY_UPDATE}/${encodeURIComponent(sid)}`, ctx);
    const first = await update(SID);
    const second = await update(SID);
    const other = await update("s2");
    await other.performed;
    await turns();
    // s2's act ran beside s1's parked one; s1's second has not started.
    expect(acts).toEqual(["start 1", "start 2", "end 2"]);
    const reported = () =>
      r
        .applyLines()
        .filter((l) => l.includes("kind=effect-done"))
        .map((l) => / sid=(\S+) /.exec(l)![1]);
    expect(reported()).toEqual(["s2"]);
    release();
    await first.performed;
    await second.performed;
    expect(acts).toEqual(["start 1", "start 2", "end 2", "end 1", "start 3", "end 3"]);
    expect(reported()).toEqual(["s2", SID, SID]);
  });
});

describe("the store refuses a write outside a turn", () => {
  test("a write from a timer throws and lands nothing; one inside a turn lands", async () => {
    const turns = new JournalTurns();
    const store = new SessionState(turns);
    const fromTimer = await new Promise<unknown>((resolve) =>
      setTimeout(() => {
        try {
          store.setBatch(SID, [{ key: "k", value: "v" }]);
          resolve(null);
        } catch (e) {
          resolve(e);
        }
      }, 0),
    );
    expect(String(fromTimer)).toMatch(/session state: a write of "s1" outside any turn/);
    expect(() => store.clear(SID, "k")).toThrow(/outside any turn/);
    expect(store.get(SID, "k")).toBeNull();
    expect(store.revision(SID)).toBe(0);
    turns.take("test", () => store.set(SID, "k", "v"));
    expect(store.get(SID, "k")).toBe("v");
  });

  test("a write made from a performer, after the click's turn, fails the click path", async () => {
    const r = rig();
    // A performer that writes session state: the write has no turn, so the
    // instrument refuses it and the effect fails with that refusal.
    const ctx: VerbContext = {
      ...r.ctx,
      applyUpdate: async () => {
        ctx.sessionState.set(SID, "slipped", "1");
      },
    };
    await clickUrl(`cc-candybar://to/main/${VERB_APPLY_UPDATE}/${encodeURIComponent(SID)}`, ctx);
    expect(r.sessionState.get(SID, "slipped")).toBeNull();
    expect(lastClickError(r.sessionState, SID)?.text).toMatch(/outside any turn/);
  });
});

describe("the mark a delivered answer makes on the click error", () => {
  test("is a turn's write, applied as an answered event with its own line", async () => {
    const r = rig();
    // The error is held as the effect-done arm holds one: in a turn.
    r.ctx.journalTurns.take("test", () =>
      holdClickError(r.ctx.sessionState, SID, "boom", instantOf(AT)),
    );
    const error = lastClickError(r.sessionState, SID)!;
    expect(error.answered).toBe(false);
    const { arrival: _arrival, described: _described, ...verbCtx } = r.ctx;
    await applyUnanswered({ kind: "answered", session: SID, errors: [error] }, { verbCtx, log: r.ctx.log }, "test");
    expect(lastClickError(r.sessionState, SID)?.answered).toBe(true);
    expect(r.applyLines()).toEqual([
      expect.stringMatching(
        new RegExp(`^apply kind=answered verb=answered sid=${SID} outcome=ok effects=- revision=${r.sessionState.revision(SID)}$`),
      ),
    ]);
  });
});

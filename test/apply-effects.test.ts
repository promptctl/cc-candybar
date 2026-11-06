// A click's launches are effects (src/daemon/apply.ts): the click's turn
// describes them, the click answers once the turn has committed, the performer
// runs them after it in the order described, and each outcome comes back
// through Apply as an effect-done event, whose arm holds a failure for the
// session's bar. The write-outside-turn instrument (test/helpers/writes-in-turn.ts)
// is proven to bite here, beside the path it watches.

import {
  VERB_APPLY_UPDATE,
  VERB_COPY,
  VERB_COPY_DIAGNOSTIC,
  encodeSegments,
} from "../src/click/wire";
import { clickErrorAt, lastClickError } from "../src/daemon/click-error";
import { JournalTurns } from "../src/daemon/journal-turns";
import { SessionState } from "../src/daemon/session-state";
import type { VerbContext } from "../src/daemon/verbs";
import { exits, program, readsStdin, runsFor } from "../src/proc/spawner-fake";
import { instantOf } from "../src/utils/instant";
import { systemTimekeeper, type Timekeeper } from "../src/time";
import { applyClick, clickUrl, testVerbContext } from "./helpers/click";
import { fakeLauncher, turns } from "./helpers/fake-launcher";
import { heldClock } from "./helpers/held-clock";
import { writesInTurn } from "./helpers/writes-in-turn";

const SID = "s1";
const PBCOPY = "/usr/bin/pbcopy";
const AT = new Date("2026-11-05T12:00:00Z");

// On the machine's clock unless a case holds one to keep a program running.
function rig(clock: Timekeeper = systemTimekeeper) {
  const { launcher, spawner, started } = fakeLauncher(clock);
  const sessionState = new SessionState();
  const logged: string[] = [];
  const ctx: VerbContext = {
    ...testVerbContext(sessionState),
    launcher,
    log: (_level, line) => logged.push(line),
    now: () => instantOf(new Date(clock.now())),
    diagnosticCopy: (sid, by, key) =>
      sid === SID && by === "request" && key === "k" ? "the diagnostic" : undefined,
  };
  const applyLines = () => logged.filter((l) => l.startsWith("apply "));
  return { spawner, started, sessionState, ctx, applyLines };
}

const COPY = `cc-candybar://${VERB_COPY}/${encodeURIComponent("hello")}`;
const COPY_DIAGNOSTIC = `cc-candybar://${VERB_COPY_DIAGNOSTIC}/${encodeSegments([SID, "request", "k"])}`;

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
      "apply kind=click verb=copy sid=- effects=launch:pbcopy revision=-",
    ]);
    clock.advance(50);
    await turns();
    await performed;
    expect(r.started()[0]!.stdin).toBe("hello");
    expect(r.applyLines()).toEqual([
      "apply kind=click verb=copy sid=- effects=launch:pbcopy revision=-",
      expect.stringMatching(
        /^apply kind=effect-done verb=copy sid=- effect=launch:pbcopy outcome=ok said=- turnWait=\d+ms effects=- revision=-$/,
      ),
    ]);
  });

  test("pbcopy exiting 1 holds the click error for the session, as the next frame reads it", async () => {
    const r = rig();
    r.spawner.program(program(PBCOPY), exits(1, "", "pbcopy: no pasteboard"));
    await clickUrl(COPY_DIAGNOSTIC, r.ctx);
    const text = lastClickError(r.sessionState, SID)?.text;
    expect(text).toMatch(/^pbcopy failed \(.*no pasteboard\)$/);
    // The draw reads the hold at its own instant (src/daemon/draw-bar.ts).
    expect(clickErrorAt(r.sessionState, SID, instantOf(new Date()), "request")).toMatchObject({
      kind: "held",
      error: { text },
    });
    expect(r.applyLines()[1]).toMatch(
      /^apply kind=effect-done verb=copy-diagnostic sid=s1 effect=launch:pbcopy outcome=failed said="pbcopy failed \(.*no pasteboard\)" turnWait=\d+ms effects=- revision=\d+$/,
    );
  });

  test("a click that names no session leaves a failed effect in the log alone", async () => {
    const r = rig();
    r.spawner.program(program(PBCOPY), exits(1));
    await clickUrl(COPY, r.ctx);
    expect(r.applyLines()[1]).toContain(" outcome=failed ");
    expect(lastClickError(r.sessionState, SID)).toBeNull();
  });
});

describe("the write-outside-turn instrument", () => {
  test("a write with no turn held throws; one inside a turn lands", async () => {
    const store = new SessionState();
    const turns = new JournalTurns({
      log: () => {},
      monotonic: () => systemTimekeeper.monotonic(),
    });
    const watched = writesInTurn(store, turns);
    expect(() => watched.set(SID, "k", "v")).toThrow(/outside any journal turn: set k/);
    expect(() => watched.setBatch(SID, [{ key: "k", value: "v" }])).toThrow(/setBatch k/);
    expect(() => watched.clear(SID, "k")).toThrow(/clear k/);
    expect(store.get(SID, "k")).toBeNull();
    await turns.take(
      "test",
      { waited: () => {}, gone: () => false },
      async () => {
        watched.set(SID, "k", "v");
      },
    );
    expect(watched.get(SID, "k")).toBe("v");
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
    await clickUrl(`cc-candybar://${VERB_APPLY_UPDATE}/${encodeURIComponent(SID)}`, ctx);
    expect(r.sessionState.get(SID, "slipped")).toBeNull();
    expect(lastClickError(r.sessionState, SID)?.text).toMatch(/outside any journal turn: set slipped/);
  });
});

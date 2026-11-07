// A session's drawn bar carries its session-pane ⚠ (src/daemon/session-pane.ts)
// through the draw a request takes: the checkpoint stamps the request from
// its Claude Code's record on the disk, the request arm records its session's
// run of mismatched stamps in its turn, and the daemon's draw lists the ⚠
// from the stamp and the run it looks up. A lookup under another key than
// the arm's, or a list that drops the entry, fails here and nowhere below.
//
// The draw is the daemon's, composed in this worker (test/helpers/daemon-draw.ts).
//
// [LAW:behavior-not-structure] The cases read the list each draw built.

import { MISMATCH_RACE_S } from "../src/daemon/mismatch-runs";
import type { DiagnosticList } from "../src/render/diagnostics";
import { daemonDraw } from "./helpers/daemon-draw";

const SID = "a0a0a0a0-1111-4222-8333-444444444444";
// The session a `/clear` in SID's Claude Code leaves it holding.
const CLEARED = "b0b0b0b0-1111-4222-8333-444444444444";
// A session in the same pane whose client no Claude Code ran.
const OTHER = "c0c0c0c0-1111-4222-8333-444444444444";
const PANE = "%7";
// The tmux pane lane switched on: a lane that shows the session its pane's
// Claude Code holds.
const CONFIG = `{
  globals: { experimentalPane: true },
  segments: { mark: { template: 'a pane mark' } },
  root: { h: ['mark'] },
}`;

let cleanups: Array<() => void>;
beforeEach(() => {
  cleanups = [];
});
// Every cleanup runs, so a check that fails one still tears the rig down.
afterEach(() => {
  const failed: unknown[] = [];
  for (const fn of cleanups.reverse()) {
    try {
      fn();
    } catch (error) {
      failed.push(error);
    }
  }
  if (failed.length > 0) throw failed[0];
});

// A daemon whose sessions tick from pane PANE under CONFIG, and whose git ask
// answered.
const paneDraw = () =>
  daemonDraw({
    config: CONFIG,
    pane: PANE,
    gitEnv: { kind: "asked", names: [] },
    cleanup: (fn) => void cleanups.push(fn),
  });

// The session-pane message a draw listed, after its severity's level, or
// undefined while it listed none at any level.
const panePart = (list: DiagnosticList): string | undefined => {
  const entry = list.find((m) => m.about === "session-pane");
  return entry === undefined ? undefined : `${entry.severity.level}: ${entry.message}`;
};
const RACE_MS = MISMATCH_RACE_S * 1000;

test("a tick whose stamp is unconfirmed draws a bar whose list holds the session-pane message", async () => {
  const d = paneDraw();
  // No Claude Code record names pid 4300: the process that ran the client
  // is no Claude Code whose session can be read. The message's wording is
  // test/unit/session-pane.test.ts's; here it names the pane, the process,
  // and the record it looked for.
  const s = await d.opened(SID, 4300);
  const message = panePart(await s.tick());
  expect(message).toMatch(/^error: /);
  expect(message).toContain(`pane ${PANE}`);
  expect(message).toContain("pid 4300");
  expect(message).toContain(d.recordAt(4300));
});

test("a confirmed tick's bar lists no session-pane message", async () => {
  const d = paneDraw();
  d.holds(4301, SID);
  const s = await d.opened(SID, 4301);
  expect(panePart(await s.tick())).toBeUndefined();
  // The lane is on in this daemon: a session no Claude Code ran lists it.
  const other = await d.opened(OTHER, 4304);
  expect(panePart(await other.tick())).toMatch(/^error: .*pid 4304/);
});

test("a mismatch draws no session-pane message until its run has lasted past the race, and draws it then", async () => {
  const d = paneDraw();
  // The pane's Claude Code holds another session, and its ticks of SID go on.
  d.holds(4302, CLEARED);
  const s = await d.opened(SID, 4302);
  d.clock.advance(RACE_MS / 2);
  expect(panePart(await s.tick())).toBeUndefined();
  d.clock.advance(RACE_MS);
  const message = panePart(await s.tick());
  expect(message).toMatch(/^error: /);
  expect(message).toContain(`pane ${PANE}`);
  expect(message).toContain("pid 4302");
  expect(message).toContain(CLEARED);
});

test("a /clear's straggling ticks of the old session draw no session-pane message until a run of their own outlasts the race", async () => {
  const d = paneDraw();
  d.holds(4303, SID);
  const s = await d.opened(SID, 4303);
  // The `/clear`: the record now holds the new session, whose first tick is
  // confirmed, and the old session's ticks land after it.
  d.holds(4303, CLEARED);
  const cleared = await d.opened(CLEARED, 4303);
  expect(panePart(await cleared.tick())).toBeUndefined();
  // Stragglers inside the race of the new session's first tick are the race
  // and open no run, so one landing past it opens a run of its own, and a
  // race measured from the first straggler would have lasted by then.
  d.clock.advance(RACE_MS / 10);
  expect(panePart(await s.tick())).toBeUndefined();
  d.clock.advance((RACE_MS * 8) / 10);
  expect(panePart(await s.tick())).toBeUndefined();
  d.clock.advance((RACE_MS * 3) / 10);
  expect(panePart(await s.tick())).toBeUndefined();
  // Ticks of the old session that go on past the race of their own run are
  // a pane that never follows it.
  d.clock.advance(RACE_MS + RACE_MS / 10);
  expect(panePart(await s.tick())).toMatch(new RegExp(`^error: .*${CLEARED}`));
});

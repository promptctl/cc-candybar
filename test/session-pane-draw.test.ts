// A session's drawn bar carries its session-pane ⚠ (src/daemon/session-pane.ts)
// through the draw a request takes: the checkpoint stamps the request from
// its Claude Code's record on the disk, the request arm records its session's
// run of mismatched stamps in its turn, and the daemon's draw lists the ⚠
// from the stamp and the run it looks up. A lookup under another key than
// the arm's, or a list that drops the entry, fails here and nowhere below.
//
// The draw's parts are the daemon's (test/helpers/daemon-parts.ts), built in
// this worker on a held clock, because the boot
// ratchet admits no new booting case (.claude/memory/testing.md), and each
// tick is the daemon's reply to a render request (src/daemon/reply.ts). The list a
// draw built is read from the session's recording, which carries the list the
// door's indicator counts and its viewer pages.
//
// [LAW:behavior-not-structure] The cases read the list each draw built.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { MISMATCH_RACE_S } from "../src/daemon/mismatch-runs";
import { PROTOCOL_VERSION, type ClientHints } from "../src/daemon/protocol";
import { replyTo } from "../src/daemon/reply";
import { sessionIdOf } from "../src/daemon/session-id";
import type { RecordingLine } from "../src/facts/recording";
import type { DiagnosticList } from "../src/render/diagnostics";
import { CLAUDE_START, claudeHolds } from "./helpers/claude-record";
import { configFlag, renderBody } from "./helpers/daemon-e2e";
import { daemonParts } from "./helpers/daemon-parts";
import { heldClock } from "./helpers/held-clock";
import { hostOf } from "./helpers/host";

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
  if (failed.length === 1) throw failed[0];
  if (failed.length > 1) throw new AggregateError(failed, `${failed.length} cleanups failed`);
});

// The daemon's request path over a home of its own: the checkpoint that
// stamps a request's pane from the Claude Code records under the home, the
// request arm over the real journal turns, and the daemon's draw over the
// daemon's parts (test/helpers/daemon-parts.ts).
function daemonDraw() {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ccb-pane-draw-")));
  cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
  const claudeConfigDir = path.join(home, "claude");
  const configFile = path.join(home, "pane.json5");
  fs.writeFileSync(configFile, CONFIG);
  const clock = heldClock(new Date(1_700_000_000_000));
  const said: string[] = [];
  // [LAW:no-silent-failure] An error the daemon only logs fails the case:
  // checked at every tick, and once more after the last, before teardown.
  const unlogged = (): void => {
    const errors = said.filter((line) => line.startsWith("error "));
    if (errors.length > 0) throw new Error(`the daemon logged errors:\n${errors.join("\n")}`);
  };
  // No program is scripted: a source that launches one draws its failure,
  // which is no session-pane ⚠.
  const { parts, close } = daemonParts({
    host: hostOf({}, { home, tmp: home }),
    clock,
    log: (level, message) => void said.push(`${level} ${message}`),
  });
  const { recorder } = parts;
  // Pushed ahead of the teardown, so it runs after it and reads what the
  // close logged too.
  cleanups.push(unlogged);
  cleanups.push(close);

  // The client hints of a tick run in tmux pane PANE by the process `pid`,
  // started when the stand-in Claude Code's record says.
  const hintsOf = (pid: number): ClientHints => ({
    termCols: 120,
    tmux: { socket: path.join(home, "tmux.sock"), pane: PANE, truecolor: null },
    parent: { pid, startTime: CLAUDE_START },
    claudeConfigDir,
  });
  // One statusline tick of `sid` from the process `pid`, as the daemon
  // replies to it: through the checkpoint, the arm's turn, and the draw, at
  // the clock's instant. Its client's deadline is that instant, so it leaves
  // no time to wait on its sources and the held clock never has to move.
  const tick = async (sid: string, pid: number): Promise<void> => {
    const { resp } = await replyTo(
      parts,
      {
        v: PROTOCOL_VERSION,
        kind: "render",
        encoding: "frame",
        deadline: clock.now(),
        ...renderBody(sid, home, hintsOf(pid), configFlag(configFile)),
      } as unknown as Parameters<typeof replyTo>[1],
      () => false,
      clock.monotonic(),
      () => false,
    );
    if (!resp.ok) throw new Error(`the tick drew no bar: ${JSON.stringify(resp)}`);
    unlogged();
  };
  // A session whose first tick from `pid` opened its view, recorded from
  // there on: each later tick returns the list its draw built.
  const opened = async (sid: string, pid: number) => {
    await tick(sid, pid);
    const written: RecordingLine[] = [];
    const stop = recorder.record(sessionIdOf(sid), {
      write: (line) => void written.push(line),
      end: () => {},
    });
    cleanups.push(stop);
    return {
      tick: async (): Promise<DiagnosticList> => {
        const before = written.length;
        await tick(sid, pid);
        const draws = written.slice(before).flatMap((line) => (line.kind === "draw" ? [line] : []));
        if (draws.length !== 1) throw new Error(`the tick drew ${draws.length} recorded answers`);
        return draws[0]!.diagnostics;
      },
    };
  };
  return {
    clock,
    opened,
    // The stand-in Claude Code at `pid` holds `sid` now: a `/clear` when
    // written again.
    holds: (pid: number, sid: string) => claudeHolds(claudeConfigDir, pid, sid),
    recordAt: (pid: number) => path.join(claudeConfigDir, "sessions", `${pid}.json`),
  };
}

// The session-pane message a draw listed, after its severity's level, or
// undefined while it listed none at any level.
const panePart = (list: DiagnosticList): string | undefined => {
  const entry = list.find((m) => m.about === "session-pane");
  return entry === undefined ? undefined : `${entry.severity.level}: ${entry.message}`;
};
const RACE_MS = MISMATCH_RACE_S * 1000;

test("a tick whose stamp is unconfirmed draws a bar whose list holds the session-pane message", async () => {
  const d = daemonDraw();
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
  const d = daemonDraw();
  d.holds(4301, SID);
  const s = await d.opened(SID, 4301);
  expect(panePart(await s.tick())).toBeUndefined();
  // The lane is on in this daemon: a session no Claude Code ran lists it.
  const other = await d.opened(OTHER, 4304);
  expect(panePart(await other.tick())).toMatch(/^error: .*pid 4304/);
});

test("a mismatch draws no session-pane message until its run has lasted past the race, and draws it then", async () => {
  const d = daemonDraw();
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
  const d = daemonDraw();
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

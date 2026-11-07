// A daemon whose boot could not ask git which variables locate a repository
// keeps the spawning shell's environment for its git reads (src/git-env.ts),
// and every bar it draws says so: the ask's outcome goes into the daemon as an
// input, and the draw lists its warning in the list the door's ⚠ counts.
//
// The draw's parts are the daemon's (test/helpers/daemon-parts.ts), built in
// this worker on a held clock, and each tick is the daemon's reply to a render
// request (src/daemon/reply.ts). The list a draw built is read from the
// session's recording.
//
// [LAW:behavior-not-structure] The cases read the list each draw built.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { PROTOCOL_VERSION } from "../src/daemon/protocol";
import { replyTo } from "../src/daemon/reply";
import { sessionIdOf } from "../src/daemon/session-id";
import type { RecordingLine } from "../src/facts/recording";
import type { GitEnvAsk } from "../src/git-env";
import type { DiagnosticList } from "../src/render/diagnostics";
import { configFlag, renderBody } from "./helpers/daemon-e2e";
import { daemonParts } from "./helpers/daemon-parts";
import { heldClock } from "./helpers/held-clock";
import { hostOf } from "./helpers/host";

const SID = "a0a0a0a0-1111-4222-8333-444444444444";
const CONFIG = `{
  segments: { mark: { template: 'a mark' } },
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

// The list the second draw of a session built, in a daemon whose git ask
// came back as `gitEnv`: the first tick opens the session's view, and the
// second is recorded.
async function drawnWith(gitEnv: GitEnvAsk): Promise<DiagnosticList> {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ccb-git-env-draw-")));
  cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
  const configFile = path.join(home, "git-env.json5");
  fs.writeFileSync(configFile, CONFIG);
  const clock = heldClock(new Date(1_700_000_000_000));
  const said: string[] = [];
  const { parts, close } = daemonParts({
    host: hostOf({}, { home, tmp: home }),
    clock,
    log: (level, message) => void said.push(`${level} ${message}`),
    gitEnv,
  });
  // [LAW:no-silent-failure] An error the daemon only logs fails the case.
  // Pushed ahead of the teardown, so it runs after it and reads what the close
  // logged too.
  cleanups.push(() => {
    const errors = said.filter((line) => line.startsWith("error "));
    if (errors.length > 0) throw new Error(`the daemon logged errors:\n${errors.join("\n")}`);
  });
  cleanups.push(close);
  // One statusline tick, at the clock's instant, with no time to wait on its
  // sources.
  const tick = async (): Promise<void> => {
    const { resp } = await replyTo(
      parts,
      {
        v: PROTOCOL_VERSION,
        kind: "render",
        encoding: "frame",
        deadline: clock.now(),
        ...renderBody(SID, home, { termCols: 120 }, configFlag(configFile)),
      } as unknown as Parameters<typeof replyTo>[1],
      () => false,
      clock.monotonic(),
      () => false,
    );
    if (!resp.ok) throw new Error(`the tick drew no bar: ${JSON.stringify(resp)}`);
  };
  await tick();
  const written: RecordingLine[] = [];
  cleanups.push(
    parts.recorder.record(sessionIdOf(SID), {
      write: (line) => void written.push(line),
      end: () => {},
    }),
  );
  await tick();
  const draws = written.flatMap((line) => (line.kind === "draw" ? [line] : []));
  if (draws.length !== 1) throw new Error(`the tick drew ${draws.length} recorded answers`);
  return draws[0]!.diagnostics;
}

// The git-env message a draw listed, after its severity's level, or undefined
// while it listed none.
const gitEnvPart = (list: DiagnosticList): string | undefined => {
  const entry = list.find((m) => m.about === "git-env");
  return entry === undefined ? undefined : `${entry.severity.level}: ${entry.message}`;
};

test("a daemon whose git ask failed lists the git-env warning on a session's bar, with why", async () => {
  const list = await drawnWith({ kind: "failed", reason: "killed by SIGKILL" });
  expect(gitEnvPart(list)).toBe(
    "warning: git could not say which variables locate a repository (killed by SIGKILL), so git reads use the environment of the shell that started this daemon, and may show another repository's branch; the daemon asks again when it next starts",
  );
});

test("a daemon whose git ask answered lists no git-env warning", async () => {
  const list = await drawnWith({ kind: "asked", names: ["GIT_DIR"] });
  expect(gitEnvPart(list)).toBeUndefined();
});

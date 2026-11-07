// A daemon whose boot could not ask git which variables locate a repository
// keeps the spawning shell's environment for its git reads (src/git-env.ts),
// and every bar it draws says so: the ask's outcome goes into the daemon as an
// input, and the draw lists its warning in the list the door's ⚠ counts.
//
// [LAW:behavior-not-structure] The cases read the list each draw built.

import type { GitEnvAsk } from "../src/git-env";
import type { DiagnosticList } from "../src/render/diagnostics";
import { daemonDraw } from "./helpers/daemon-draw";

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
  if (failed.length > 0) throw failed[0];
});

const drawnWith = (gitEnv: GitEnvAsk) =>
  daemonDraw({
    config: CONFIG,
    pane: "%7",
    gitEnv,
    cleanup: (fn) => void cleanups.push(fn),
  });

// The git-env message a draw listed, after its severity's level, or undefined
// while it listed none.
const gitEnvPart = (list: DiagnosticList): string | undefined => {
  const entry = list.find((m) => m.about === "git-env");
  return entry === undefined ? undefined : `${entry.severity.level}: ${entry.message}`;
};

test("a daemon whose git ask failed lists the git-env warning on a session's bar, with why", async () => {
  const d = drawnWith({ kind: "failed", reason: "killed by SIGKILL" });
  const s = await d.opened(SID, 4400);
  const message = gitEnvPart(await s.tick());
  expect(message).toBe(
    "warning: git could not say which variables locate a repository (killed by SIGKILL), so git reads use the environment of the shell that started this daemon, and may show another repository's branch; the daemon asks again when it next starts",
  );
});

test("a daemon whose git ask answered lists no git-env warning", async () => {
  const d = drawnWith({ kind: "asked", names: ["GIT_DIR"] });
  const s = await d.opened(SID, 4401);
  expect(gitEnvPart(await s.tick())).toBeUndefined();
});

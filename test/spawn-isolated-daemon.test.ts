// The readiness contract of test/helpers/spawn-isolated-daemon.ts — the one
// spawn+readiness path every daemon-e2e call site shares
// (brandon-ci-flakes-630.c7o).
//
// [LAW:no-ambient-temporal-coupling] These tests assert no elapsed time. The
// bug under repair was a wall-clock deadline standing in for a fact, so a test
// that asserted "the refusal was reported in under N ms" would re-introduce the
// very coupling the fix removes — on a starved machine it would fail for the
// same reason the old budget did. What makes the report fast is structural
// instead: the refusal arm of the message is reachable ONLY by reading the
// child's exit, and the budget-expiry arm is the one that excludes it. Asserting
// which arm spoke is therefore a claim about the mechanism, not about a clock.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { logPath } from "../src/daemon/paths";
import {
  readinessFailure,
  type ReadinessFailure,
} from "./helpers/spawn-isolated-daemon";

const LOG_LINE = "2026-09-12T00:00:00.000Z [error] refusing to boot: nope";
const STDERR_LINE = "Error: died before it had a log";
const SOCK = "/tmp/ccb-x/cc-candybar/socket";

// An env whose logPath() names a real file, so the projection under test reads
// the daemon's own words the way it does in production.
function envWithLog(): NodeJS.ProcessEnv {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-rf-"));
  const env: NodeJS.ProcessEnv = { XDG_STATE_HOME: root };
  const file = logPath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${LOG_LINE}\n`);
  return env;
}

describe("readinessFailure — what the socket did, what our process did", () => {
  let env: NodeJS.ProcessEnv;
  beforeAll(() => {
    env = envWithLog();
  });
  afterAll(() => {
    fs.rmSync(env.XDG_STATE_HOME!, { recursive: true, force: true });
  });

  const message = (readiness: ReadinessFailure): string =>
    readinessFailure(readiness, SOCK, env, STDERR_LINE);

  // The ticket's acceptance criterion: the message itself distinguishes "never
  // booted" from "booted, never served". Not the log tail beneath it — the
  // sentence, so a reader who stops at the first line already knows which half
  // of the boot died.
  test("never booted and booted-but-mute are different sentences", () => {
    const neverBooted = message({ phase: "booting", exit: null });
    const mute = message({ phase: "bound", exit: null });

    expect(neverBooted).toContain(
      `no socket at ${SOCK}, so it never got as far as binding`,
    );
    expect(mute).toContain(
      `it bound ${SOCK} but never answered a stats round trip`,
    );
    expect(neverBooted).not.toContain("never answered a stats round trip");
    expect(mute).not.toContain("never got as far as binding");
  });

  test("a live process at the budget is named a slow boot, not a refusal", () => {
    const m = message({ phase: "booting", exit: null });
    expect(m).toMatch(/still running when the \d+ms budget expired/);
    expect(m).toContain("a slow boot, not a refusal");
    expect(m).not.toContain("the process exited");
  });

  test("an exit is named by code, and a killed process by its signal", () => {
    expect(
      message({ phase: "booting", exit: { code: 1, signal: null } }),
    ).toContain("the process exited (code 1)");
    expect(
      message({ phase: "bound", exit: { code: null, signal: "SIGKILL" } }),
    ).toContain("the process exited (signal SIGKILL)");
  });

  // A daemon logs nothing until it binds, so a process that died before that
  // said why only on stderr.
  test("every combination quotes the daemon's log, named by path, and its stderr", () => {
    const phases = ["booting", "bound"] as const;
    const exits = [null, { code: 1, signal: null }] as const;
    for (const phase of phases) {
      for (const exit of exits) {
        const m = message({ phase, exit });
        expect(m).toContain(logPath(env));
        expect(m).toContain(LOG_LINE);
        expect(m).toContain(`stderr:\n${STDERR_LINE}`);
      }
    }
  });
});

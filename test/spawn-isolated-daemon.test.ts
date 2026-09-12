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

import { RSS_LIMIT_ENV } from "../src/daemon/limits";
import { logPath } from "../src/daemon/paths";
import { waitForExit } from "./helpers/daemon-wire";
import {
  prepareIsolatedDaemonEnv,
  readinessFailure,
  spawnDaemonWithEnv,
  type ReadinessFailure,
} from "./helpers/spawn-isolated-daemon";

const LOG_LINE = "2026-09-12T00:00:00.000Z [error] refusing to boot: nope";
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
    readinessFailure(readiness, SOCK, env);

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

  test("every combination quotes the daemon's own log, named by path", () => {
    const phases = ["booting", "bound"] as const;
    const exits = [null, { code: 1, signal: null }] as const;
    for (const phase of phases) {
      for (const exit of exits) {
        const m = message({ phase, exit });
        expect(m).toContain(logPath(env));
        expect(m).toContain(LOG_LINE);
      }
    }
  });
});

// [LAW:behavior-not-structure] The claim is about the helper driving the real
// binary: a daemon that refuses to boot is reported as a refusal carrying its own
// reason, through the arm that only an observed exit can reach.
test("a daemon that refuses to boot is reported as a refusal, not as a timeout", async () => {
  const iso = prepareIsolatedDaemonEnv("ccb-rdy");
  // A malformed memory budget: the daemon's earliest refusal, before any
  // resource is committed and therefore before any bind
  // (test/daemon-boot-refusal.test.ts pins that ordering on the daemon's side).
  const env = { ...iso.env, [RSS_LIMIT_ENV]: "512MB" };
  try {
    await expect(spawnDaemonWithEnv(env)).rejects.toThrow(
      /the process exited \(code 1\)/,
    );
  } finally {
    iso.removeTmpDirs();
  }
});

test("the refusal report names the phase and quotes the daemon's reason", async () => {
  const iso = prepareIsolatedDaemonEnv("ccb-rdy");
  const env = { ...iso.env, [RSS_LIMIT_ENV]: "512MB" };
  try {
    const failure = await spawnDaemonWithEnv(env).then(
      (d) => {
        d.killTree();
        return new Error("spawnDaemonWithEnv resolved for a refusing daemon");
      },
      (e: Error) => e,
    );
    expect(failure.message).toContain("never got as far as binding");
    expect(failure.message).toMatch(
      /refusing to boot: CC_CANDYBAR_RSS_LIMIT_MB must be a positive integer/,
    );
    // The budget-expiry arm is the one an exit excludes: seeing it here would
    // mean the helper waited the whole budget out to learn what the process had
    // already told it.
    expect(failure.message).not.toContain("budget expired");
  } finally {
    iso.removeTmpDirs();
  }
});

// A PINNED LIMIT, not a wish: readiness is "a daemon answers on this socket",
// never "the daemon this call spawned answers". Spawned against a socket a LIVE
// incumbent owns, the second daemon loses the EADDRINUSE arbitration and exits —
// and this still resolves, because the incumbent answers on the FIRST poll,
// before our own child has compiled far enough to decide anything. That is why
// the helper reads the child's exit only while nothing has answered yet: here an
// exit-based check would be a coin flip on scheduling. Closing it for real needs
// the answering daemon's identity on the wire; until then this test states the
// behaviour, so adding that identity becomes a visible, deliberate change.
test("a spawn against a live incumbent is accepted: the wire carries no identity", async () => {
  const iso = prepareIsolatedDaemonEnv("ccb-rdy2");
  const incumbent = await spawnDaemonWithEnv(iso.env);
  // Reaching the next line IS the claim: this resolves for a daemon that is on
  // its way out, because what answered was the incumbent.
  const loser = await spawnDaemonWithEnv(iso.env);
  try {
    expect(await waitForExit(loser.child)).toEqual({ code: 0, signal: null });
    expect(
      fs.readFileSync(path.join(iso.stateDir, "daemon.log"), "utf8"),
    ).toMatch(/EADDRINUSE: .+ exiting/);
  } finally {
    loser.killTree();
    incumbent.killTree();
    iso.removeTmpDirs();
  }
});

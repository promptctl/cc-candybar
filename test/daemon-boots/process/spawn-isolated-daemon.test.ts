// The readiness contract of scripts/lib/daemon/isolated.ts against real
// exits. The report's wording is held as a value in
// test/spawn-isolated-daemon.test.ts, which says why no case here times anything.

import fs from "node:fs";
import path from "node:path";

import { waitForExit } from "../../../scripts/lib/daemon/wire";
import { type IsolatedDaemonEnv } from "../../../scripts/lib/daemon/isolated";
import { prepareIsolatedDaemonEnv, spawnDaemonWithEnv } from "../../helpers/spawn-isolated-daemon";

// An isolated env whose socket parent is open to its group and world, which the
// daemon refuses before it binds anything
// (test/daemon-boots/process/daemon-boot-refusal.test.ts pins that refusal on
// the daemon's side).
function refusedEnv(): IsolatedDaemonEnv {
  const iso = prepareIsolatedDaemonEnv("ccb-rdy");
  fs.chmodSync(iso.stateDir, 0o755);
  return iso;
}

// [LAW:behavior-not-structure] The claim is about the helper driving the real
// binary: a daemon that refuses to boot is reported as a refusal carrying its own
// reason, through the arm that only an observed exit can reach.
test("a daemon that refuses to boot is reported as a refusal, not as a timeout", async () => {
  const iso = refusedEnv();
  try {
    await expect(spawnDaemonWithEnv(iso.env)).rejects.toThrow(
      /the process exited \(code 1\)/,
    );
  } finally {
    iso.removeTmpDirs();
  }
});

test("the refusal report names the phase and quotes the daemon's reason", async () => {
  const iso = refusedEnv();
  try {
    const failure = await spawnDaemonWithEnv(iso.env).then(
      async (d) => {
        await d.stop();
        return new Error("spawnDaemonWithEnv resolved for a refusing daemon");
      },
      (e: Error) => e,
    );
    expect(failure.message).toContain("never got as far as binding");
    expect(failure.message).toMatch(
      /refusing to boot: Error: directory has unsafe permissions/,
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
    await loser.stop();
    await incumbent.stop();
    iso.removeTmpDirs();
  }
});

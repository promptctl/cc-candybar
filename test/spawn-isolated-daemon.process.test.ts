// The readiness contract of test/helpers/spawn-isolated-daemon.ts against real
// exits. The report's wording is held as a value in
// test/spawn-isolated-daemon.test.ts, which says why no case here times anything.

import fs from "node:fs";
import path from "node:path";

import { RSS_LIMIT_ENV } from "../src/daemon/limits";
import { waitForExit } from "./helpers/daemon-wire";
import { LEDGER_ENV, parseLedger } from "./helpers/process-tier.cjs";
import {
  prepareIsolatedDaemonEnv,
  spawnDaemonWithEnv,
} from "./helpers/spawn-isolated-daemon";

// [LAW:behavior-not-structure] The claim is about the helper driving the real
// binary: a daemon that refuses to boot is reported as a refusal carrying its own
// reason, through the arm that only an observed exit can reach.
test("a daemon that refuses to boot is reported as a refusal, not as a timeout", async () => {
  const iso = prepareIsolatedDaemonEnv("ccb-rdy");
  // A malformed memory budget: the daemon's earliest refusal, before any
  // resource is committed and therefore before any bind
  // (test/daemon-boot-refusal.process.test.ts pins that ordering on the daemon's side).
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
      /refusing to boot: Error: CC_CANDYBAR_RSS_LIMIT_MB must be a positive integer/,
    );
    // The budget-expiry arm is the one an exit excludes: seeing it here would
    // mean the helper waited the whole budget out to learn what the process had
    // already told it.
    expect(failure.message).not.toContain("budget expired");
  } finally {
    iso.removeTmpDirs();
  }
});

// [LAW:no-silent-failure] A dead meter would read as a run that started nothing,
// so the ledger is held to hearing a real one, by the helper's route.
test("a daemon's start is in the run's ledger, under its test file", async () => {
  const iso = prepareIsolatedDaemonEnv("ccb-rdy");
  const env = { ...iso.env, [RSS_LIMIT_ENV]: "512MB" };
  try {
    await expect(spawnDaemonWithEnv(env)).rejects.toThrow();
    expect(parseLedger(fs.readFileSync(process.env[LEDGER_ENV]!, "utf8"))).toContainEqual({
      file: "test/spawn-isolated-daemon.process.test.ts",
      route: "helper",
    });
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

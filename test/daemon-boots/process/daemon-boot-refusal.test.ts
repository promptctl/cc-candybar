import fs from "node:fs";
import path from "node:path";

import { RSS_LIMIT_ENV } from "../../../src/daemon/limits";
import { waitForExit } from "../../helpers/daemon-wire";
import { prepareIsolatedDaemonEnv } from "../../helpers/spawn-isolated-daemon";
import {
  daemonPool,
  HAND_RUN_SOURCE,
  spawnTestDaemon,
} from "../../helpers/spawn-test-daemon";

// [LAW:behavior-not-structure] The claim under test is an ORDERING of the real
// binary's boot: a malformed memory budget is refused through daemon.log before
// any resource is committed. The grammar itself is vector-tested in
// daemon-limits.test.ts; this drives the daemon and reads what it left behind.
test("a malformed budget is refused through daemon.log before any resource is committed", async () => {
  const iso = prepareIsolatedDaemonEnv("ccb-boot");
  const { child, stop } = await spawnTestDaemon(
    { ...iso.env, [RSS_LIMIT_ENV]: "512MB" },
    daemonPool,
    HAND_RUN_SOURCE,
  );
  try {
    const exit = await waitForExit(child);
    expect(exit.code).toBe(1);
    const log = fs.readFileSync(path.join(iso.stateDir, "daemon.log"), "utf8");
    expect(log).toMatch(
      /\[error\] refusing to boot: Error: CC_CANDYBAR_RSS_LIMIT_MB must be a positive integer \(MB\), got "512MB"/,
    );
    expect(log).not.toMatch(/daemon up/);
    expect(fs.existsSync(iso.sockPath)).toBe(false);
  } finally {
    await stop();
    iso.removeTmpDirs();
  }
});

// [LAW:single-enforcer] A throw anywhere in the boot takes the death funnel: it
// lands in index.ts's catch otherwise, whose stderr the detached spawn discards.
test("an unsafe socket parent is refused through daemon.log", async () => {
  const iso = prepareIsolatedDaemonEnv("ccb-boot-parent");
  const parent = path.dirname(iso.sockPath);
  fs.chmodSync(parent, 0o755);
  const { child, stop } = await spawnTestDaemon(iso.env);
  try {
    const exit = await waitForExit(child);
    expect(exit.code).toBe(1);
    const log = fs.readFileSync(path.join(iso.stateDir, "daemon.log"), "utf8");
    expect(log).toMatch(
      /\[error\] refusing to boot: Error: directory has unsafe permissions[^]*\n\s+at /,
    );
    expect(log).not.toMatch(/daemon up/);
  } finally {
    await stop();
    iso.removeTmpDirs();
  }
});

// [LAW:no-silent-failure] A lease that cannot be written leaves the
// predecessor's on disk, so the boot is refused at the write, with its reason,
// rather than serving until the ownership self-check calls it displaced. A
// directory where the lease goes makes the rename over it fail.
test("a lease that cannot be written is refused through daemon.log", async () => {
  const iso = prepareIsolatedDaemonEnv("ccb-boot-lease");
  fs.mkdirSync(`${iso.sockPath}.lease`);
  const { child, stop } = await spawnTestDaemon(iso.env);
  try {
    const exit = await waitForExit(child);
    expect(exit.code).toBe(1);
    const log = fs.readFileSync(path.join(iso.stateDir, "daemon.log"), "utf8");
    expect(log).toMatch(
      /\[error\] refusing to boot: Error: lease write failed: /,
    );
    expect(log).not.toMatch(/daemon up/);
  } finally {
    await stop();
    iso.removeTmpDirs();
  }
});

// [LAW:no-silent-failure] A daemon that cannot read its own start time could
// write no lease or registry entry that tells it from a process reusing its
// pid, so the boot is refused with the reason. An empty PATH leaves it no
// `ps`.
test("a daemon that cannot read its own start time is refused through daemon.log", async () => {
  const iso = prepareIsolatedDaemonEnv("ccb-boot-start");
  const { child, stop } = await spawnTestDaemon({
    ...iso.env,
    PATH: path.join(iso.stateDir, "no-bin"),
  });
  try {
    const exit = await waitForExit(child);
    expect(exit.code).toBe(1);
    const log = fs.readFileSync(path.join(iso.stateDir, "daemon.log"), "utf8");
    expect(log).toMatch(
      /\[error\] refusing to boot: Error: cannot read this process's own start time: /,
    );
    expect(log).not.toMatch(/daemon up/);
  } finally {
    await stop();
    iso.removeTmpDirs();
  }
});

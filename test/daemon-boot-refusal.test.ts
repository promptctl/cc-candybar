import fs from "node:fs";
import path from "node:path";

import { RSS_LIMIT_ENV } from "../src/daemon/limits";
import { waitForExit } from "./helpers/daemon-wire";
import { prepareIsolatedDaemonEnv } from "./helpers/spawn-isolated-daemon";
import { spawnTestDaemon } from "./helpers/spawn-test-daemon";

// [LAW:behavior-not-structure] The claim under test is an ORDERING of the real
// binary's boot: a malformed memory budget is refused through daemon.log before
// any resource is committed. The grammar itself is vector-tested in
// daemon-limits.test.ts; this drives the daemon and reads what it left behind.
test("a malformed budget is refused through daemon.log before any resource is committed", async () => {
  const iso = prepareIsolatedDaemonEnv("ccb-boot");
  const { child, killTree, release } = await spawnTestDaemon({
    ...iso.env,
    [RSS_LIMIT_ENV]: "512MB",
  });
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
    killTree();
    release();
    iso.removeTmpDirs();
  }
});

// [LAW:single-enforcer] A throw anywhere in the boot takes the death funnel: it
// lands in index.ts's catch otherwise, whose stderr the detached spawn discards.
test("an unsafe socket parent is refused through daemon.log", async () => {
  const iso = prepareIsolatedDaemonEnv("ccb-boot-parent");
  const parent = path.dirname(iso.sockPath);
  fs.chmodSync(parent, 0o755);
  const { child, killTree, release } = await spawnTestDaemon(iso.env);
  try {
    const exit = await waitForExit(child);
    expect(exit.code).toBe(1);
    const log = fs.readFileSync(path.join(iso.stateDir, "daemon.log"), "utf8");
    expect(log).toMatch(
      /\[error\] refusing to boot: Error: directory has unsafe permissions[^]*\n\s+at /,
    );
    expect(log).not.toMatch(/daemon up/);
  } finally {
    killTree();
    release();
    iso.removeTmpDirs();
  }
});

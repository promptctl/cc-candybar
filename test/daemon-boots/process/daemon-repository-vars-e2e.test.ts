// A daemon's process asks its git once, as it starts, which variables locate a
// repository, and says in its log what its launches withhold. A git that names
// none is a warning in that log, and the daemon still comes up. Real daemons:
// the ask and the line are the process main's, which no in-worker daemon runs.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { killAndWait } from "../../helpers/daemon-e2e";
import { loggedWhen } from "../../helpers/daemon-log";
import {
  prepareIsolatedDaemonEnv,
  spawnDaemonWithEnv,
  type RunningDaemon,
} from "../../helpers/spawn-isolated-daemon";

jest.setTimeout(30_000);

describe("a daemon's process, as it starts", () => {
  let dir: string;
  let removeTmpDirs: () => void;
  let daemon: RunningDaemon | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-candybar-repo-env-boot-"));
  });

  afterEach(async () => {
    if (daemon) await killAndWait(daemon);
    daemon = undefined;
    removeTmpDirs();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const started = async (extra: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> => {
    const prepared = prepareIsolatedDaemonEnv("cc-candybar-repo-env-boot");
    removeTmpDirs = prepared.removeTmpDirs;
    const env = { ...prepared.env, ...extra };
    daemon = await spawnDaemonWithEnv(env);
    return env;
  };

  test("names what its launches withhold: GH_REPO and what its git names", async () => {
    const env = await started({ GIT_DIR: path.join(dir, ".git"), GH_REPO: "someone/else" });
    await loggedWhen(
      env,
      (lines) =>
        lines.some((l) =>
          /\[info\] launches withhold GH_REPO,(\w+,)*GIT_DIR(,\w+)*$/.test(l),
        ),
      "the daemon's line naming what its launches withhold",
    );
  });

  test("whose git names nothing, warns why, still withholds GH_REPO, and serves", async () => {
    const bin = path.join(dir, "bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "git"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const env = await started({ PATH: `${bin}:${process.env.PATH}` });
    await loggedWhen(
      env,
      (lines) =>
        lines.some((l) => l.endsWith("[info] launches withhold GH_REPO")) &&
        lines.some((l) =>
          l.includes(
            "[warn] git may read the repository this process was started in rather than a session's: `git rev-parse --local-env-vars` named no variable",
          ),
        ),
      "the daemon's lines on a git that named nothing",
    );
  });
});

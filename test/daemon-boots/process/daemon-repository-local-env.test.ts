// [LAW:verifiable-goals] On a REAL daemon spawned from a shell whose GIT_DIR,
// GIT_WORK_TREE and forge repositories name an unrelated repository: its log
// names what its launches withhold, its renderer process starts without them
// while the daemon's own environment keeps them, and a session's branch is
// read from the session's directory. A daemon whose git cannot name its
// repository-local variables says why, and what it means, in its log.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { textOf } from "../../../src/render/frame";
import { render } from "../../helpers/daemon-e2e";
import {
  environmentHas,
  gitRepo,
  pathWithGit,
  realGit,
  SHELL_NAMES,
  shellInside,
} from "../../helpers/repository-local-env";
import {
  prepareIsolatedDaemonEnv,
  spawnDaemonWithEnv,
  type IsolatedDaemonEnv,
  type RunningDaemon,
} from "../../helpers/spawn-isolated-daemon";
import {
  spawnTestDaemon,
  type TestDaemonProcess,
} from "../../helpers/spawn-test-daemon";
import { processProbe } from "../../helpers/host";
import { until } from "../../helpers/until";

jest.setTimeout(30_000);

describe("a daemon spawned inside another repository", () => {
  let dir: string;
  let prepared: IsolatedDaemonEnv;
  let daemon: RunningDaemon | undefined;
  let stalled: TestDaemonProcess | undefined;

  const log = (): string =>
    fs.readFileSync(path.join(prepared.stateDir, "daemon.log"), "utf8");

  // The daemon, spawned from a shell inside `elsewhere`, with `extra` laid
  // over that shell's environment.
  const spawnInside = async (extra: NodeJS.ProcessEnv = {}) => {
    daemon = await spawnDaemonWithEnv({
      ...prepared.env,
      ...shellInside(gitRepo(dir, "elsewhere", "elsewhere")),
      ...extra,
    });
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-candybar-rle-proc-"));
    prepared = prepareIsolatedDaemonEnv("cc-candybar-rlp");
  });

  afterEach(async () => {
    await daemon?.stop();
    daemon = undefined;
    await stalled?.stop();
    stalled = undefined;
    prepared.removeTmpDirs();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("withholds them from what it launches, the renderer included, and reads the session's branch", async () => {
    await spawnInside();
    const mine = gitRepo(dir, "mine", "mine");
    const config = path.join(dir, "bar.json5");
    fs.writeFileSync(
      config,
      `{ segments: { b: { template: 'b:{{ .git.branch }}' } }, root: { h: ['b'] } }`,
    );
    const frame = await render(prepared.sockPath, "rle-proc", mine, {}, [
      "cc-candybar",
      "--config",
      config,
    ]);
    expect(textOf(frame)).toContain("b:mine");

    const withheld = log()
      .match(/launches withhold (\S+)/)?.[1]
      ?.split(",");
    expect(withheld).toEqual(expect.arrayContaining([...SHELL_NAMES]));
    expect(log()).not.toMatch(/could not name its repository-local/);

    await until(
      () => /renderer main\[\d+\] started pid=\d+/.test(log()),
      "the renderer to start",
    );
    const rendererPid = Number(
      log().match(/renderer main\[\d+\] started pid=(\d+)/)![1],
    );
    const daemonPid = Number(log().match(/daemon up: pid=(\d+)/)![1]);
    // The daemon's own environment is as its shell started it.
    expect(environmentHas(daemonPid, SHELL_NAMES)).toEqual(
      SHELL_NAMES.map(() => true),
    );
    expect(environmentHas(rendererPid, SHELL_NAMES)).toEqual(
      SHELL_NAMES.map(() => false),
    );
  });

  // The ask is awaited, not run on a blocked loop: a daemon whose git never
  // answers still hears SIGTERM and leaves through its own shutdown (exit 0,
  // not the SIGKILL backstop), and the git it was waiting on ends with it.
  test("ends on SIGTERM while git has not answered", async () => {
    const asked = path.join(dir, "asked");
    const proc = await spawnTestDaemon({
      ...prepared.env,
      PATH: pathWithGit(
        dir,
        `[ "$*" = "rev-parse --local-env-vars" ] && { echo $$ > '${asked}.part'; mv '${asked}.part' '${asked}'; exec sleep 60; }\nexec '${realGit()}' "$@"`,
      ),
    });
    stalled = proc;
    await until(() => fs.existsSync(asked), "the daemon to ask git");
    const git = Number(fs.readFileSync(asked, "utf8"));
    expect(await proc.stop("SIGTERM")).toEqual({ code: 0, signal: null });
    expect(log()).toMatch(/received SIGTERM, shutting down/);
    expect(log()).not.toMatch(/daemon up:/);
    await until(() => !processProbe.alive(git), "the asked git to end");
  });

  test("whose git answers nothing logs why and what it means, and still withholds the forges' repositories", async () => {
    await spawnInside({
      PATH: pathWithGit(
        dir,
        `[ "$*" = "rev-parse --local-env-vars" ] && exit 0\nexec '${realGit()}' "$@"`,
      ),
    });
    await until(() => /daemon up:/.test(log()), "the daemon to be up");
    expect(log()).toMatch(/\[info\] launches withhold GH_REPO,GITLAB_REPO\n/);
    expect(log()).toMatch(
      /\[warn\] git could not name its repository-local environment variables: git named no variables, so the branch and PR shown may come from the repository of the shell that started the daemon, until the daemon restarts/,
    );
  });
});

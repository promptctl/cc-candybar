// [LAW:verifiable-goals] A daemon spawned from a shell whose GIT_DIR,
// GIT_WORK_TREE and forge repositories name an unrelated repository (a git
// hook, a `rebase --exec`, a vcsh shell) reads each session's branch from the
// session's own directory, and one whose git cannot name its repository-local
// variables says so, and what it means, on the bar. Its world is admitted as
// the daemon process admits it.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { admit } from "../../../src/host";
import { askGit } from "../../../src/proc/repository-local-env";
import { textOf } from "../../../src/render/frame";
import { render } from "../../helpers/daemon-e2e";
import { renderLines } from "../../helpers/daemon-log";
import { indicatorOf, readDiagnostics } from "../../helpers/diagnostics-viewer";
import { hostOf, worldOf } from "../../helpers/host";
import {
  startDaemon,
  type InWorkerDaemon,
} from "../../helpers/in-worker-daemon";
import {
  gitRepo,
  pathWithGit,
  realGit,
  shellInside,
} from "../../helpers/repository-local-env";
import { prepareIsolatedDaemonEnv } from "../../helpers/spawn-isolated-daemon";

jest.setTimeout(30_000);

describe("a daemon spawned inside another repository", () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;
  let removeTmpDirs: () => void;
  let daemon: InWorkerDaemon | undefined;

  // The daemon's world, admitted: its host's environment is the spawning
  // shell's, inside `elsewhere`, with `extra` laid over it.
  const admittedInside = async (extra: NodeJS.ProcessEnv = {}) => {
    const started = worldOf(
      hostOf({
        ...env,
        ...shellInside(gitRepo(dir, "elsewhere", "elsewhere")),
        ...extra,
      }),
    );
    return admit(started, await askGit(started.launcher, "unbounded"));
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-candybar-rle-e2e-"));
    const prepared = prepareIsolatedDaemonEnv("cc-candybar-rle");
    ({ env, removeTmpDirs } = prepared);
  });

  afterEach(async () => {
    await daemon?.stop();
    daemon = undefined;
    fs.rmSync(dir, { recursive: true, force: true });
    removeTmpDirs();
  });

  test("reads a session's branch from the session's own directory", async () => {
    daemon = startDaemon(env, { world: await admittedInside() });
    const mine = gitRepo(dir, "mine", "mine");
    const config = path.join(dir, "bar.json5");
    fs.writeFileSync(
      config,
      `{ segments: { b: { template: 'b:{{ .git.branch }}' } }, root: { h: ['b'] } }`,
    );
    const frame = await render(daemon, "rle-branch", mine, {}, [
      "cc-candybar",
      "--config",
      config,
    ]);
    expect(textOf(frame)).toContain("b:mine");
  });

  test("whose git cannot name its variables shows the fault, and what it means, on the bar", async () => {
    // The stand-in's empty answer is the fault; every other ask is the
    // machine's git.
    const PATH = pathWithGit(
      dir,
      `[ "$*" = "rev-parse --local-env-vars" ] && exit 0\nexec '${realGit()}' "$@"`,
    );
    daemon = startDaemon(env, { world: await admittedInside({ PATH }) });
    const mine = gitRepo(dir, "mine", "mine");
    // The first frame records what its walk met; the next one counts it.
    await render(daemon, "rle-fault", mine);
    const bar = await render(daemon, "rle-fault", mine);
    expect(indicatorOf(bar)).toBe("⚠ 1");
    const pages = await readDiagnostics(daemon, "rle-fault", mine, bar);
    expect(pages.map((p) => p.text).join("\n")).toContain(
      "git could not name its repository-local environment variables: git named no variables, so the branch and PR shown may come from the repository of the shell that started the daemon, until the daemon restarts",
    );
    const [event] = (await renderLines(env, "rle-fault", 2)).slice(-1);
    expect(event).toMatch(/ warn=\S*repository-local-env/);
  });
});

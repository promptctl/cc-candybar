// A daemon started from a shell that locates a repository of its own (a git
// hook, a `rebase --exec`, a vcsh shell) reads every session's repository from
// the session's own directory: its launches withhold what git names as
// locating one, and GH_REPO. A daemon whose git could not name them still
// starts and draws, withholds GH_REPO, and stands a warning on every bar.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { textOf } from "../../../src/render/frame";
import { render } from "../../helpers/daemon-e2e";
import { readDiagnostics } from "../../helpers/diagnostics-viewer";
import {
  startDaemon,
  type InWorkerDaemon,
} from "../../helpers/in-worker-daemon";
import { prepareIsolatedDaemonEnv } from "../../helpers/spawn-isolated-daemon";
import { renderLines } from "../../helpers/daemon-log";
import { HOST, hostOf, worldOf } from "../../helpers/host";
import { readerWorld } from "../../../src/host";

jest.setTimeout(30_000);

const BRANCH_BAR = `{ segments: { b: { template: 'branch:{{ .git.branch }}' } }, root: { h: ['b'] } }`;

const launchedEnv = async (
  daemon: InWorkerDaemon,
): Promise<Record<string, string>> => {
  const run = await daemon.daemon.launcher.launch({
    bin: process.execPath,
    args: ["-e", "process.stdout.write(JSON.stringify(process.env))"],
    category: "git",
  });
  if (!run.ok) throw new Error(`the child failed: ${JSON.stringify(run)}`);
  return JSON.parse(run.stdout) as Record<string, string>;
};

describe("a daemon started inside another repository", () => {
  let env: NodeJS.ProcessEnv;
  let removeTmpDirs: () => void;
  let dir: string;
  let session: string;
  let config: string;
  let daemon: InWorkerDaemon;

  // Made before the daemon places its environment in this worker, so the
  // case's own git runs see none of it.
  function repo(name: string, branch: string): string {
    const at = path.join(dir, name);
    fs.mkdirSync(at);
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: at, stdio: "pipe" });
    git("init", "-q", "-b", branch);
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "c");
    return at;
  }

  beforeAll(() => {
    const prepared = prepareIsolatedDaemonEnv("cc-candybar-repo-env-e2e");
    ({ removeTmpDirs } = prepared);
    dir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "cc-candybar-repo-env-e2e-")),
    );
    const other = repo("hook", "hooks-branch");
    session = repo("session", "session-branch");
    config = path.join(dir, "bar.json5");
    fs.writeFileSync(config, BRANCH_BAR);
    // The shell the daemon was started from: a hook's, in another checkout.
    env = {
      ...prepared.env,
      GIT_DIR: path.join(other, ".git"),
      GIT_WORK_TREE: other,
      GH_REPO: "someone/else",
    };
    // The worker's reader, which asks the worker's git as a daemon's process
    // asks its own.
    daemon = startDaemon(env);
  });

  afterAll(async () => {
    await daemon?.stop();
    fs.rmSync(dir, { recursive: true, force: true });
    removeTmpDirs();
  });

  test("reads a session's branch from the session's own directory", async () => {
    const bar = await render(daemon, "repo-env", session, {}, [
      "cc-candybar",
      "--config",
      config,
    ]);
    expect(textOf(bar)).toContain("branch:session-branch");
  });

  test("launches its reads with none of what locates the shell's repository", async () => {
    const seen = await launchedEnv(daemon);
    expect(seen).not.toHaveProperty("GIT_DIR");
    expect(seen).not.toHaveProperty("GIT_WORK_TREE");
    expect(seen).not.toHaveProperty("GH_REPO");
    // The daemon's own environment, the one the harness placed, keeps them.
    expect(process.env.GIT_DIR).toBe(env.GIT_DIR);
  });
});

describe("a daemon whose git could not name what locates a repository", () => {
  let env: NodeJS.ProcessEnv;
  let removeTmpDirs: () => void;
  let dir: string;
  let daemon: InWorkerDaemon;

  beforeAll(() => {
    const prepared = prepareIsolatedDaemonEnv("cc-candybar-repo-env-fault");
    env = { ...prepared.env, GH_REPO: "someone/else" };
    ({ removeTmpDirs } = prepared);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-candybar-repo-env-fault-"));
    // A git too old to know the flag, which echoes it back, asked by the
    // reader the daemon's launches withhold by.
    const bin = path.join(dir, "bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "git"), '#!/bin/sh\nfor a; do echo "$a"; done | tail -1\n', {
      mode: 0o755,
    });
    daemon = startDaemon(env, {
      world: readerWorld(
        worldOf(hostOf({ ...HOST.env, PATH: `${bin}:${HOST.env.PATH}` })),
      ),
    });
  });

  afterAll(async () => {
    await daemon?.stop();
    fs.rmSync(dir, { recursive: true, force: true });
    removeTmpDirs();
  });

  test("still withholds the forge's variable, which needs no git", async () => {
    expect(await launchedEnv(daemon)).not.toHaveProperty("GH_REPO");
  });

  test("starts, draws, and stands a warning on the bar with git's reason", async () => {
    const draw = () => render(daemon, "repo-env-fault", dir);
    await draw();
    const bar = await draw();
    expect(textOf(bar)).toContain("⚠");
    const [event] = (await renderLines(env, "repo-env-fault", 2)).slice(-1);
    expect(event).toMatch(/ warn=\S*repository-vars/);
    const pages = await readDiagnostics(daemon, "repo-env-fault", dir, bar);
    expect(pages.map((p) => p.text).join("\n")).toContain(
      'answered "--local-env-vars", which is no variable name',
    );
  });
});

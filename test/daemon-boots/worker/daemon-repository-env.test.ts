// A daemon spawned from a shell whose environment names a repository (a git
// hook's GIT_DIR, a vcsh shell's GIT_WORK_TREE, a GH_REPO) reads each
// session's branch, status and PR from the session's own directory. The forge
// is a stub `gh` on the daemon's PATH that asks git for the branch and answers
// with another PR number when GH_REPO reaches it, so the whole chain runs:
// launcher → git and forge CLI → payload → frame.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { textOf } from "../../../src/render/frame";
import { REPOSITORY_NAMING_ENV } from "../../../src/repository-cli";
import { frameRequest, hookData } from "../../helpers/daemon-e2e";
import {
  startDaemon,
  type InWorkerDaemon,
} from "../../helpers/in-worker-daemon";
import { prepareIsolatedDaemonEnv } from "../../helpers/spawn-isolated-daemon";

jest.setTimeout(30_000);

const GH = `#!/bin/sh
b=$(git branch --show-current)
n=7; [ -n "$GH_REPO" ] && n=99
case "$b" in
  session) printf '{"number":%s,"state":"OPEN","url":"https://github.com/x/y/pull/%s","headRefOid":"%s"}\\n' "$n" "$n" "$(git rev-parse HEAD)" ;;
  *) echo "no pull requests found for branch \\"$b\\"" >&2; exit 1 ;;
esac
`;

describe("a daemon whose own environment names another repository", () => {
  let removeTmpDirs: () => void;
  let dir: string;
  let config: string;
  let session: string;
  let daemon: InWorkerDaemon;

  // These git calls act on the directory they name whatever this worker's
  // environment holds: the daemon places its own there.
  function repo(name: string, untracked: number): string {
    const at = path.join(dir, name);
    fs.mkdirSync(at);
    const named: readonly string[] = REPOSITORY_NAMING_ENV;
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([n]) => !named.includes(n)),
    );
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: at, env, stdio: "pipe" });
    git("init", "-q", "-b", name);
    git(
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "c",
    );
    git("remote", "add", "origin", "git@github.com:x/y.git");
    for (let i = 0; i < untracked; i++)
      fs.writeFileSync(path.join(at, `u${i}`), "");
    return at;
  }

  beforeAll(() => {
    const prepared = prepareIsolatedDaemonEnv("cc-candybar-repo-env");
    ({ removeTmpDirs } = prepared);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-candybar-repo-env-"));
    const bin = path.join(dir, "bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "gh"), GH, { mode: 0o755 });
    const elsewhere = repo("elsewhere", 3);
    session = repo("session", 1);

    config = path.join(dir, "bar.json5");
    fs.writeFileSync(
      config,
      `{ segments: { g: { template: 'b:{{ .git.branch }} u:{{ .git.untracked }} pr:{{ .git.prNumber }}' } }, root: { h: ['g'] } }`,
    );

    daemon = startDaemon({
      ...prepared.env,
      PATH: `${bin}:${process.env.PATH}`,
      GIT_DIR: path.join(elsewhere, ".git"),
      GIT_WORK_TREE: elsewhere,
      GH_REPO: "other/elsewhere",
    });
  });

  afterAll(async () => {
    await daemon?.stop();
    fs.rmSync(dir, { recursive: true, force: true });
    removeTmpDirs();
  });

  test("the session's branch, status and PR are its own directory's", async () => {
    const out = textOf(
      await frameRequest(daemon, {
        hookData: hookData("repo-env", session),
        args: ["cc-candybar", "--config", config],
        cwd: session,
      }),
    );
    expect(out).toContain("b:session u:1 pr:7");
  });
});

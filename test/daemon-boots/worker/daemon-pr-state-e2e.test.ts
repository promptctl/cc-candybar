// [LAW:nothing-unseen] brandon-workflow-mgo2, measured on the daemon's own
// request handling: the branch's PR reaches the bar in whatever state the forge reports it — open,
// merged or closed — and the render event says which (`pr=`), `failed` when the
// forge could not answer, `earlier-<state>` when the forge's PR is an older use
// of the branch's name (REUSED), and `-` when it has none. The forge is a stub
// `gh` on the daemon's PATH answering by branch name, so the whole chain runs:
// forge CLI → parser → payload → render event.
//
// The daemon is started from a shell whose environment names another
// repository (a git hook's GIT_DIR, a vcsh shell's GIT_WORK_TREE, a GH_REPO),
// so every case also shows that each session's branch, status and PR are read
// from its own directory.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { textOf } from "../../../src/render/frame";
import {
  FORGE_CLI,
  withoutRepositoryScopedEnv,
} from "../../../src/repository-cli";
import { frameRequest, hookData } from "../../helpers/daemon-e2e";
import { startDaemon, type InWorkerDaemon } from "../../helpers/in-worker-daemon";
import { prepareIsolatedDaemonEnv } from "../../helpers/spawn-isolated-daemon";
import { renderLines } from "../../helpers/daemon-log";

jest.setTimeout(30_000);

// `gh pr view` for the checked-out branch: a branch named after a gh state
// has a PR in it whose head is HEAD, `REUSED` a merged PR whose head is some
// earlier commit (the branch name was used before), `none` has no PR, and
// anything else is an auth failure, as is a GH_REPO that reached it.
const REPO_ENV = FORGE_CLI.github.repoEnv;
const GH = `#!/bin/sh
[ -n "$${REPO_ENV}" ] && { echo "HTTP 404: ${REPO_ENV} reached gh" >&2; exit 1; }
b=$(git branch --show-current)
pr() { printf '{"number":7,"state":"%s","url":"https://github.com/x/y/pull/7","headRefOid":"%s"}\\n' "$1" "$2"; }
case "$b" in
  OPEN|MERGED|CLOSED) pr "$b" "$(git rev-parse HEAD)" ;;
  REUSED) pr MERGED 0000000000000000000000000000000000000000 ;;
  none) echo "no pull requests found for branch \\"$b\\"" >&2; exit 1 ;;
  *) echo "HTTP 401: Bad credentials" >&2; exit 1 ;;
esac
`;

describe("a daemon render carries the branch's PR in every state", () => {
  let env: NodeJS.ProcessEnv;
  let removeTmpDirs: () => void;
  let dir: string;
  let config: string;
  let daemon: InWorkerDaemon;

  // A checkout of its own per branch: the daemon's git cache is keyed by repo
  // root and refreshed by a watch on .git/HEAD, so one checkout switching
  // branches between renders would race that watch. Its git calls name their
  // environment, since the daemon places its own in this worker.
  function checkout(branch: string): string {
    const repo = path.join(dir, `repo-${branch}`);
    fs.mkdirSync(repo);
    const env = withoutRepositoryScopedEnv(process.env);
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: repo, env, stdio: "pipe" });
    git("init", "-q", "-b", branch);
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "c");
    git("remote", "add", "origin", "git@github.com:x/y.git");
    return repo;
  }

  beforeAll(async () => {
    const prepared = prepareIsolatedDaemonEnv("cc-candybar-pr-e2e");
    ({ removeTmpDirs } = prepared);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-candybar-pr-e2e-"));
    const bin = path.join(dir, "bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "gh"), GH, { mode: 0o755 });

    config = path.join(dir, "bar.json5");
    fs.writeFileSync(
      config,
      `{ segments: { pr: { template: 'b:{{ .git.branch }} u:{{ .git.untracked }} pr:{{ .git.prState }} t:{{ .git.tracking }}' } }, root: { h: ['pr'] } }`,
    );

    // The other repository: its own branch, and files no session has.
    const elsewhere = checkout("elsewhere");
    for (const name of ["a", "b", "c"])
      fs.writeFileSync(path.join(elsewhere, name), "");

    env = {
      ...prepared.env,
      PATH: `${bin}:${process.env.PATH}`,
      GIT_DIR: path.join(elsewhere, ".git"),
      GIT_WORK_TREE: elsewhere,
      [REPO_ENV]: "other/elsewhere",
    };
    daemon = startDaemon(env);
  });

  afterAll(async () => {
    await daemon?.stop();
    fs.rmSync(dir, { recursive: true, force: true });
    removeTmpDirs();
  });

  const prFacts = async (sessionId: string) =>
    (await renderLines(env, sessionId)).map((l) => l.match(/ pr=(\S+) /)?.[1]);

  test.each([
    ["OPEN", "pr:open ", "open"],
    ["MERGED", "pr:merged ", "merged"],
    ["CLOSED", "pr:closed ", "closed"],
    ["REUSED", "pr: ", "earlier-merged"],
    ["none", "pr: ", "-"],
    ["denied", "pr: ", "failed"],
  ])("branch %s → %j, pr=%s", async (branch, cell, fact) => {
    const sessionId = `pr-e2e-${branch}`;
    const repo = checkout(branch);
    const out = textOf(
      await frameRequest(daemon, {
        hookData: hookData(sessionId, repo),
        args: ["cc-candybar", "--config", config],
        cwd: repo,
      }),
    );
    // The session's own branch and status, not the daemon's GIT_DIR's.
    expect(out).toContain(`b:${branch} u:0 `);
    expect(out).toContain(cell);
    // A remote, but no branch here was ever pushed to it.
    expect(out).toContain("t:none");
    expect((await prFacts(sessionId)).at(-1)).toBe(fact);
  });
});

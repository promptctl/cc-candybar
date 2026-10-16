// [LAW:nothing-unseen] brandon-workflow-mgo2, measured on a REAL daemon: the
// branch's PR reaches the bar in whatever state the forge reports it — open,
// merged or closed — and the render event says which (`pr=`), `failed` when the
// forge could not answer and `-` when the branch has none. The forge is a stub
// `gh` on the daemon's PATH answering by branch name, so the whole chain runs:
// forge CLI → parser → payload → render event, and lit's work-loop stage
// (examples/plugins/lit) reading that payload over the checkout's own
// `.lit/statusline.json`.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { logPath } from "../src/daemon/paths";
import {
  hookData,
  killAndWait,
  renderRequest,
  stripAnsi,
} from "./helpers/daemon-e2e";
import {
  prepareIsolatedDaemonEnv,
  spawnDaemonWithEnv,
  type RunningDaemon,
} from "./helpers/spawn-isolated-daemon";

jest.setTimeout(30_000);

const DEFINITION = path.join(
  __dirname,
  "..",
  "examples",
  "plugins",
  "lit",
  "plugin.json5",
);

// `gh pr view` for the checked-out branch: a branch named after a gh state
// has a PR in it whose head is HEAD, `REUSED` a merged PR whose head is some
// earlier commit (the branch name was used before), `none` has no PR, and
// anything else is an auth failure.
const GH = `#!/bin/sh
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
  let sockPath: string;
  let removeTmpDirs: () => void;
  let dir: string;
  let config: string;
  let daemon: RunningDaemon | undefined;

  // A checkout of its own per branch: the daemon's git cache is keyed by repo
  // root and refreshed by a watch on .git/HEAD, so one checkout switching
  // branches between renders would race that watch.
  function checkout(branch: string): string {
    const repo = path.join(dir, `repo-${branch}`);
    fs.mkdirSync(repo);
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: repo, stdio: "pipe" });
    git("init", "-q", "-b", branch);
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "c");
    git("remote", "add", "origin", "git@github.com:x/y.git");
    // lit's file is the checkout's own, and kept out of git status the way
    // lit keeps it: through info/exclude.
    fs.appendFileSync(path.join(repo, ".git", "info", "exclude"), "/.lit/\n");
    fs.mkdirSync(path.join(repo, ".lit"));
    fs.writeFileSync(
      path.join(repo, ".lit", "statusline.json"),
      JSON.stringify({
        schema_version: 1,
        working_on: { ticket: { id: "w-9", title: "t" }, recorded_at: "2026-10-15T13:59:25Z" },
        next: null,
      }),
    );
    return repo;
  }

  beforeAll(async () => {
    const prepared = prepareIsolatedDaemonEnv("cc-candybar-pr-e2e");
    ({ sockPath, removeTmpDirs } = prepared);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-candybar-pr-e2e-"));
    const bin = path.join(dir, "bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "gh"), GH, { mode: 0o755 });
    const installed = path.join(dir, "data", "cc-candybar", "plugins", "lit");
    fs.mkdirSync(installed, { recursive: true });
    fs.copyFileSync(DEFINITION, path.join(installed, "plugin.json5"));

    config = path.join(dir, "bar.json5");
    fs.writeFileSync(
      config,
      `{ segments: { pr: { template: 'pr:{{ .git.prState }} t:{{ .git.tracking }}' } }, root: { h: ['pr', 'plugins.lit.stage'] } }`,
    );

    env = {
      ...prepared.env,
      PATH: `${bin}:${process.env.PATH}`,
      XDG_DATA_HOME: path.join(dir, "data"),
    };
    daemon = await spawnDaemonWithEnv(env);
  });

  afterAll(async () => {
    if (daemon) await killAndWait(daemon);
    fs.rmSync(dir, { recursive: true, force: true });
    removeTmpDirs();
  });

  const prFacts = (sessionId: string) =>
    fs
      .readFileSync(logPath(env), "utf8")
      .split("\n")
      .filter((l) => l.includes(`render sid=${sessionId} `))
      .map((l) => l.match(/ pr=(\S+) /)?.[1]);

  // A first render can draw before the plugin's data file is read; the bar
  // settles on the next, so render until it shows the stage.
  async function settledBar(sessionId: string, repo: string): Promise<string> {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const out = stripAnsi(
        await renderRequest(sockPath, {
          hookData: hookData(sessionId, repo),
          args: ["cc-candybar", "--config", config],
          cwd: repo,
        }),
      );
      if (out.includes("↻") || Date.now() > deadline) return out;
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  test.each([
    ["OPEN", "pr:open ", "open", "↻ 4/5 review"],
    ["MERGED", "pr:merged ", "merged", "↻ 5/5 downstream"],
    ["CLOSED", "pr:closed ", "closed", "↻ 3/5 work"],
    ["REUSED", "pr: ", "earlier-merged", "↻ 3/5 work"],
    ["none", "pr: ", "-", "↻ 3/5 work"],
    ["denied", "pr: ", "failed", "↻ ⚠ PR"],
  ])("branch %s → %j, pr=%s, stage %s", async (branch, cell, fact, stage) => {
    const sessionId = `pr-e2e-${branch}`;
    const out = await settledBar(sessionId, checkout(branch));
    expect(out).toContain(cell);
    // A remote, but no branch here was ever pushed to it.
    expect(out).toContain("t:none");
    expect(out).toContain(stage);
    expect(prFacts(sessionId).at(-1)).toBe(fact);
  });
});

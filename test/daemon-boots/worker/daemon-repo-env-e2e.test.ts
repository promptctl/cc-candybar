// [LAW:verifiable-goals] brandon-unfiled-3248.99f8, on the daemon's own request
// handling: a daemon started from a shell whose GIT_DIR, GIT_WORK_TREE and
// GH_REPO name an unrelated repository reads every session's branch, status
// and PR from the session's own directory, because its world drops those
// variables before it launches anything. The forge is a stub `gh` on the
// daemon's PATH that writes the environment it was started with and refuses a
// GH_REPO, so a variable that leaked shows in its environment and on the bar.
// When git cannot name the variables (it fails, names nothing, or is too old to
// know the flag and prints it back), a fixed list stands in: the reads are
// still the session's, and the daemon says so loudly, in its log and as a
// standing ⚠ on the bar.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { textOf } from "../../../src/render/frame";
import { frameRequest, hookData } from "../../helpers/daemon-e2e";
import { indicatorOf } from "../../helpers/diagnostics-viewer";
import {
  startDaemon,
  type InWorkerDaemon,
} from "../../helpers/in-worker-daemon";
import { prepareIsolatedDaemonEnv } from "../../helpers/spawn-isolated-daemon";
import { loggedWhen, renderLines } from "../../helpers/daemon-log";

jest.setTimeout(30_000);

const REAL_GIT = execFileSync("sh", ["-c", "command -v git"], {
  encoding: "utf8",
}).trim();

// `gh pr view` as the forge answers the checked-out branch, after writing the
// environment it was started with beside its own script.
const gh = (envFile: string) => `#!/bin/sh
env > "${envFile}"
if [ -n "$GH_REPO" ]; then echo "GH_REPO=$GH_REPO is not this checkout" >&2; exit 1; fi
b=$(git branch --show-current)
if [ "$b" != OPEN ]; then echo "no pull requests found for branch \\"$b\\"" >&2; exit 1; fi
printf '{"number":7,"state":"OPEN","url":"https://github.com/x/y/pull/7","headRefOid":"%s"}\\n' "$(git rev-parse HEAD)"
`;

// A git whose answer to the ask is `answer`, and the real git otherwise.
const git = (answer: string) => `#!/bin/sh
if [ "$1" = rev-parse ] && [ "$2" = --local-env-vars ]; then
${answer}
fi
exec "${REAL_GIT}" "$@"
`;

const ASKS = {
  fails: {
    stub: `echo "fatal: not today" >&2; exit 128`,
    said: "exited with code 128",
  },
  "names nothing": { stub: "exit 0", said: "named no variable" },
  "prints the flag back": {
    stub: "echo --local-env-vars; exit 0",
    said: `answered "--local-env-vars", which is no variable's name`,
  },
};

const TEMPLATE =
  "b:{{ .git.branch }} u:{{ .git.untracked }} pr:{{ .git.prState }}";
const LEAKED = ["GIT_DIR", "GIT_WORK_TREE", "GH_REPO"];

function commit(repo: string, branch: string): void {
  fs.mkdirSync(repo);
  const run = (...args: string[]) =>
    execFileSync(REAL_GIT, args, { cwd: repo, stdio: "pipe" });
  run("init", "-q", "-b", branch);
  run(
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
  run("remote", "add", "origin", "git@github.com:x/y.git");
}

type Ask = (typeof ASKS)[keyof typeof ASKS] | null;
const CASES: ReadonlyArray<readonly [string, Ask]> = [
  ["git names them", null],
  ...Object.entries(ASKS).map(
    ([name, ask]) => [`the ask ${name}`, ask] as const,
  ),
];

describe.each(CASES)("a daemon started where %s", (_, ask) => {
  let env: NodeJS.ProcessEnv;
  let removeTmpDirs: () => void;
  let dir: string;
  let session: string;
  let envFile: string;
  let config: string;
  let daemon: InWorkerDaemon;

  beforeAll(() => {
    const prepared = prepareIsolatedDaemonEnv("cc-candybar-repo-env-e2e");
    ({ removeTmpDirs } = prepared);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-candybar-repo-env-e2e-"));
    const bin = path.join(dir, "bin");
    fs.mkdirSync(bin);
    envFile = path.join(dir, "gh-env");
    fs.writeFileSync(path.join(bin, "gh"), gh(envFile), { mode: 0o755 });
    if (ask !== null)
      fs.writeFileSync(path.join(bin, "git"), git(ask.stub), { mode: 0o755 });
    // The shell's repository, on another branch, clean.
    const other = path.join(dir, "other");
    commit(other, "elsewhere");
    // The session's, with one untracked file.
    session = path.join(dir, "session");
    commit(session, "OPEN");
    fs.writeFileSync(path.join(session, "new.txt"), "x");
    config = path.join(dir, "bar.json5");
    fs.writeFileSync(
      config,
      `{ segments: { g: { template: '${TEMPLATE}' } }, root: { h: ['g'] } }`,
    );
    env = {
      ...prepared.env,
      PATH: `${bin}:${process.env.PATH}`,
      GIT_DIR: path.join(other, ".git"),
      GIT_WORK_TREE: other,
      GH_REPO: "x/elsewhere",
    };
    daemon = startDaemon(env);
  });

  afterAll(async () => {
    await daemon?.stop();
    fs.rmSync(dir, { recursive: true, force: true });
    removeTmpDirs();
  });

  test("reads the session's own branch, status and PR, and nothing it launches inherits the shell's repository", async () => {
    const sessionId = `repo-env-${ask === null ? "named" : "fixed"}`;
    const bar = await frameRequest(daemon, {
      hookData: hookData(sessionId, session),
      args: ["cc-candybar", "--config", config],
      cwd: session,
    });
    expect(textOf(bar)).toContain("b:OPEN u:1 pr:open");
    const ghEnv = fs.readFileSync(envFile, "utf8").split("\n");
    for (const name of LEAKED)
      expect(ghEnv.filter((line) => line.startsWith(`${name}=`))).toEqual([]);
    // [LAW:no-silent-failure] A list git could not name stands on the bar.
    expect(indicatorOf(bar)).toBe(ask === null ? null : "⚠ 1");
    const warned = (await renderLines(env, sessionId)).map(
      (line) => / warn=(\S+)/.exec(line)?.[1],
    );
    expect(warned.at(-1)).toBe(ask === null ? "-" : "environment");
  });

  test("the log names what was dropped, and why git's list was not taken", async () => {
    const said = `environment: ${LEAKED.join(", ")} unset of the variables that locate a repository`;
    const lines = await loggedWhen(
      env,
      (l) => l.some((x) => x.includes(said)),
      said,
    );
    const line = lines.find((x) => x.includes(said))!;
    if (ask === null) {
      expect(line).toContain("[info]");
      expect(line).toContain(" GIT_COMMON_DIR GH_REPO)");
    } else {
      expect(line).toContain("[warn]");
      expect(line).toContain(ask.said);
    }
  });
});

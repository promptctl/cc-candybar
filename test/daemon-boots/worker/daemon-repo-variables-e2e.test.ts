// A daemon spawned from a shell whose GIT_DIR, GIT_WORK_TREE and GH_REPO name
// another repository (a git hook, a `rebase --exec`, a vcsh shell) still reads
// each session's own repository, through the daemon's own request handling,
// its real launcher and real git: the branch and status a render draws are the
// session's, a stub `gh` on the daemon's PATH writes the environment it was
// started with, and the doctor names what the reads run without. A git that
// cannot name the variables at the daemon's start leaves the fixed list,
// warned of in the log, on the bar and in the doctor, and the reads still
// follow the session.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { textOf, type Frame } from "../../../src/render/frame";
import { VERB_DOCTOR_RUN } from "../../../src/click/wire";
import { SETTINGS_NS } from "../../../src/config/reserved-names";
import {
  SETTINGS_ANCHOR,
  SETTINGS_OPEN,
} from "../../../src/config/settings-menu";
import {
  click,
  frameRequest,
  hookData,
  render,
  urlWriting,
} from "../../helpers/daemon-e2e";
import { effectsOf } from "../../helpers/click";
import { linkUrls } from "../../helpers/frame";
import { startDaemon } from "../../helpers/in-worker-daemon";
import { prepareIsolatedDaemonEnv } from "../../helpers/spawn-isolated-daemon";
import { loggedLines, renderLines } from "../../helpers/daemon-log";
import { until } from "../../helpers/until";

jest.setTimeout(30_000);

// The test's own git calls name their whole environment: the worker's is the
// daemon's while one runs, GIT_DIR included.
const TEST_ENV = { ...process.env };
const REAL_GIT = execFileSync("sh", ["-c", "command -v git"], {
  env: TEST_ENV,
  encoding: "utf8",
}).trim();

function repo(at: string, branch: string): string {
  fs.mkdirSync(at, { recursive: true });
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: at, env: TEST_ENV, stdio: "pipe" });
  git("init", "-q", "-b", branch);
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
  return at;
}

const BAR = `{ segments: { g: { template: 'b:{{ .git.branch }} u:{{ .git.untracked }} pr:{{ .git.prState }}' } }, root: { h: ['g'] } }`;

// What a `git rev-parse --local-env-vars` that cannot answer does, with every
// other git command passed to the real one.
const ASK_FAILS = `echo "fatal: simulated" >&2; exit 128`;
const ASK_EMPTY = `exit 0`;

interface Machine {
  readonly env: NodeJS.ProcessEnv;
  readonly own: string;
  readonly config: string;
  readonly ghEnv: string;
  readonly done: () => void;
}

// The session's checkout on branch `own` with one untracked file; another
// repository on branch `elsewhere` that the daemon's environment names; and a
// `gh` that writes its environment and finds no PR. `ask`, when given, is
// what the daemon's git does when asked for the variables.
function machine(ask?: string): Machine {
  const prepared = prepareIsolatedDaemonEnv("cc-candybar-repo-vars");
  const dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "cc-candybar-repo-vars-")),
  );
  const own = repo(path.join(dir, "own"), "own");
  fs.writeFileSync(path.join(own, "new.txt"), "x");
  const other = repo(path.join(dir, "other"), "elsewhere");
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  const ghEnv = path.join(dir, "gh-env");
  fs.writeFileSync(
    path.join(bin, "gh"),
    `#!/bin/sh\nenv > '${ghEnv}'\necho 'no pull requests found for branch "own"' >&2\nexit 1\n`,
    { mode: 0o755 },
  );
  if (ask !== undefined)
    fs.writeFileSync(
      path.join(bin, "git"),
      `#!/bin/sh\nif [ "$1" = rev-parse ] && [ "$2" = --local-env-vars ]; then ${ask}; fi\nexec '${REAL_GIT}' "$@"\n`,
      { mode: 0o755 },
    );
  const config = path.join(dir, "bar.json5");
  fs.writeFileSync(config, BAR);
  return {
    env: {
      ...prepared.env,
      PATH: `${bin}:${process.env.PATH}`,
      GIT_DIR: path.join(other, ".git"),
      GIT_WORK_TREE: other,
      GH_REPO: "someone/else",
    },
    own,
    config,
    ghEnv,
    done: () => {
      fs.rmSync(dir, { recursive: true, force: true });
      prepared.removeTmpDirs();
    },
  };
}

const drawGit = (
  daemon: ReturnType<typeof startDaemon>,
  sid: string,
  m: Machine,
): Promise<Frame> =>
  frameRequest(daemon, {
    hookData: hookData(sid, m.own),
    args: ["cc-candybar", "--config", m.config],
    cwd: m.own,
  });

// The variables the daemon's environment names another repository by.
const NAMING = ["GIT_DIR", "GIT_WORK_TREE", "GH_REPO"];

// Which of NAMING gh was started with, once it has run, and whether it was
// started with an environment at all.
async function ghStartedWith(
  m: Machine,
): Promise<{ path: boolean; naming: string[] }> {
  await until(
    () => fs.existsSync(m.ghEnv) && fs.readFileSync(m.ghEnv, "utf8") !== "",
    () => `gh to have run and written ${m.ghEnv}`,
  );
  const names = fs
    .readFileSync(m.ghEnv, "utf8")
    .split("\n")
    .map((line) => line.split("=")[0]!);
  return {
    path: names.includes("PATH"),
    naming: NAMING.filter((name) => names.includes(name)),
  };
}

// The doctor's report as the session's bar draws it, whitespace and strip
// caps aside, once the row starting `row` is in it.
async function doctorRow(
  daemon: ReturnType<typeof startDaemon>,
  sid: string,
  cwd: string,
  row: string,
): Promise<string> {
  const squeezed = (s: string) => s.replace(/[\s\uE000-\uF8FF]/gu, "");
  const closed = await render(daemon, sid, cwd);
  await click(daemon, urlWriting(closed, SETTINGS_ANCHOR, SETTINGS_OPEN));
  const opened = await render(daemon, sid, cwd);
  await click(daemon, urlWriting(opened, `${SETTINGS_NS}tab`, "tools"));
  const tools = await render(daemon, sid, cwd);
  const run = linkUrls(tools).find((u) =>
    effectsOf(u).some((e) => e.verb === VERB_DOCTOR_RUN),
  );
  expect(run).toBeDefined();
  await click(daemon, run!);
  let drawn = "";
  await until(
    async () =>
      (drawn = squeezed(textOf(await render(daemon, sid, cwd)))).includes(
        squeezed(row),
      ),
    () => `the report row ${JSON.stringify(row)}; last drawn: ${drawn}`,
  );
  return drawn;
}

test("a daemon whose shell names another repository reads the session's own", async () => {
  const m = machine();
  const daemon = startDaemon(m.env);
  try {
    const out = textOf(await drawGit(daemon, "repo-vars-own", m));
    expect(out).toContain("b:own u:1 ");
    expect(await ghStartedWith(m)).toEqual({ path: true, naming: [] });

    const report = await doctorRow(
      daemon,
      "repo-vars-doctor",
      m.own,
      "✓ git environment — the daemon's git and forge reads run without",
    );
    for (const name of NAMING) expect(report).toContain(name);
  } finally {
    await daemon.stop();
    m.done();
  }
});

test.each([
  ["fails", ASK_FAILS, "git rev-parse --local-env-vars exited with code 128"],
  ["answers nothing", ASK_EMPTY, "git named no variables"],
])(
  "a git whose ask %s leaves the fixed list, warned of, and the reads still follow the session",
  async (_, ask, why) => {
    const m = machine(ask);
    const daemon = startDaemon(m.env);
    try {
      const warning = `git could not name the variables that point it at another repository (${why}`;
      await loggedLines(
        m.env,
        (lines) =>
          lines.filter((l) => l.includes("[warn]") && l.includes(warning)),
        (warned) => warned.length === 1,
        "the daemon's warning that it runs on the fixed list",
      );

      const sid = "repo-vars-fixed";
      expect(textOf(await drawGit(daemon, sid, m))).toContain("b:own u:1 ");
      const [event] = (await renderLines(m.env, sid)).slice(-1);
      expect(event).toMatch(/ warn=(\S*,)?repo-variables[ ,]/);
      expect(await ghStartedWith(m)).toEqual({ path: true, naming: [] });

      const report = await doctorRow(
        daemon,
        "repo-vars-fixed-doctor",
        m.own,
        `✗ git environment — ${warning}`,
      );
      expect(report).toContain("GIT_DIR");
    } finally {
      await daemon.stop();
      m.done();
    }
  },
);

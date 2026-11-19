// git's repository-local environment variables, as admission withholds them,
// read off real children: each launch form starts a program that prints its
// environment, and git's answer is asked of a real git or a stub standing in
// for one.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { detectClientHints } from "../../src/client-hints";
import { tryRenderViaDaemon } from "../../src/daemon/client";
import { admit } from "../../src/host";
import type { Launcher } from "../../src/proc/launcher";
import {
  admissionWarnings,
  askGit,
  describeUnknown,
  withheldFor,
  type RepositoryLocalEnv,
} from "../../src/proc/repository-local-env";
import { hookData } from "../helpers/daemon-e2e";
import { hostOf, worldOf } from "../helpers/host";
import {
  envOf,
  pathWithGit,
  SHELL_NAMES,
  shellInside,
} from "../helpers/repository-local-env";
import { until } from "../helpers/until";

const ELSEWHERE = shellInside("/elsewhere");
const NAMED: RepositoryLocalEnv = {
  kind: "named",
  names: ["GIT_DIR", "GIT_WORK_TREE"],
};
const UNKNOWN: RepositoryLocalEnv = {
  kind: "unknown",
  reason: "git not found",
};

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "repository-local-env-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

// A started world whose environment is the spawning shell's, stated here.
const startedOver = (extra: NodeJS.ProcessEnv = {}) =>
  worldOf(
    hostOf({ PATH: process.env.PATH, KEEP: "kept", ...ELSEWHERE, ...extra }),
  );

// The names `shellInside` set, as a child's environment holds them.
const shellNamesIn = (env: Record<string, string>) =>
  SHELL_NAMES.map((name) => env[name]);

const ENV = { bin: "env", environment: "inherited", category: "git" } as const;

// A file a detached program wrote, once it is whole.
async function written(file: string): Promise<string> {
  await until(
    () =>
      fs.existsSync(file) && fs.readFileSync(file, "utf8").includes("KEEP="),
    `${file} to be written`,
  );
  return fs.readFileSync(file, "utf8");
}

// Every form a launcher launches in, each printing its child's environment.
const FORMS: ReadonlyArray<
  readonly [string, (l: Launcher) => Promise<string>]
> = [
  [
    "launch",
    async (l) => {
      const r = await l.launch(ENV);
      if (!r.ok) throw new Error(JSON.stringify(r));
      return r.stdout;
    },
  ],
  [
    "launchChannel",
    async (l) => {
      let out = "";
      const channel = l.launchChannel({
        ...ENV,
        heard: { stdout: (text) => (out += text), stderr: () => {} },
      });
      await channel.ended;
      return out;
    },
  ],
  [
    "launchDetachedSync",
    async (l) => {
      const file = path.join(dir, "detached");
      const r = l.launchDetachedSync({
        bin: "sh",
        args: ["-c", 'env > "$0.part" && mv "$0.part" "$0"', file],
        environment: "inherited",
        category: "daemon-spawn",
      });
      if (!r.ok) throw new Error(JSON.stringify(r));
      return written(file);
    },
  ],
  [
    "launchJobSync",
    async (l) => {
      const files = {
        stdout: path.join(dir, "job.out"),
        stderr: path.join(dir, "job.err"),
        status: path.join(dir, "job.status"),
      };
      const job = l.launchJobSync(ENV, files);
      if (!job.ok) throw new Error(JSON.stringify(job));
      job.release();
      await until(() => fs.existsSync(files.status), "the job to end");
      return fs.readFileSync(files.stdout, "utf8");
    },
  ],
];

describe("a world admitted on git's names", () => {
  const admitted = () => admit(startedOver(), NAMED);

  test.each(FORMS)(
    "%s starts its child without them or the forges' repositories, and with the rest",
    async (_form, run) => {
      const env = envOf(await run(admitted().launcher));
      expect(env.KEEP).toBe("kept");
      expect(shellNamesIn(env)).toEqual(SHELL_NAMES.map(() => undefined));
    },
  );

  test("launchSync starts its child without them", () => {
    const r = admitted().launcher.launchSync(ENV);
    if (!r.ok) throw new Error(JSON.stringify(r));
    const env = envOf(r.stdout);
    expect(env.KEEP).toBe("kept");
    expect(shellNamesIn(env)).toEqual(SHELL_NAMES.map(() => undefined));
  });

  // The daemon's own launcher is made this way, so its git and PR reads do.
  test.each(FORMS)(
    "an owner's launcher made by it withholds them too (%s)",
    async (_form, run) => {
      const env = envOf(await run(admitted().launcher.forOwner({})));
      expect(env.KEEP).toBe("kept");
      expect(shellNamesIn(env)).toEqual(SHELL_NAMES.map(() => undefined));
    },
  );

  test("a session's own environment keeps its GIT_DIR", async () => {
    const r = await admitted().launcher.launch({
      ...ENV,
      environment: {
        session: { PATH: process.env.PATH ?? "", GIT_DIR: "/session/.git" },
      },
    });
    if (!r.ok) throw new Error(JSON.stringify(r));
    expect(envOf(r.stdout).GIT_DIR).toBe("/session/.git");
  });

  test("withholds what git named and the forges' repositories, and warns of nothing", () => {
    const world = admitted();
    expect(withheldFor(world.answer)).toEqual(
      expect.arrayContaining([...SHELL_NAMES]),
    );
    expect(admissionWarnings(world.answer)).toEqual([]);
  });

  // The host the daemon reads is the one its main read, whole: a report hands
  // it on as the session's.
  test("leaves the host's own environment as it started", () => {
    expect(admitted().host.env.GIT_DIR).toBe(ELSEWHERE.GIT_DIR);
  });
});

describe("a world admitted on an unknown answer", () => {
  const admitted = () => admit(startedOver(), UNKNOWN);

  test.each(FORMS)(
    "%s still withholds the forges' repositories",
    async (_form, run) => {
      const env = envOf(await run(admitted().launcher));
      expect([env.GH_REPO, env.GITLAB_REPO]).toEqual([undefined, undefined]);
      // git named nothing, so nothing else is known to withhold.
      expect(env.GIT_DIR).toBe(ELSEWHERE.GIT_DIR);
    },
  );

  test("is worded by the one describer, with what it means to whoever asked", () => {
    expect(admissionWarnings(admitted().answer)).toEqual([
      {
        kind: "repository-local-env",
        message:
          "git could not name its repository-local environment variables: git not found, so the branch and PR shown may come from the repository of the shell that started the daemon, until the daemon restarts",
      },
    ]);
    expect(describeUnknown(UNKNOWN, "plugin install")).toBe(
      "git could not name its repository-local environment variables: git not found, so a clone could act on the repository of the shell it runs in",
    );
  });
});

test("a started world's launcher withholds nothing", async () => {
  const r = await startedOver().launcher.launch(ENV);
  if (!r.ok) throw new Error(JSON.stringify(r));
  expect(shellNamesIn(envOf(r.stdout))).toEqual(
    SHELL_NAMES.map((name) => ELSEWHERE[name]),
  );
});

test("the statusline relay asks git nothing", async () => {
  const calls = path.join(dir, "git-calls");
  const started = startedOver({
    PATH: pathWithGit(dir, `echo "$*" >> '${calls}'; echo GIT_DIR`),
    CC_CANDYBAR_SOCKET: path.join(dir, "no-daemon.sock"),
    XDG_STATE_HOME: path.join(dir, "state"),
  });
  const { host, clock } = started;
  const outcome = await tryRenderViaDaemon(
    { host, clock },
    hookData("relay", dir),
    ["cc-candybar"],
    dir,
    detectClientHints(host, dir, {}),
  );
  expect(outcome.kind).not.toBe("ok");
  expect(fs.existsSync(calls)).toBe(false);
  // The recording git is the one this world's programs would find.
  await askGit(started.launcher, "unbounded");
  expect(fs.readFileSync(calls, "utf8")).toBe("rev-parse --local-env-vars\n");
});

describe("git's answer", () => {
  // A launcher whose `git` runs `script`.
  const stubbed = (script: string) =>
    startedOver({ PATH: pathWithGit(dir, script) }).launcher;

  test("a real git names its variables", async () => {
    const answer = await askGit(startedOver().launcher, "unbounded");
    expect(answer.kind).toBe("named");
    expect(answer.kind === "named" && answer.names).toEqual(
      expect.arrayContaining(["GIT_DIR", "GIT_WORK_TREE"]),
    );
  });

  test("an empty answer is a fault", async () => {
    expect(await askGit(stubbed("exit 0"), "unbounded")).toEqual({
      kind: "unknown",
      reason: "git named no variables",
    });
  });

  test("a line that is no variable name is a fault (an old git echoes the flag)", async () => {
    expect(await askGit(stubbed(`printf '%s\\n' "$2"`), "unbounded")).toEqual({
      kind: "unknown",
      reason: 'git answered "--local-env-vars", which names no variable',
    });
  });

  test("a git that never answers is a fault at a bound", async () => {
    expect(await askGit(stubbed("exec sleep 5"), { withinMs: 200 })).toEqual({
      kind: "unknown",
      reason: "timed out after 0.2 s",
    });
  });

  // `plugin install` asks with no bound: a git slow on its first run answers.
  test("an unbounded ask waits for a slow git", async () => {
    expect(
      await askGit(stubbed("sleep 2.5; echo GIT_DIR"), "unbounded"),
    ).toEqual({ kind: "named", names: ["GIT_DIR"] });
  });

  // The daemon's loop is its own while git answers: a timer fires mid-ask.
  test("an ask holds no loop", async () => {
    let ticked = false;
    setTimeout(() => (ticked = true), 50);
    const answer = askGit(stubbed("sleep 0.5; echo GIT_DIR"), "unbounded");
    await until(() => ticked, "a timer to fire while git answers");
    expect(await answer).toEqual({ kind: "named", names: ["GIT_DIR"] });
  });

  test("a git that fails says how", async () => {
    expect(
      await askGit(stubbed("echo 'fatal: broken' >&2; exit 3"), "unbounded"),
    ).toEqual({ kind: "unknown", reason: "exited with code 3: fatal: broken" });
  });

  test("no git at all is 'git not found'", async () => {
    const empty = path.join(dir, "empty");
    fs.mkdirSync(empty);
    expect(
      await askGit(startedOver({ PATH: empty }).launcher, "unbounded"),
    ).toEqual({ kind: "unknown", reason: "git not found" });
  });
});

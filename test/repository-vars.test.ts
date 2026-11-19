// What a process's children inherit is decided by its launcher's scope, never
// by editing the process's own environment. A repository reader's launcher
// owns git's answer to which variables locate a repository: it asks once, at
// its first launch that inherits the process's environment, and its children
// inherit none of them nor GH_REPO, while the process's own environment, which
// it reports as its session's, keeps them all. The statusline's relay reads no
// repository, so it asks git nothing. Each child here is real and prints the
// environment it was given.

import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { HOST, hostOf, worldOf } from "./helpers/host";
import { fakeLauncher } from "./helpers/fake-launcher";
import { readerWorld, type World } from "../src/host";
import {
  ASK_TIMEOUT_MS,
  parseLocalEnvVars,
  type RepositoryVars,
} from "../src/proc/repository-vars";
import { SPAWN_COOLDOWN_MS } from "../src/daemon/acquire";
import { LIFELINE_PROGRAM } from "../src/proc/launch";
import type { LaunchOpts, LaunchResult } from "../src/proc/launcher";
import { encodeFrame, makeFrameReader } from "../src/daemon/foundations/protocol";
import { exits, program } from "../src/proc/spawner-fake";
import { systemTimekeeper } from "../src/time";

const REPO_ROOT = path.resolve(__dirname, "..");
const TSX = path.join(REPO_ROOT, "node_modules", ".bin", "tsx");
const ENTRY = path.join(REPO_ROOT, "src", "index.ts");

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-candybar-repo-vars-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

// A child that prints the environment it was started with.
const printEnv = (extra: Partial<LaunchOpts>): LaunchOpts => ({
  bin: process.execPath,
  args: ["-e", "process.stdout.write(JSON.stringify(process.env))"],
  category: "git",
  ...extra,
});

const parsed = (text: string): Record<string, string> =>
  JSON.parse(text) as Record<string, string>;

const outOf = (run: LaunchResult): Record<string, string> => {
  if (!run.ok) throw new Error(JSON.stringify(run));
  return parsed(run.stdout);
};

// A detached child hands back nothing and says nothing when it is done: what
// it writes is the one sign, so this one form is waited on by its file.
async function writtenBy(file: string): Promise<string> {
  for (let i = 0; i < 500 && !fs.existsSync(file); i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  return fs.readFileSync(file, "utf8");
}

// What each launch form's child was given, by the form's name, each read by
// its own completion: an awaited result, a returned one, a channel's end, a
// job's verdict, and the detached child's own file.
async function everyForm(
  world: World,
  extra: Partial<LaunchOpts> = {},
): Promise<Array<[string, Record<string, string>]>> {
  const { launcher } = world;
  const seen: Array<[string, Record<string, string>]> = [];
  seen.push(["launch", outOf(await launcher.launch(printEnv(extra)))]);
  seen.push(["launchSync", outOf(launcher.launchSync(printEnv(extra)))]);

  let heard = "";
  const channel = launcher.launchChannel({
    ...printEnv(extra),
    category: "renderer",
    heard: { stdout: (text) => (heard += text), stderr: () => {} },
  });
  channel.end();
  if (!(await channel.ended).ok) throw new Error("the channel failed");
  seen.push(["launchChannel", parsed(heard)]);

  const job = (name: string) => path.join(dir, `job.${name}`);
  const started = launcher.launchJobSync(
    { ...printEnv(extra), category: "click.run" },
    { stdout: job("out"), stderr: job("err"), status: job("status") },
  );
  if (!started.ok) throw new Error(JSON.stringify(started));
  started.release();
  await writtenBy(job("status"));
  seen.push(["launchJobSync", parsed(fs.readFileSync(job("out"), "utf8"))]);

  const detached = path.join(dir, "detached.json");
  const part = `${detached}.part`;
  launcher.launchDetachedSync({
    ...printEnv(extra),
    args: [
      "-e",
      `const fs = require("fs"); fs.writeFileSync(${JSON.stringify(part)}, JSON.stringify(process.env)); fs.renameSync(${JSON.stringify(part)}, ${JSON.stringify(detached)});`,
    ],
  });
  seen.push(["launchDetachedSync", parsed(await writtenBy(detached))]);
  return seen;
}

// A `git` first on a PATH of the case's own, which records each run and then
// runs `script`.
function gitStub(script: string): { PATH: string; runs: () => string[] } {
  const bin = path.join(dir, "bin");
  const runs = path.join(dir, "git-runs");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(
    path.join(bin, "git"),
    `#!/bin/sh\necho "$*" >> '${runs}'\n${script}\n`,
    { mode: 0o755 },
  );
  return {
    PATH: `${bin}:${HOST.env.PATH}`,
    runs: () =>
      fs.existsSync(runs)
        ? fs.readFileSync(runs, "utf8").split("\n").filter(Boolean)
        : [],
  };
}

const answerWith = (script: string, timeoutMs?: number): RepositoryVars =>
  readerWorld(
    worldOf(hostOf({ ...HOST.env, PATH: gitStub(script).PATH })),
    timeoutMs,
  ).launcher.repositoryVars.answer();

describe("git's answer", () => {
  test("names each variable git prints", () => {
    expect(parseLocalEnvVars("GIT_DIR\nGIT_WORK_TREE\n")).toEqual({
      kind: "named",
      names: ["GIT_DIR", "GIT_WORK_TREE"],
    });
  });

  test("a line that is no variable name is a fault, not a name", () => {
    expect(parseLocalEnvVars("GIT_DIR\n--local-env-vars\n")).toEqual({
      kind: "unknown",
      reason:
        '`git rev-parse --local-env-vars` answered "--local-env-vars", which is no variable name',
    });
  });

  test("an empty answer is a fault, not health", () => {
    expect(answerWith("exit 0")).toEqual({
      kind: "unknown",
      reason: "`git rev-parse --local-env-vars` named no variable",
    });
  });

  test("this machine's git names what locates a repository", () => {
    const answer = readerWorld(worldOf(HOST)).launcher.repositoryVars.answer();
    expect(answer.kind).toBe("named");
    expect(answer.kind === "named" && answer.names).toEqual(
      expect.arrayContaining(["GIT_DIR", "GIT_WORK_TREE"]),
    );
  });

  test("a git that fails is a fault carrying its own words", () => {
    expect(answerWith('echo "fatal: no such thing" >&2; exit 129')).toEqual({
      kind: "unknown",
      reason:
        "`git rev-parse --local-env-vars` failed (exited with code 129: fatal: no such thing)",
    });
  });

  test("a git that never answers is a fault once the ask's time is up", () => {
    expect(answerWith("exec sleep 30", 200)).toEqual({
      kind: "unknown",
      reason: "`git rev-parse --local-env-vars` failed (timed out after 0.2 s)",
    });
  });

  // A daemon's boot blocks on the ask: one that outlasts the client's spawn
  // cooldown lets a second daemon be spawned beside it.
  test("gives up inside the client's spawn cooldown", () => {
    expect(ASK_TIMEOUT_MS).toBeLessThan(SPAWN_COOLDOWN_MS);
  });
});

describe("a repository reader's launcher", () => {
  test("asks nothing as it is built, then once for its lifetime, whatever launches and reads follow", async () => {
    const git = gitStub("echo GIT_DIR; echo GIT_WORK_TREE");
    const world = readerWorld(worldOf(hostOf({ ...HOST.env, PATH: git.PATH })));
    expect(git.runs()).toEqual([]);
    await everyForm(world, { environment: { PATH: git.PATH } });
    await everyForm(world);
    await everyForm(world);
    world.launcher.repositoryVars.answer();
    world.launcher.standing();
    expect(git.runs()).toEqual(["rev-parse --local-env-vars"]);
  });
});

describe("a repository reader's children", () => {
  const otherGitDir = () => path.join(dir, "other", ".git");
  // The shell a hook or vcsh starts in: another repository located, a forge
  // repository named, a credential in git's config, and one variable of the
  // user's own.
  const hooked = (): NodeJS.ProcessEnv => ({
    ...HOST.env,
    GIT_DIR: otherGitDir(),
    GIT_WORK_TREE: path.join(dir, "other"),
    GIT_CONFIG_PARAMETERS: "'http.extraheader=Authorization: secret'",
    GH_REPO: "someone/else",
    KEPT: "mine",
  });

  test("inherit no repository variable, through every launch form", async () => {
    const world = readerWorld(worldOf(hostOf(hooked())));
    for (const [form, env] of await everyForm(world))
      expect([form, env.GIT_DIR, env.GIT_WORK_TREE, env.GIT_CONFIG_PARAMETERS, env.GH_REPO, env.KEPT])
        .toEqual([form, undefined, undefined, undefined, undefined, "mine"]);
  });

  test("inherit the forge's variable under no form, when git named nothing", async () => {
    const PATH = gitStub("exit 1").PATH;
    const world = readerWorld(worldOf(hostOf({ ...hooked(), PATH })));
    for (const [form, env] of await everyForm(world))
      expect([form, env.GH_REPO, env.GIT_DIR]).toEqual([form, undefined, otherGitDir()]);
    expect(world.launcher.standing()).toEqual([
      {
        kind: "standing",
        source: "repository-vars",
        message:
          "git may read the repository this process was started in rather than a session's: `git rev-parse --local-env-vars` failed (exited with code 1)",
      },
    ]);
  });

  test("keep a session's own repository, through every form that launches in a session's environment", async () => {
    const world = readerWorld(worldOf(hostOf(hooked())));
    const session = { PATH: HOST.env.PATH!, GIT_DIR: "/session/.git", GH_REPO: "session/repo" };
    for (const [form, env] of await everyForm(world, { environment: session }))
      expect([form, env.GIT_DIR, env.GH_REPO, env.KEPT]).toEqual([
        form,
        "/session/.git",
        "session/repo",
        undefined,
      ]);
  });

  test("while the process's own environment, which it reports as its session's, keeps them", async () => {
    const env = hooked();
    const world = readerWorld(worldOf(hostOf(env)));
    await everyForm(world);
    expect(world.host.env).toBe(env);
    expect(world.host.env.GIT_DIR).toBe(otherGitDir());
    expect(world.host.env.GH_REPO).toBe("someone/else");
  });

  test("inherit a variable set on the process after the launcher was built, and still not one it withholds", async () => {
    const env: NodeJS.ProcessEnv = { ...HOST.env };
    const world = readerWorld(worldOf(hostOf(env)));
    env.LATER = "set later";
    env.GIT_DIR = path.join(dir, "later", ".git");
    const seen = (await everyForm(world))[0]![1];
    expect(seen.LATER).toBe("set later");
    expect(seen).not.toHaveProperty("GIT_DIR");
  });

  test("include the launcher's lifeline", async () => {
    const { launcher, spawner } = fakeLauncher(systemTimekeeper, {
      inherited: { GIT_DIR: otherGitDir(), GH_REPO: "someone/else", KEPT: "mine" },
      withholds: { withheld: () => ["GIT_DIR", "GH_REPO"], faults: () => [] },
    });
    spawner.program(program("git"), exits(0));
    await launcher.launch({ bin: "git", category: "git" });
    const line = spawner.spawned.find((s) => s.args[0] === LIFELINE_PROGRAM);
    expect(line?.options.env).toEqual({ KEPT: "mine" });
  });

  test("of a process that reads no repository inherit everything", async () => {
    const seen = (await everyForm(worldOf(hostOf(hooked()))))[0]![1];
    expect(seen.GIT_DIR).toBe(otherGitDir());
    expect(seen.GH_REPO).toBe("someone/else");
  });
});

describe("the statusline's relay", () => {
  test("asks git nothing, and reports the session's environment whole", async () => {
    const mark = path.join(dir, "git-ran");
    const { PATH } = gitStub(`echo "$@" >> '${mark}'; exit 1`);
    const sock = path.join(dir, "daemon.sock");
    const requests: Array<Record<string, unknown>> = [];
    const server = net.createServer((conn) => {
      conn.on(
        "data",
        makeFrameReader(
          (frame) => {
            requests.push(frame as Record<string, unknown>);
            conn.end(encodeFrame({ ok: true, output: "bar" }));
            return "done";
          },
          (err) => {
            throw err;
          },
        ),
      );
    });
    await new Promise<void>((resolve) => server.listen(sock, resolve));
    // A state directory that cannot be made, so a relay that missed the stub
    // starts no daemon: it fails the case on its output instead.
    fs.writeFileSync(path.join(dir, "not-a-dir"), "");
    const gitDir = path.join(dir, "other", ".git");
    try {
      const run = await new Promise<{ stdout: string; stderr: string }>(
        (resolve, reject) => {
          const child = spawn(TSX, [ENTRY], {
            env: {
              ...HOST.env,
              PATH,
              GIT_DIR: gitDir,
              CC_CANDYBAR_SOCKET: sock,
              XDG_STATE_HOME: path.join(dir, "not-a-dir", "state"),
            },
          });
          let stdout = "";
          let stderr = "";
          child.stdout.on("data", (d: Buffer) => (stdout += String(d)));
          child.stderr.on("data", (d: Buffer) => (stderr += String(d)));
          child.on("error", reject);
          child.on("close", () => resolve({ stdout, stderr }));
          child.stdin.end(
            JSON.stringify({
              session_id: "relay",
              workspace: { project_dir: dir },
              model: { id: "x", display_name: "X" },
            }),
          );
        },
      );
      expect(run.stdout).toBe("bar");
      expect(fs.existsSync(mark)).toBe(false);
      expect(requests).toHaveLength(1);
      expect((requests[0]!.env as Record<string, string>).GIT_DIR).toBe(gitDir);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

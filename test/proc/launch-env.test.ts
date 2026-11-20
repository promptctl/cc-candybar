// What environment a child starts from, through the real launcher over the
// real OS: every child a launcher's owner launches lacks the variables scoped
// to a repository in the owner's own environment, whichever launch form
// started it, unless its overlay sets one; a program launched in a session's
// own environment gets that environment as it is.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createOneShotLauncher } from "../../src/proc/launch";
import type { LaunchOpts } from "../../src/proc/launcher";
import { systemSpawner, type Spawner } from "../../src/proc/spawner";
import { REPOSITORY_SCOPED_ENV } from "../../src/repository-cli";
import { systemTimekeeper } from "../helpers/system-clock";
import { until } from "../helpers/until";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-launch-env-"));
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

// An owner's environment as a git hook, a vcsh shell or `gh` would leave it:
// every repository-scoped name set, beside a variable that must pass.
const OWNER_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  ...Object.fromEntries(
    REPOSITORY_SCOPED_ENV.map((name) => [name, `/elsewhere/${name}`]),
  ),
  KEPT: "kept",
};

// A child that prints its whole environment as JSON: to stdout, or to a file
// it renames into place, so the file's presence means the record is whole.
const printsEnv = (to?: string): Pick<LaunchOpts, "bin" | "args"> => ({
  bin: process.execPath,
  args: [
    "-e",
    to === undefined
      ? "process.stdout.write(JSON.stringify(process.env))"
      : `const fs = require('fs'); fs.writeFileSync(${JSON.stringify(`${to}.part`)}, JSON.stringify(process.env)); fs.renameSync(${JSON.stringify(`${to}.part`)}, ${JSON.stringify(to)})`,
  ],
});

const parsed = (json: string): Record<string, string> =>
  JSON.parse(json) as Record<string, string>;

const scoped = (env: Record<string, string | undefined>) =>
  REPOSITORY_SCOPED_ENV.filter((name) => env[name] !== undefined);

// One case's launcher over the real OS, recording the environment each spawn
// was handed: the lifeline prints nothing, so what the launcher handed the OS
// for it is what it ran in. The owner's environment is the case's own, live,
// as a process's is. The launcher is closed when the case ends.
async function withLauncher(
  use: (
    launcher: ReturnType<typeof createOneShotLauncher>,
    handed: ReadonlyArray<{ bin: string; env: NodeJS.ProcessEnv | undefined }>,
    owner: NodeJS.ProcessEnv,
  ) => Promise<void> | void,
): Promise<void> {
  const owner: NodeJS.ProcessEnv = { ...OWNER_ENV };
  const handed: Array<{ bin: string; env: NodeJS.ProcessEnv | undefined }> = [];
  const recording: Spawner = {
    ...systemSpawner,
    spawn: (bin, args, options) => {
      handed.push({ bin, env: options.env });
      return systemSpawner.spawn(bin, args, options);
    },
    spawnSync: (bin, args, options) => {
      handed.push({ bin, env: options.env });
      return systemSpawner.spawnSync(bin, args, options);
    },
  };
  const ending = new AbortController();
  try {
    await use(
      createOneShotLauncher(
        { inherited: owner, signal: ending.signal },
        systemTimekeeper,
        recording,
      ),
      handed,
      owner,
    );
  } finally {
    ending.abort();
  }
}

describe("a child that inherits its owner's environment", () => {
  it("gets what the owner sets after its launcher is built, still lacking the rest", () =>
    withLauncher(async (launcher, _handed, owner) => {
      owner.LATE = "late";
      const r = await launcher.launch({ ...printsEnv(), category: "git" });
      const env = parsed(r.stdout);
      expect(env.LATE).toBe("late");
      expect(scoped(env)).toEqual([]);
    }));

  it("lacks every repository-scoped name, by launch", () =>
    withLauncher(async (launcher) => {
      const r = await launcher.launch({ ...printsEnv(), category: "git" });
      expect(r.ok).toBe(true);
      const env = parsed(r.stdout);
      expect(scoped(env)).toEqual([]);
      expect(env.KEPT).toBe("kept");
    }));

  it("lacks them by launchSync", () =>
    withLauncher((launcher) => {
      const r = launcher.launchSync({ ...printsEnv(), category: "plugin.git" });
      expect(r.ok).toBe(true);
      const env = parsed(r.stdout);
      expect(scoped(env)).toEqual([]);
      expect(env.KEPT).toBe("kept");
    }));

  it("lacks them by launchDetachedSync", () =>
    withLauncher(async (launcher) => {
      const out = path.join(scratch, "detached.json");
      expect(
        launcher.launchDetachedSync({
          ...printsEnv(out),
          category: "daemon-spawn",
        }).ok,
      ).toBe(true);
      await until(() => fs.existsSync(out), "the detached child's record");
      const env = parsed(fs.readFileSync(out, "utf8"));
      expect(scoped(env)).toEqual([]);
      expect(env.KEPT).toBe("kept");
    }));

  it("lacks them by launchJobSync", () =>
    withLauncher(async (launcher) => {
      const files = {
        stdout: path.join(scratch, "job.out"),
        stderr: path.join(scratch, "job.err"),
        status: path.join(scratch, "job.status"),
      };
      const job = launcher.launchJobSync(
        { ...printsEnv(), category: "user-shell" },
        files,
      );
      if (!job.ok) throw new Error(`job refused: ${job.error}`);
      job.release();
      await until(() => fs.existsSync(files.status), "the job's verdict");
      const env = parsed(fs.readFileSync(files.stdout, "utf8"));
      expect(scoped(env)).toEqual([]);
      expect(env.KEPT).toBe("kept");
    }));

  it("lacks them by launchChannel", () =>
    withLauncher(async (launcher) => {
      let said = "";
      const channel = launcher.launchChannel({
        ...printsEnv(),
        category: "renderer",
        heard: { stdout: (text) => (said += text), stderr: () => {} },
      });
      expect(await channel.ended).toMatchObject({ ok: true });
      await until(() => said.endsWith("}"), "the channel's print");
      const env = parsed(said);
      expect(scoped(env)).toEqual([]);
      expect(env.KEPT).toBe("kept");
    }));

  it("lacks them as the lifeline", () =>
    withLauncher(async (launcher, handed) => {
      await launcher.launch({ ...printsEnv(), category: "git" });
      const env = handed.find(({ bin }) => bin === "awk")?.env;
      if (env === undefined)
        throw new Error("the lifeline was handed no environment");
      expect(scoped(env)).toEqual([]);
      expect(env.KEPT).toBe("kept");
    }));

  // An overlay is the launch's own intent: what it names arrives as given,
  // and only what it names.
  it("gets one its overlay names, and still lacks the rest", () =>
    withLauncher(async (launcher) => {
      const r = await launcher.launch({
        ...printsEnv(),
        envOverlay: { GIT_DIR: "/overlaid" },
        category: "git",
      });
      const env = parsed(r.stdout);
      expect(env.GIT_DIR).toBe("/overlaid");
      expect(scoped(env)).toEqual(["GIT_DIR"]);
    }));
});

describe("a child launched in a session's own environment", () => {
  it("gets that environment as it is, its repository-scoped names included", () =>
    withLauncher(async (launcher) => {
      const session = {
        PATH: process.env.PATH ?? "",
        GIT_DIR: "/session/.git",
        GH_REPO: "o/session",
      };
      const r = await launcher.launch({
        ...printsEnv(),
        environment: session,
        category: "user-shell",
      });
      const env = parsed(r.stdout);
      expect(env.GIT_DIR).toBe("/session/.git");
      expect(env.GH_REPO).toBe("o/session");
      expect(env.KEPT).toBeUndefined();
    }));
});

// [LAW:one-source-of-truth] git's names are a copy of git's, so a git that
// adds a repository-local name fails here, not in a session. One way only: an
// older git that prints fewer names passes.
describe("the repository-scoped variables", () => {
  it("include every name the installed git clears", () => {
    const gits = execFileSync("git", ["rev-parse", "--local-env-vars"], {
      encoding: "utf8",
    })
      .split("\n")
      .filter((name) => name !== "");
    expect(gits.length).toBeGreaterThan(0);
    expect(
      gits.filter((name) => !REPOSITORY_SCOPED_ENV.includes(name)),
    ).toEqual([]);
  });
});

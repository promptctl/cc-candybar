// What environment a child starts from, through the real launcher over the
// real OS: every child a launcher's owner launches lacks the variables that
// name a repository in the owner's own environment, whichever launch form
// started it and whatever its overlay says; a program launched in a session's
// own environment gets that environment as it is.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createOneShotLauncher } from "../../src/proc/launch";
import type { LaunchOpts } from "../../src/proc/launcher";
import { systemSpawner, type Spawner } from "../../src/proc/spawner";
import { REPOSITORY_NAMING_ENV } from "../../src/repository-cli";
import { systemTimekeeper } from "../../src/time";
import { until } from "../helpers/until";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-launch-env-"));
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

// An owner's environment as a git hook, a vcsh shell or `gh` would leave it:
// every withheld name set, beside a variable that must pass.
const OWNER_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  ...Object.fromEntries(
    REPOSITORY_NAMING_ENV.map((name) => [name, `/elsewhere/${name}`]),
  ),
  KEPT: "kept",
};

// A child that prints its whole environment as JSON, to stdout or a file.
const printsEnv = (to?: string): Pick<LaunchOpts, "bin" | "args"> => ({
  bin: process.execPath,
  args: [
    "-e",
    to === undefined
      ? "process.stdout.write(JSON.stringify(process.env))"
      : `require('fs').writeFileSync(${JSON.stringify(to)}, JSON.stringify(process.env))`,
  ],
});

const parsed = (json: string): Record<string, string> =>
  JSON.parse(json) as Record<string, string>;

// The environment each spawn was handed, by program: the lifeline prints
// nothing, so what the launcher handed the OS for it is what it ran in.
let handed: Array<{ bin: string; env: NodeJS.ProcessEnv | undefined }>;
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

let ending: AbortController;
const launcher = () =>
  createOneShotLauncher(
    { inherited: OWNER_ENV, signal: ending.signal },
    systemTimekeeper,
    recording,
  );

beforeEach(() => {
  handed = [];
  ending = new AbortController();
});
afterEach(() => ending.abort());

const withheld = (env: Record<string, string | undefined>) =>
  REPOSITORY_NAMING_ENV.filter((name) => env[name] !== undefined);

describe("a child that inherits its owner's environment", () => {
  it("lacks every repository-local name, by launch", async () => {
    const r = await launcher().launch({ ...printsEnv(), category: "git" });
    expect(r.ok).toBe(true);
    const env = parsed(r.stdout);
    expect(withheld(env)).toEqual([]);
    expect(env.KEPT).toBe("kept");
  });

  it("lacks them by launchSync", () => {
    const r = launcher().launchSync({ ...printsEnv(), category: "plugin.git" });
    expect(r.ok).toBe(true);
    const env = parsed(r.stdout);
    expect(withheld(env)).toEqual([]);
    expect(env.KEPT).toBe("kept");
  });

  it("lacks them by launchDetachedSync", async () => {
    const out = path.join(scratch, "detached.json");
    expect(
      launcher().launchDetachedSync({
        ...printsEnv(out),
        category: "daemon-spawn",
      }).ok,
    ).toBe(true);
    await until(
      () => fs.existsSync(out) && fs.statSync(out).size > 0,
      "the detached child's print",
    );
    const env = parsed(fs.readFileSync(out, "utf8"));
    expect(withheld(env)).toEqual([]);
    expect(env.KEPT).toBe("kept");
  });

  it("lacks them by launchJobSync", async () => {
    const files = {
      stdout: path.join(scratch, "job.out"),
      stderr: path.join(scratch, "job.err"),
      status: path.join(scratch, "job.status"),
    };
    const job = launcher().launchJobSync(
      { ...printsEnv(), category: "user-shell" },
      files,
    );
    if (!job.ok) throw new Error(`job refused: ${job.error}`);
    job.release();
    await until(() => fs.existsSync(files.status), "the job's verdict");
    const env = parsed(fs.readFileSync(files.stdout, "utf8"));
    expect(withheld(env)).toEqual([]);
    expect(env.KEPT).toBe("kept");
  });

  it("lacks them by launchChannel", async () => {
    let said = "";
    const channel = launcher().launchChannel({
      ...printsEnv(),
      category: "renderer",
      heard: { stdout: (text) => (said += text), stderr: () => {} },
    });
    expect(await channel.ended).toMatchObject({ ok: true });
    await until(() => said.endsWith("}"), "the channel's print");
    const env = parsed(said);
    expect(withheld(env)).toEqual([]);
    expect(env.KEPT).toBe("kept");
  });

  it("lacks them as the lifeline", async () => {
    await launcher().launch({ ...printsEnv(), category: "git" });
    const env = handed.find(({ bin }) => bin === "awk")?.env;
    if (env === undefined)
      throw new Error("the lifeline was handed no environment");
    expect(withheld(env)).toEqual([]);
  });

  // The overlay's type refuses a withheld name written in the source.
  it("cannot name one in an overlay written in the source", () => {
    const opts: LaunchOpts = {
      ...printsEnv(),
      // @ts-expect-error a variable that names a repository is not overlaid
      envOverlay: { GIT_DIR: "/overlaid" },
      category: "git",
    };
    expect(opts.envOverlay).toEqual({ GIT_DIR: "/overlaid" });
  });

  it("lacks them whatever an overlay built at run time names", async () => {
    const overlay: Record<string, string> = Object.fromEntries(
      REPOSITORY_NAMING_ENV.map((name) => [name, "/overlaid"]),
    );
    const r = await launcher().launch({
      ...printsEnv(),
      envOverlay: overlay,
      category: "git",
    });
    expect(withheld(parsed(r.stdout))).toEqual([]);
  });
});

describe("a child launched in a session's own environment", () => {
  it("gets that environment as it is, its repository-local names included", async () => {
    const session = {
      PATH: process.env.PATH ?? "",
      GIT_DIR: "/session/.git",
      GH_REPO: "o/session",
    };
    const r = await launcher().launch({
      ...printsEnv(),
      environment: session,
      category: "user-shell",
    });
    const env = parsed(r.stdout);
    expect(env.GIT_DIR).toBe("/session/.git");
    expect(env.GH_REPO).toBe("o/session");
    expect(env.KEPT).toBeUndefined();
  });
});

describe("the variables that name a repository", () => {
  // [LAW:one-source-of-truth] git's part is git's, read when git changes: a
  // git that adds a repository-local name fails here, not in a session.
  it("hold every name the installed git clears", () => {
    const gits = execFileSync("git", ["rev-parse", "--local-env-vars"], {
      encoding: "utf8",
    })
      .split("\n")
      .filter((name) => name !== "");
    expect(gits.length).toBeGreaterThan(0);
    const named: readonly string[] = REPOSITORY_NAMING_ENV;
    expect(gits.filter((name) => !named.includes(name))).toEqual([]);
  });

  // So a list synced to git's output cannot lose the forges' names.
  it("hold each forge CLI's repository variable", () => {
    expect(REPOSITORY_NAMING_ENV).toEqual(
      expect.arrayContaining(["GH_REPO", "GITLAB_REPO"]),
    );
  });
});

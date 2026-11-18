// A daemon is spawned by whichever shell missed it, so its environment can
// carry a variable that locates a repository (a hook's GIT_DIR). Its world is
// built without the variables git names, so a session's git read answers for
// the session's directory, whatever repo the spawning shell was in.
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GitService } from "../src/daemon/cache/git-service";
import { daemonWorld, type World } from "../src/host";
import { askGitEnv } from "../src/proc/git-env-ask";
import { hostOf, worldOf } from "./helpers/host";

const run = (cmd: string, cwd: string): void => {
  execSync(cmd, { cwd, stdio: "pipe" });
};

let root: string;
let a: string;
let b: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "candybar-git-env-"));
  for (const [name, branch] of [
    ["a", "alpha"],
    ["b", "beta"],
  ] as const) {
    const repo = join(root, name);
    mkdirSync(repo);
    run(`git init -q -b ${branch}`, repo);
    run("git -c user.email=t@t.t -c user.name=t commit -q --allow-empty -m init", repo);
  }
  a = join(root, "a");
  b = join(root, "b");
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

// A spawning shell whose environment locates repo a.
const spawnedFromA = (): World =>
  worldOf(hostOf({ ...process.env, GIT_DIR: join(a, ".git") }));

async function branchOf(world: World, dir: string): Promise<string> {
  const info = await new GitService(world.launcher).getGitInfo(dir);
  if (info.kind !== "ok") throw new Error(`no git read of ${dir}: ${info.kind}`);
  return info.value.branch;
}

test("a session's read in repo b answers beta, though the daemon was spawned with GIT_DIR naming repo a", async () => {
  // Asked as the daemon asks: over the spawning shell's own world.
  const ask = askGitEnv(spawnedFromA().launcher);
  expect(ask.kind === "asked" && ask.names.includes("GIT_DIR")).toBe(true);
  const names = ask.kind === "asked" ? ask.names : [];
  expect(await branchOf(daemonWorld(spawnedFromA(), names), b)).toBe("beta");
});

// The case can fail: the spawning shell's environment as given answers for a.
test("the same read over the spawning shell's environment as given answers alpha", async () => {
  expect(await branchOf(spawnedFromA(), b)).toBe("alpha");
});

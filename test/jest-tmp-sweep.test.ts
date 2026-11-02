// [LAW:verifiable-goals] The sweep that global teardown runs over jest's own
// temporary directories: a directory's name says the worker that made it, and a
// live process's directory is never removed.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { sweepJestTmp } from "./global-teardown";
import { JEST_TMP_PREFIX, jestTmpDir, jestTmpOwner } from "./helpers/jest-tmp";

describe("the sweep over jest's directories", () => {
  let root: string;

  const dirNamed = (name: string): string => {
    mkdirSync(path.join(root, name));
    return name;
  };
  const ownedBy = (pid: number): string =>
    dirNamed(`${JEST_TMP_PREFIX}state-${pid}-a-uuid`);

  // Exited by the time this returns, so nothing holds its pid.
  const deadPid = (): number =>
    spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" }).pid;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "cc-candybar-sweep-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("a directory's name says the worker that made it, or says none", () => {
    expect(jestTmpOwner(`${JEST_TMP_PREFIX}state-4242-a-uuid`)).toBe(4242);
    expect(jestTmpOwner(`${JEST_TMP_PREFIX}daemon-pool`)).toBeNull();
    expect(jestTmpOwner(path.basename(jestTmpDir("state")))).toBe(process.pid);
  });

  test("keeps another live process's directory and removes the rest", () => {
    const another = ownedBy(process.ppid);
    const dead = ownedBy(deadPid());
    const own = ownedBy(process.pid);
    const unnamed = dirNamed(`${JEST_TMP_PREFIX}a-uuid`);
    const unrelated = dirNamed("something-else");

    sweepJestTmp(root, process.pid);

    expect(readdirSync(root).sort()).toEqual([another, unrelated].sort());
    for (const gone of [dead, own, unnamed])
      expect(existsSync(path.join(root, gone))).toBe(false);
  });
});

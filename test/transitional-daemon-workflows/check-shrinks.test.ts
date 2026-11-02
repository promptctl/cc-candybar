import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { addedEntries } from "../../scripts/check-shrinks.cjs";

// The shrink-only check the Test job runs on a pull request, against a real
// git history where the working clone is shallow and lacks the base commit, the
// way CI's checkout does.

const SCRIPT = resolve(__dirname, "../../scripts/check-shrinks.cjs");
const LIST = "excused.json";

function git(cwd: string, ...args: string[]): string {
  const run = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (run.status !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr}`);
  return run.stdout.trim();
}

function commit(cwd: string, entries: string[] | null, message: string): string {
  if (entries !== null) writeFileSync(join(cwd, LIST), JSON.stringify(entries));
  git(cwd, "add", "-A");
  git(cwd, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
}

describe("addedEntries", () => {
  test.each([
    [["a", "b"], ["a"], []],
    [["a"], ["a"], []],
    [["a"], ["a", "b"], ["b"]],
    [[], ["x"], ["x"]],
  ])("base %j, head %j", (base, head, added) => {
    expect(addedEntries(base, head)).toEqual(added);
  });
});

describe("check-shrinks.cjs on a shallow clone", () => {
  let dir: string;
  let origin: string;
  let clone: string;
  let withEntries: string;
  let withoutList: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "check-shrinks-"));
    origin = join(dir, "origin");
    clone = join(dir, "clone");
    git(dir, "init", "-q", origin);
    withoutList = commit(origin, null, "before the list");
    withEntries = commit(origin, ["a", "b"], "the list");
    commit(origin, ["a", "b", "c"], "head grows");
    git(dir, "clone", "-q", "--depth=1", `file://${origin}`, clone);
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  function run(sha: string) {
    return spawnSync(process.execPath, [SCRIPT, LIST, sha], { cwd: clone, encoding: "utf8" });
  }

  test("the clone holds no base commit, so the script has to fetch it", () => {
    expect(spawnSync("git", ["cat-file", "-e", withEntries], { cwd: clone }).status).not.toBe(0);
  });

  test("fails on an entry the base lacks, naming it", () => {
    const result = run(withEntries);
    expect({ code: result.status, said: result.stderr.includes("grew since") && result.stderr.includes(": c.") }).toEqual({
      code: 1,
      said: true,
    });
  });

  test("passes on a base that holds the file and the head did not grow past it", () => {
    writeFileSync(join(clone, LIST), JSON.stringify(["a"]));
    expect(run(withEntries).status).toBe(0);
  });

  test("passes when the base does not hold the file yet", () => {
    expect(run(withoutList).status).toBe(0);
  });

  test("fails loudly, naming the ref, on a commit the origin does not have", () => {
    const result = run("0123456789abcdef0123456789abcdef01234567");
    expect({ code: result.status, said: result.stderr.includes("cannot read base commit 0123456789") }).toEqual({
      code: 1,
      said: true,
    });
  });
});

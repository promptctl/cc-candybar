import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

// The hook as Claude Code runs it: a process fed the tool call on stdin, in a
// project whose origin/main it probes with git. The rule's cases are in
// test/unit/e2e-checks/refusal.test.ts; this proves the shim around it, above
// all that it fails closed.

const HOOK = resolve(__dirname, "../../../.claude/hooks/e2e-signoff.mjs");

function git(cwd: string, ...args: string[]) {
  const run = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (run.status !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr}`);
}

function writeIn(root: string, rel: string, text: string) {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
}

function runHook(root: string, stdin: string, hook = HOOK) {
  return spawnSync(process.execPath, [hook], {
    input: stdin,
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: root },
  });
}

const edit = (root: string, rel: string) =>
  JSON.stringify({ tool_name: "Edit", tool_input: { file_path: join(root, rel) } });

let dirs: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "e2e-signoff-hook-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true }));
  dirs = [];
});

/** A project whose origin/main holds the sign-off file and one end-to-end test. */
function projectWithMain(): string {
  const root = tempDir();
  git(root, "init", "-q");
  writeIn(root, ".claude/e2e-signoff.json", "{}");
  writeIn(root, "test/e2e/one.test.ts", "");
  git(root, "add", "-A");
  git(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "main");
  git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
  return root;
}

describe("with an origin/main", () => {
  test("refuses an edit to a guarded path main holds, exit 2 and the reason on stderr", () => {
    const root = projectWithMain();
    const run = runHook(root, edit(root, "test/e2e/one.test.ts"));
    expect({ code: run.status, said: run.stderr.startsWith("e2e-signoff: refused") }).toEqual({ code: 2, said: true });
  });

  test("admits an edit to a guarded path main does not hold", () => {
    const root = projectWithMain();
    expect(runHook(root, edit(root, "test/e2e/two.test.ts")).status).toBe(0);
  });

  test("admits an edit outside the guarded paths", () => {
    const root = projectWithMain();
    expect(runHook(root, edit(root, "src/index.ts")).status).toBe(0);
  });
});

describe("fails closed", () => {
  test("refuses a guarded path when there is no origin/main to ask", () => {
    const root = tempDir();
    git(root, "init", "-q");
    const run = runHook(root, edit(root, "test/e2e/one.test.ts"));
    expect({ code: run.status, said: run.stderr.includes("no origin/main") }).toEqual({ code: 2, said: true });
  });

  test("refuses input that is not a tool call", () => {
    const root = projectWithMain();
    expect(runHook(root, "not json").status).toBe(2);
  });

  test("refuses when the rule module cannot load", () => {
    const root = tempDir();
    mkdirSync(join(root, ".claude/hooks"), { recursive: true });
    copyFileSync(HOOK, join(root, ".claude/hooks/e2e-signoff.mjs"));
    writeIn(root, "test/e2e-checks/refusal.cjs", 'throw new Error("boom");');
    const run = runHook(root, edit(root, "src/index.ts"), join(root, ".claude/hooks/e2e-signoff.mjs"));
    expect({ code: run.status, said: run.stderr.includes("boom") }).toEqual({ code: 2, said: true });
  });
});

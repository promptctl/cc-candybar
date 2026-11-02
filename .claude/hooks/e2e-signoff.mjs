#!/usr/bin/env node
// PreToolUse hook: the refusal behind the end-to-end cap and assertion limit.
// An agent may not edit the sign-off file, the checks that read it, their tests
// and fixtures, this hook, or an end-to-end test, once origin/main holds the file.
// The rule is test/e2e-checks/refusal.cjs; this shim supplies the one effect, the
// origin/main probe, and fails closed: any error, an unreadable input, a broken
// rule module, an origin/main it cannot read, exits 2 and refuses. Exit 1 would
// only warn and let the edit through.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

function refuse(reason) {
  console.error(`e2e-signoff: refused — ${reason}`);
  process.exit(2);
}

function mainHolds(root, rel) {
  const main = spawnSync("git", ["-C", root, "rev-parse", "--verify", "--quiet", "origin/main^{commit}"]);
  if (main.status !== 0) throw new Error(`no origin/main in ${root}, so it cannot be told whether main holds ${rel}`);
  return spawnSync("git", ["-C", root, "cat-file", "-e", `origin/main:${rel}`]).status === 0;
}

try {
  const call = JSON.parse(readFileSync(0, "utf8"));
  const root = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  const { refusalOf } = createRequire(import.meta.url)("../../test/e2e-checks/refusal.cjs");
  const reason = refusalOf({
    tool: call.tool_name,
    input: call.tool_input ?? {},
    root,
    mainHolds: (rel) => mainHolds(root, rel),
  });
  if (reason !== null) refuse(reason);
} catch (error) {
  refuse(`the guard failed (${error.message}), so the edit cannot be judged`);
}

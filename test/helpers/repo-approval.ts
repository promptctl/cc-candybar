// [LAW:single-enforcer] A test's answer for a repository's cc-candybar config,
// recorded where the daemon reads it — the state directory the test's env
// names (test/setup.ts isolates it per test file) — through the daemon's own
// recording, so no test spells the book's path or shape.

import fs from "node:fs";
import { recordAnswer, repoConfigs } from "../../src/daemon/repo-configs";
import { stateDir } from "../../src/daemon/paths";
import type { RepoAnswer } from "../../src/config/loader/repo-gate";

export function answerRepo(
  dir: string,
  answer: RepoAnswer = "approved",
  env: NodeJS.ProcessEnv = process.env,
): void {
  const filed = recordAnswer(
    repoConfigs(stateDir(env)),
    fs.realpathSync.native(dir),
    answer,
  );
  if (filed.kind === "failed") throw new Error(filed.reason);
}

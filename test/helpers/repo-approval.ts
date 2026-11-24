// [LAW:single-enforcer] A test's answer for a repository's cc-candybar config,
// recorded where the daemon reads it — the state directory the test's env
// names (test/setup.ts isolates it per test file) — through the daemon's own
// recording, so no test spells the book's path or shape.

import { writeStatePlan } from "./state-file";
import fs from "node:fs";
import { hostOf } from "./host";
import {
  answering,
  type Recorded,
  repoConfigs,
} from "../../src/daemon/config-discovery/repo-configs";
import { stateDir } from "../../src/daemon/paths";
import type { StateFile } from "../../src/daemon/state-file";
import { ok, type Asked } from "../../src/utils/outcome";
import type {
  RepoAnswer,
  RepoConfigBook,
} from "../../src/config/loader/repo-gate";

export function answerRepo(
  dir: string,
  answer: RepoAnswer = "approved",
  env: NodeJS.ProcessEnv = process.env,
): void {
  const filed = recordAnswer(
    repoConfigs(stateDir(hostOf(env))),
    fs.realpathSync.native(dir),
    answer,
  );
  if (filed.kind === "failed") throw new Error(filed.reason);
}

export function recordAnswer(
  store: StateFile<RepoConfigBook>,
  dir: string,
  answer: RepoAnswer,
): Asked<Recorded> {
  let recorded: Recorded = { superseded: [], absent: [], unchecked: [] };
  const filed = writeStatePlan(
    store.plan((book) => {
      const answered = answering(book, dir, answer);
      recorded = answered.recorded;
      return answered.book;
    }),
  );
  return filed.kind === "failed" ? filed : ok(recorded);
}

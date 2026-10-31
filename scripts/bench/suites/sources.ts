// The reads a render waits on: what git says about a checkout, and what a
// session's transcript says about its usage. Timed in-process, on the owner of
// each read, with no daemon in the way: when a cold bar is slow these say
// whether a source is why.
//
// Every sample is checked against what the fixture holds, so a read that
// returned early, empty or stale is a failure and not a fast sample.

import path from "node:path";

import { SessionUsageStore } from "../../../src/daemon/cache/session-usage-store.js";
import { processLauncher } from "../../../src/proc/launch.js";
import { GitService } from "../../../src/segments/git.js";
import { hookData } from "../../lib/hook-data.js";
import {
  appendTurn,
  makeRepo,
  removeTree,
  scratchDir,
  writeTranscript,
  type RepoShape,
} from "../fixtures.js";
import { repeat } from "../measure.js";
import { measured, type Benchmark } from "../types.js";
import fs from "node:fs";

const SESSION = "bench-usage";

// Everything the richest preset asks git: the heaviest read the daemon makes.
const EVERYTHING = {
  showSha: true,
  showWorkingTree: true,
  showOperation: true,
  showTag: true,
  showCommittedAt: true,
  showStashCount: true,
  showUpstream: true,
  showRepoName: true,
  showRepoUrl: true,
} as const;

const REPOS: ReadonlyArray<readonly [string, RepoShape, number]> = [
  ["small", { files: 100, commits: 20, modified: 5, untracked: 3 }, 40],
  ["large", { files: 10_000, commits: 50, modified: 200, untracked: 100 }, 20],
];

const gitBenchmark = ([name, shape, samples]: (typeof REPOS)[number]): Benchmark => ({
  id: `sources.git.${name}`,
  group: "sources",
  about: `every git fact the bundled presets ask, read from a checkout of ${shape.files} files with ${shape.modified} modified and ${shape.untracked} untracked (git spawned as the daemon spawns it)`,
  samples,
  async run(plan) {
    const root = scratchDir("ccbn-git");
    try {
      const repo = path.join(root, "repo");
      makeRepo(repo, shape);
      const service = new GitService(processLauncher);
      const ms = await repeat(plan.samples, async () => {
        const info = await service.getGitInfo(repo, EVERYTHING);
        // [LAW:no-silent-failure] A read that failed, or saw a tree other
        // than the fixture's, is not a fast read.
        if (info.kind !== "ok") {
          throw new Error(`git read ended ${JSON.stringify(info)}`);
        }
        const tree = info.value.workingTree;
        if (
          info.value.branch !== "main" ||
          tree?.unstaged !== shape.modified ||
          tree.untracked !== shape.untracked
        ) {
          throw new Error(
            `git read a tree other than the fixture's: ${JSON.stringify(info.value)}`,
          );
        }
      });
      return measured([{ name: "read", samples: ms }], { files: shape.files });
    } finally {
      removeTree(root);
    }
  },
});

// Output tokens the fixture's first `turns` turns hold (transcriptTurn writes
// 300 + t on turn t): what a fold that read the whole file sums to.
const outputTokens = (turns: number): number =>
  300 * turns + (turns * (turns - 1)) / 2;

// [LAW:no-silent-failure] Folds the transcript and checks the fold saw all of
// it, so a short or empty read cannot pass for a fast one.
async function folded(
  store: SessionUsageStore,
  cwd: string,
  transcript: string,
  turns: number,
): Promise<void> {
  const usage = await store
    .request(SESSION, transcript)
    .usage(hookData(cwd, transcript));
  if (usage.kind !== "ok") {
    throw new Error(`usage fold ended ${JSON.stringify(usage)}`);
  }
  const output = usage.value.session?.tokenBreakdown?.output;
  if (output !== outputTokens(turns)) {
    throw new Error(
      `usage fold summed ${output} output tokens over a transcript of ${turns} turns, which hold ${outputTokens(turns)}`,
    );
  }
}

const COLD_TURNS: ReadonlyArray<readonly [number, number]> = [
  [100, 20],
  [1_700, 10],
  [20_000, 4],
];

const coldFold = ([turns, samples]: (typeof COLD_TURNS)[number]): Benchmark => ({
  id: `sources.usage.cold.${turns}`,
  group: "sources",
  about: `a session's first fold of a transcript of ${turns} turns (~${turns * 3} lines), by a store that has never read it`,
  samples,
  async run(plan) {
    const root = scratchDir("ccbn-usage");
    try {
      const transcript = path.join(root, "t.jsonl");
      writeTranscript(transcript, SESSION, root, turns);
      const ms = await repeat(plan.samples, async () => {
        const store = new SessionUsageStore({ sweepIntervalMs: 0 });
        await folded(store, root, transcript, turns);
      });
      return measured([{ name: "fold", samples: ms }], {
        bytes: fs.statSync(transcript).size,
      });
    } finally {
      removeTree(root);
    }
  },
});

const WARM_TURNS = 1_700;

const warmFold = (
  id: string,
  about: string,
  samples: number,
  // Whether Claude Code has written another turn since the last fold.
  appends: boolean,
): Benchmark => ({
  id,
  group: "sources",
  about,
  samples,
  async run(plan) {
    const root = scratchDir("ccbn-usage");
    try {
      const transcript = path.join(root, "t.jsonl");
      writeTranscript(transcript, SESSION, root, WARM_TURNS);
      const store = new SessionUsageStore({ sweepIntervalMs: 0 });
      let turns = WARM_TURNS;
      await folded(store, root, transcript, turns);
      // The writer's cost stays out of the timed fold.
      const ms = await repeat(
        plan.samples,
        () => folded(store, root, transcript, turns),
        () => {
          if (appends) appendTurn(transcript, SESSION, root, turns++);
        },
      );
      return measured([{ name: "fold", samples: ms }]);
    } finally {
      removeTree(root);
    }
  },
});

export const SOURCES: readonly Benchmark[] = [
  ...REPOS.map(gitBenchmark),
  ...COLD_TURNS.map(coldFold),
  warmFold(
    "sources.usage.append",
    `a fold of a ${WARM_TURNS}-turn transcript after Claude Code appended one turn: the bytes since the last read are all it reads`,
    50,
    true,
  ),
  warmFold(
    "sources.usage.hit",
    `a fold of a ${WARM_TURNS}-turn transcript that has not changed: the stamp matches and nothing is read`,
    200,
    false,
  ),
];

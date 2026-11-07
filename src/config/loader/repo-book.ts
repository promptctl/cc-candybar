// [LAW:effects-at-boundaries] Where the user's answers to "run this
// repository's cc-candybar config?" are kept, and how a config load reads
// them: over a disk that cannot write. Recording an answer is the daemon's
// (src/daemon/repo-configs.ts); the gate the answers decide is pure
// (./repo-gate.ts).

import path from "node:path";
import type { FilesystemReads } from "../../disk/filesystem.js";
import { readStateFile } from "../../disk/state-file.js";
import { parseRepoConfigBook, type RepoAnswers } from "./repo-gate.js";

export const REPO_CONFIGS_FILE = "repo-configs.json";
// The book's own folder: the daemon watches it so a hand edit (removing an
// entry to be asked again) reaches every bar, and the state directory itself
// holds the log, which writes on every request — a watch there wakes on each
// line.
const REPO_CONFIGS_DIR = "repo-configs";

// [LAW:one-source-of-truth] One book per user, under the state directory:
// an answer given in one session holds in every other, and after a restart.
export function repoConfigsDir(stateDir: string): string {
  return path.join(stateDir, REPO_CONFIGS_DIR);
}

export function repoConfigsPath(stateDir: string): string {
  return path.join(repoConfigsDir(stateDir), REPO_CONFIGS_FILE);
}

// [LAW:one-source-of-truth] The book in its folder is the answers. One kept
// directly in the state directory, where the book used to live, is read only
// while the folder holds none, and the first answer recorded writes it into
// the folder with that answer: nothing is moved, so no answer is lost to a
// move, and every reader — the daemon, `check`, the demo — reads the same
// answers. `true` when the folder's book is the one.
// [LAW:no-silent-failure] Only ENOENT is no book in the folder: a stat that
// cannot see it reads it, and the read names what stopped it.
export function bookIsFiled(reads: FilesystemReads, stateDir: string): boolean {
  try {
    reads.statSync(repoConfigsPath(stateDir));
    return true;
  } catch (e) {
    return (e as { code?: string }).code !== "ENOENT";
  }
}

// The answers a load runs under: the folder's book, else the loose one.
export function readRepoAnswers(
  reads: FilesystemReads,
  stateDir: string,
): RepoAnswers {
  return readStateFile(
    reads,
    bookIsFiled(reads, stateDir)
      ? repoConfigsPath(stateDir)
      : path.join(stateDir, REPO_CONFIGS_FILE),
    {},
    parseRepoConfigBook,
  );
}

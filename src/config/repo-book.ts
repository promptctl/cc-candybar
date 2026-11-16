// [LAW:one-source-of-truth] Where the user's answers to "run this
// repository's cc-candybar config?" are kept. Every reader reads them here:
// the render, `check`, the doctor. Only the host writes them
// (src/daemon/repo-book.ts), as the `approve-repo` effect a click returns.

import fs from "node:fs";
import path from "node:path";
import {
  parseRepoConfigBook,
  type RepoConfigBook,
} from "./loader/repo-gate.js";
import { stateFile, type StateFile } from "../doctor/state-file.js";

const REPO_CONFIGS_FILE = "repo-configs.json";
// The book's own folder: the daemon watches it so a hand edit (removing an
// entry to be asked again) reaches every bar, and the state directory itself
// holds the log, which writes on every request — a watch there wakes on each
// line.
const REPO_CONFIGS_DIR = "repo-configs";

// [LAW:one-source-of-truth] One book per user, under the state directory:
// an answer given in one session holds in every other, and after a restart.
export function repoConfigsDir(dir: string): string {
  return path.join(dir, REPO_CONFIGS_DIR);
}

export function repoConfigsPath(dir: string): string {
  return path.join(repoConfigsDir(dir), REPO_CONFIGS_FILE);
}

// [LAW:one-source-of-truth] The book in its folder is the answers. One kept
// directly in the state directory, where the book used to live, is read
// only while the folder holds none, and the first answer recorded writes it
// into the folder with that answer: nothing is moved, so no answer is lost
// to a move, and every reader — the daemon, `check`, the doctor — reads the
// same answers.
export const repoConfigs = (dir: string): StateFile<RepoConfigBook> => {
  const book = stateFile(
    repoConfigsDir(dir),
    REPO_CONFIGS_FILE,
    {},
    parseRepoConfigBook,
  );
  const loose = stateFile(dir, REPO_CONFIGS_FILE, {}, parseRepoConfigBook);
  const filed = (): boolean => fs.existsSync(repoConfigsPath(dir));
  return {
    read: () => (filed() ? book : loose).read(),
    update: (next) => {
      if (filed()) return book.update(next);
      const kept = loose.read();
      if (kept.kind === "failed") return kept;
      return book.update(() => next(kept.value));
    },
  };
};

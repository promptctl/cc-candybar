// The real adapters a daemon is built with: the one module that names them.
// [LAW:single-enforcer] A process, a test's worker and the page in site/ each
// build their daemon over these or over fakes of them, and `createDaemon` names
// none (eslint.config.mjs lets only this file construct each).

import { userInfo } from "node:os";
import { SESSION_BOOK_FILE } from "./session-book.js";
import { openRecordingFile } from "./recording-file.js";
import { SessionFile } from "./session-state-file.js";
import fs from "node:fs";
import { productionClaudeInputEdge } from "../claude-input/edge.js";
import { systemLauncher } from "../proc/system-launcher";
import { reporting, type Timekeeper } from "../time";
import type { DaemonAdapters } from "./daemon.js";
import { fileStorage } from "./file-storage";
import { productionBarPaneEdge } from "./lane-edge.js";
import { linkKeyFile, linkKeyFromFile } from "./link-key.js";
import { realLimitsDeps } from "./limits";
import type { DaemonLog } from "./log";
import { profilePaths, type DaemonPaths } from "./paths";
import { checkoutFiles } from "../utils/git-root.js";
import { writeConfigFile } from "./file-rewrites.js";

// [LAW:effects-at-boundaries] Every real adapter, over the paths and the log it
// is given, so a daemon built over a temporary directory touches nothing else.
// `machine` is the clock the machine's side runs on: real children, real files
// and the log's blocking wait live in real time, whatever clock the daemon
// itself is held on. Each adapter runs its tasks on it through the daemon's
// `report`, as the daemon's own pieces run theirs.
export function productionAdapters(
  paths: DaemonPaths,
  daemonLog: DaemonLog,
  machine: Timekeeper,
): DaemonAdapters {
  let accountHome: string | undefined;
  return {
    openRecording: openRecordingFile,
    accountHome: () => (accountHome ??= userInfo().homedir),
    daemonLog,
    launcher: (own, report) => systemLauncher(own, reporting(machine, report)),
    profile: (name, log, report) =>
      fileStorage(profilePaths(paths, name), log, reporting(machine, report)),
    sessionBook: (log, report) =>
      new SessionFile(
        SESSION_BOOK_FILE,
        paths.sessionBook,
        reporting(machine, report),
        500,
        log,
      ),
    linkKey: linkKeyFromFile(linkKeyFile(paths.state), daemonLog.log),
    claudeInput: productionClaudeInputEdge,
    barPaneEdge: productionBarPaneEdge,
    limits: ({ startedAtMs, exit, launcher, log, report }) =>
      realLimitsDeps(startedAtMs, exit, {
        launcher,
        log,
        clock: reporting(machine, report),
        snapshotDir: paths.state,
        writeLogNow: () => daemonLog.writeNow(),
      }),
    // [LAW:one-type-per-behavior] In this process: the daemon process's entry
    // (server.ts) runs it in a process of its own.
    rendererEntryOf: (reported) => {
      const entry = fs.realpathSync.native(reported);
      if (!fs.statSync(entry).isFile()) throw new Error("not a file");
      return entry;
    },
    stat: fs.statSync,
    checkoutFiles,
    writeConfigFile,
  };
}

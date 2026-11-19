// The real adapters a daemon is built with: the one module that names them.
// [LAW:single-enforcer] A process, a test's worker and the page in site/ each
// build their daemon over these or over fakes of them, and `createDaemon` names
// none (eslint.config.mjs lets only this file construct each).

import { SESSION_BOOK_FILE } from "./session-book.js";
import { SessionFile } from "./session-state-file.js";
import fs from "node:fs";
import { productionClaudeInputEdge } from "../claude-input/edge.js";
import { systemScopedReader } from "../proc/system-launcher";
import type { ReaderWorld } from "../host";
import type { DaemonAdapters } from "./daemon.js";
import { fileStorage } from "./file-storage";
import { productionBarPaneEdge } from "./lane-edge.js";
import { linkKeyFile, linkKeyFromFile } from "./link-key.js";
import { realLimitsDeps } from "./limits";
import { inProcessPort } from "./renderer-process.js";
import type { DaemonLog } from "./log";
import { profilePaths, type DaemonPaths } from "./paths";

// [LAW:effects-at-boundaries] Every real adapter, over the paths and the log it
// is given, so a daemon built over a temporary directory touches nothing else.
// `machine` is the world's clock, which the machine's side runs on: real
// children, real files and the log's blocking wait live in real time, whatever
// clock the daemon itself is held on. The world is a reader's, since the
// daemon reads sessions' repositories.
export function productionAdapters(
  paths: DaemonPaths,
  daemonLog: DaemonLog,
  { launcher: reader, clock: machine }: ReaderWorld,
): DaemonAdapters {
  return {
    daemonLog,
    // [LAW:one-source-of-truth] The daemon's launches withhold by the answer
    // the world's launcher owns, which its renderer is launched through.
    launcher: (own) => systemScopedReader(own, reader, machine),
    profile: (name, log) =>
      fileStorage(profilePaths(paths, name), log, machine),
    sessionBook: (log) =>
      new SessionFile(SESSION_BOOK_FILE, paths.sessionBook, machine, 500, log),
    linkKey: linkKeyFromFile(linkKeyFile(paths.state), daemonLog.log),
    claudeInput: productionClaudeInputEdge,
    barPaneEdge: productionBarPaneEdge,
    limits: ({ startedAtMs, exit, launcher, log }) =>
      realLimitsDeps(startedAtMs, exit, {
        launcher,
        log,
        clock: machine,
        snapshotDir: paths.state,
        writeLogNow: () => daemonLog.writeNow(),
      }),
    // [LAW:one-type-per-behavior] In this process: the daemon process's entry
    // (server.ts) runs it in a process of its own.
    renderer: inProcessPort,
    stat: fs.statSync,
  };
}

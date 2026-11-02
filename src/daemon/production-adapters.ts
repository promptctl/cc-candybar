// The real adapters a daemon is built with: the one module that names them.
// [LAW:single-enforcer] A process, a test's worker and the page in site/ each
// build their daemon over these or over fakes of them, and `createDaemon` names
// none (eslint.config.mjs lets only this file construct each).

import fs from "node:fs";
import { productionClaudeInputEdge } from "../claude-input/edge.js";
import { fileStores, productionEdge } from "../doctor/edge";
import { createLauncher } from "../proc/launch";
import type { DaemonAdapters } from "./daemon.js";
import { fileStorage } from "./file-storage";
import { productionLaneEdge } from "./lane-edge.js";
import { linkKeyFile, linkSignerFromKeyFile } from "./link-key.js";
import { realLimitsDeps } from "./limits";
import type { DaemonLog } from "./log";
import type { DaemonPaths } from "./paths";

// [LAW:effects-at-boundaries] Every real adapter, over the paths and the log it
// is given, so a daemon built over a temporary directory touches nothing else.
export function productionAdapters(
  paths: DaemonPaths,
  daemonLog: DaemonLog,
): DaemonAdapters {
  return {
    daemonLog,
    launcher: createLauncher,
    storage: (log) => fileStorage(paths, log),
    doctorStores: fileStores(paths.state),
    doctorEdge: productionEdge,
    claudeInput: productionClaudeInputEdge,
    laneEdge: productionLaneEdge,
    linkSigner: linkSignerFromKeyFile(linkKeyFile(paths.state)),
    limits: ({ startedAtMs, exit, launcher, log }) =>
      realLimitsDeps(startedAtMs, exit, {
        launcher,
        log,
        snapshotDir: paths.state,
        writeLogNow: () => daemonLog.writeNow(),
      }),
    fetch,
    stat: fs.statSync,
  };
}

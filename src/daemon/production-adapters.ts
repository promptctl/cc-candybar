// The real adapters a daemon is built with: the one module that names them.
// [LAW:single-enforcer] A process, a test's worker and the page in site/ each
// build their daemon over these or over fakes of them, and `createDaemon` names
// none (eslint.config.mjs lets only this file construct each).

import fs from "node:fs";
import path from "node:path";
import { productionClaudeInputEdge } from "../claude-input/edge.js";
import { productionMachineEdge } from "../doctor/edge";
import { systemLauncher } from "../proc/system-launcher";
import { systemProbe } from "./process-fingerprint";
import type { Timekeeper } from "../time";
import type { DaemonAdapters } from "./daemon.js";
import { productionLaneEdge } from "./lane-edge.js";
import { linkKeyFile, linkKeyFromFile } from "./link-key.js";
import { realLimitsDeps } from "./limits";
import { inProcessPort } from "./renderer-process.js";
import type { DaemonLog } from "./log";
import type { DaemonPaths } from "./paths";
import { profileStore } from "./profile-store.js";
import { SessionContexts } from "./session-contexts.js";

// [LAW:effects-at-boundaries] Every real adapter, over the paths and the log it
// is given, so a daemon built over a temporary directory touches nothing else.
// `machine` is the clock the machine's side runs on: real children, real files
// and the log's blocking wait live in real time, whatever clock the daemon
// itself is held on.
export function productionAdapters(
  paths: DaemonPaths,
  daemonLog: DaemonLog,
  machine: Timekeeper,
): DaemonAdapters {
  return {
    daemonLog,
    launcher: (own) => systemLauncher(own, machine),
    profileStore: (dir, failed, log) => profileStore(dir, machine, failed, log),
    sessionContexts: (failed, log) =>
      new SessionContexts(
        path.join(paths.state, "session-contexts.json"),
        machine,
        failed,
        log,
      ),
    linkKey: linkKeyFromFile(linkKeyFile(paths.state)),
    doctorEdge: productionMachineEdge,
    claudeInput: productionClaudeInputEdge,
    probe: systemProbe,
    laneEdge: (launcher, following, closing, probe) =>
      productionLaneEdge(launcher, following, closing, machine, probe),
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
    fetch,
    stat: fs.statSync,
  };
}

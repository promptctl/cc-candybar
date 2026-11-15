// The real adapters a daemon is built with: the one module that names them.
// [LAW:single-enforcer] A process, a test's worker and the page in site/ each
// build their daemon over these or over fakes of them, and `createDaemon` names
// none (eslint.config.mjs lets only this file construct each).

import fs from "node:fs";
import { productionClaudeInputEdge } from "../claude-input/edge.js";
import { fileStores, productionMachineEdge } from "../doctor/edge";
import { systemLauncher } from "../proc/system-launcher";
import { systemProbe } from "./process-fingerprint";
import type { Timekeeper } from "../time";
import type { DaemonAdapters } from "./daemon.js";
import { fileStorage } from "./file-storage";
import { productionLaneEdge } from "./lane-edge.js";
import { linkKeyFile, linkSignerFromKeyFile, readLinkKey } from "./link-key.js";
import { realLimitsDeps } from "./limits";
import { inProcessPort } from "./renderer-process.js";
import type { DaemonLog } from "./log";
import type { DaemonPaths } from "./paths";

// [LAW:one-source-of-truth] The files the renderer still opens itself, at
// the paths its host's own `Host` names: a renderer process builds itself from
// these, and so does the daemon whose renderer runs in process.
export function rendererAdapters(
  paths: DaemonPaths,
  machine: Timekeeper,
): Pick<DaemonAdapters, "storage" | "doctorStores"> {
  return {
    storage: (log) => fileStorage(paths, log, machine),
    doctorStores: fileStores(paths.state),
  };
}

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
    ...rendererAdapters(paths, machine),
    // [LAW:one-source-of-truth] One key file, which the host opens every
    // click with and reads afresh for each renderer it starts.
    linkSigner: linkSignerFromKeyFile(linkKeyFile(paths.state)),
    linkKey: () => readLinkKey(linkKeyFile(paths.state)),
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

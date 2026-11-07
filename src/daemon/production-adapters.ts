// The real adapters a daemon is built with: the one module that names them.
// [LAW:single-enforcer] A process, a test's worker and the page in site/ each
// build their daemon over these or over fakes of them, and `createDaemon` names
// none (eslint.config.mjs lets only this file construct each).

import { productionClaudeInputEdge } from "../claude-input/edge.js";
import { fileStores, productionEdge } from "../doctor/edge";
import { systemFilesystem } from "../disk/system-filesystem";
import { systemLauncher } from "../proc/system-launcher";
import { systemProbe } from "./process-fingerprint";
import type { Timekeeper } from "../time";
import type { DaemonAdapters } from "./daemon.js";
import { fileStorage } from "./file-storage";
import { heldSessionUnder, productionLaneEdge } from "./lane-edge.js";
import { linkKeyFile, linkSignerFromKeyFile } from "./link-key.js";
import { livePricing } from "../segments/pricing.js";
import { realLimitsDeps } from "./limits";
import type { DaemonLog } from "./log";
import type { DaemonPaths } from "./paths";

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
    storage: (log) => fileStorage(paths, log, machine),
    doctorStores: fileStores(paths.state),
    doctorEdge: productionEdge,
    claudeInput: productionClaudeInputEdge,
    probe: systemProbe,
    laneEdge: (launcher, following, closing, probe, heldSession) =>
      productionLaneEdge(
        launcher,
        following,
        closing,
        machine,
        probe,
        heldSession,
      ),
    heldSession: heldSessionUnder,
    linkSigner: linkSignerFromKeyFile(linkKeyFile(paths.state)),
    limits: ({ startedAtMs, exit, launcher, log }) =>
      realLimitsDeps(startedAtMs, exit, {
        launcher,
        log,
        clock: machine,
        snapshotDir: paths.state,
        writeLogNow: () => daemonLog.writeNow(),
      }),
    fetch,
    pricing: (own) => livePricing({ ...own, clock: machine }),
    filesystem: systemFilesystem,
  };
}

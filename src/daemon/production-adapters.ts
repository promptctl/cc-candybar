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
import { productionLaneEdge } from "./lane-edge.js";
import { realLimitsDeps, type LimitsDeps } from "./limits";
import { fileStorage } from "./file-storage";
import { linkKeyFile, linkSignerFromKeyFile } from "./link-key.js";
import type { RendererBoot } from "../renderer-interface/boot.js";
import type { MainRendererInputs } from "../renderer/main.js";
import type { Launcher } from "../proc/launcher";
import type { DaemonLogger } from "../utils/logger";
import { processRenderers } from "./renderer-links.js";
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
    renderers: processRenderers(paths),
    doctorStores: fileStores(paths.state),
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
    fetch,
    stat: fs.statSync,
  };
}

// [LAW:effects-at-boundaries] The real adapters a renderer's process is built
// over, at the paths its boot names: the files it keeps, the signer of its
// links, and what its memory backstop reads and writes.
export function rendererProcessAdapters(
  boot: RendererBoot,
  log: DaemonLogger,
  machine: Timekeeper,
  launcher: Launcher,
): Pick<MainRendererInputs, "storage" | "linkSigner"> & {
  readonly limits: (exit: (code: number) => void) => LimitsDeps;
} {
  return {
    storage: {
      ...fileStorage(boot, log, machine),
      doctor: fileStores(boot.stateDir),
    },
    linkSigner: linkSignerFromKeyFile(linkKeyFile(boot.stateDir)),
    limits: (exit) =>
      realLimitsDeps(machine.now(), exit, {
        launcher,
        log,
        clock: machine,
        snapshotDir: boot.stateDir,
        // The renderer writes no log of its own: its lines are the host's.
        writeLogNow: () => {},
      }),
  };
}

// [LAW:one-source-of-truth] The tests' one composition root for a daemon in a
// jest worker. It is the shell a process puts over the daemon, and no more: the
// request handling is the daemon's and a connection is `handleConnection`, so
// the render a test reads is the one a client reads. What a test talks to it
// through is daemon-e2e's helpers, which take this in place of a socket path.

import fs from "node:fs";
import path from "node:path";
import type { Duplex } from "node:stream";
import { pathToFileURL } from "node:url";

import { handleConnection } from "../../src/daemon/connection";
import {
  createDaemon,
  SYSTEM_CLOCK,
  type Daemon,
  type DaemonInputs,
  type DaemonStorage,
  type RunningBundle,
} from "../../src/daemon/daemon";
import { memoryLimitBytes } from "../../src/daemon/limits";
import { fileStorage } from "../../src/daemon/file-storage";
import { drained } from "../../src/daemon/log";
import { logPath, stateDir } from "../../src/daemon/paths";
import { sendOne, type Request } from "../../src/daemon/protocol";
import type { DaemonLogger } from "../../src/utils/logger";
import type { DaemonEndpoint } from "./daemon-wire";
import { memoryConnection } from "./memory-connection";

export type DaemonOverrides = Partial<Omit<DaemonInputs, "storage">> & {
  readonly storage?: (log: DaemonLogger) => Partial<DaemonStorage>;
};

// A bundle at `checkout`, which need not exist: nothing runs it unless a case
// lays one down there.
export function bundleAt(checkout: string): RunningBundle {
  const file = path.join(checkout, "dist", "index.mjs");
  return {
    entryUrl: pathToFileURL(file).href,
    path: file,
    node: [process.execPath],
    targets: [file],
  };
}

// A daemon built as a process builds one, unarmed. Arming is a process's: the
// memory backstop and the bundle watch end a daemon through `exit`, on the
// worker's own memory and a bundle that isn't running. It also starts file-event
// delivery, whose period drives the watcher's judge and the catch-up reload, so
// a daemon here hears a watch only by a delivered event, which is what a watcher
// case proves. Delivery unstarted is `unmeasured` with nothing missed, and adds
// no warning (src/daemon/cache/file-events.ts).
export function buildDaemon(overrides: DaemonOverrides = {}): Daemon {
  fs.mkdirSync(stateDir(), { recursive: true });
  return createDaemon({
    bundle: bundleAt(path.join(stateDir(), "checkout")),
    memoryLimitBytes: memoryLimitBytes(process.env),
    // test/setup.ts points it at a closed port.
    registryUrl: process.env.CC_CANDYBAR_REGISTRY_URL!,
    clock: SYSTEM_CLOCK,
    // [LAW:no-silent-failure] Nothing here should end a worker, so a reply that
    // carries an exit is loud. A case about the exit passes its own.
    exit: (code) => {
      throw new Error(`a daemon under test asked to exit ${code}`);
    },
    ...overrides,
    storage: (log) => ({
      ...fileStorage(log),
      ...overrides.storage?.(log),
    }),
  });
}

export interface InWorkerDaemon extends DaemonEndpoint {
  readonly daemon: Daemon;
  // A client's end of a new connection.
  connect(): Duplex;
  stop(): Promise<void>;
}

// What a spawned daemon is given is its whole environment, so a key `env` leaves
// out is unset here too.
function placeEnv(env: NodeJS.ProcessEnv): void {
  const placed = { ...env };
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, placed);
}

// A daemon serving this worker, placed by `env`: a daemon's paths are read from
// the environment when it writes, so the env a spawned daemon would be given is
// this file's own until `stop`. One test file's `process.env` is its own, and a
// process holds one live daemon, so a second start before a stop is refused.
export function startDaemon(
  env: NodeJS.ProcessEnv,
  overrides: DaemonOverrides = {},
): InWorkerDaemon {
  const before = { ...process.env };
  placeEnv(env);
  const daemon = buildDaemon(overrides);
  const open = new Set<Duplex>();

  const connect = (): Duplex => {
    const { daemonEnd, client } = memoryConnection();
    open.add(daemonEnd);
    daemonEnd.once("close", () => open.delete(daemonEnd));
    handleConnection(daemon, daemonEnd);
    return client;
  };

  return {
    daemon,
    log: logPath(),
    connect,
    send: (req, budgetMs) =>
      sendOne(connect(), req as unknown as Request, Date.now() + budgetMs),
    // [LAW:single-enforcer] A close leaves a connection open because a process's
    // exit ends it, so here the shell's end does: a subscriber hears the daemon
    // go, and a request's backstop goes with its stream. What is logged by now
    // is awaited before the env goes back, because the log reads its path when
    // it writes. Nothing says a closed daemon's work has settled, so this waits
    // for none of it: its launches are refused, by its own launcher, and a line
    // of its says it came after the close, whichever log the env names by then.
    stop: async () => {
      daemon.close();
      for (const end of open) end.destroy();
      await drained();
      placeEnv(before);
    },
  };
}

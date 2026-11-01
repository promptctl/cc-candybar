// [LAW:one-source-of-truth] The tests' one composition root for a daemon in a
// jest worker. It is the shell a process puts over the daemon, and no more: the
// request handling is the daemon's and a connection is `handleConnection`, so
// the render a test reads is the one a client reads. What a test talks to it
// through is daemon-e2e's helpers, which take this in place of a socket path.

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import type { Duplex } from "node:stream";
import { pathToFileURL } from "node:url";

import { handleConnection } from "../../src/daemon/connection";
import {
  createDaemon,
  SYSTEM_CLOCK,
  type Daemon,
  type DaemonClock,
  type DaemonInputs,
  type DaemonStorage,
  type RunningBundle,
} from "../../src/daemon/daemon";
import { memoryLimitBytes } from "../../src/daemon/limits";
import { fileStorage } from "../../src/daemon/file-storage";
import { drained } from "../../src/daemon/log";
import { logPath, stateDir } from "../../src/daemon/paths";
import { PROTOCOL_VERSION, sendOne, type Request } from "../../src/daemon/protocol";
import type { StatsSnapshot } from "../../src/daemon/stats";
import { reserveUpdateKeys } from "../../src/daemon/update-notice";
import type { DaemonLogger } from "../../src/utils/logger";
import type { DaemonEndpoint } from "./daemon-wire";
import type { StartBarDaemon } from "./drive-bar";
import { memoryConnection } from "./memory-connection";

export type DaemonOverrides = Partial<Omit<DaemonInputs, "storage">> & {
  readonly storage?: (log: DaemonLogger) => Partial<DaemonStorage>;
};

// A bundle at `checkout`, which need not exist: nothing runs it unless a case
// lays one down there.
export function bundleAt(
  checkout: string,
  digest: string | null = null,
): RunningBundle {
  const file = path.join(checkout, "dist", "index.mjs");
  return {
    entryUrl: pathToFileURL(file).href,
    digest,
    path: file,
    node: [process.execPath],
    targets: [file],
  };
}

// A clock a test moves by hand. Both of its readings stand still until then, so
// it belongs on a daemon its case owns, whose clients state their deadlines on
// it: a request's budget is that deadline less this clock's arrival.
export interface HeldClock extends DaemonClock {
  advance(ms: number): void;
}

export function heldClock(start: Date = new Date()): HeldClock {
  let elapsed = 0;
  return {
    date: () => new Date(start.getTime() + elapsed),
    monotonic: () => elapsed,
    advance: (ms) => {
      elapsed += ms;
    },
  };
}

// A daemon built as a process builds one, unarmed unless its case arms it: the
// memory backstop and the bundle watch would end it on the worker's own memory
// and a bundle that isn't running. Arming also starts file-event delivery, whose
// period drives the watcher's judge and the catch-up reload, so a daemon here
// hears a watch only by a delivered event, which is what a watcher case proves.
// Delivery unstarted is `unmeasured` with nothing missed, and adds no warning
// (src/daemon/cache/file-events.ts).
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

// The daemon's counts from its request handling, past the connection: the 200 ms
// guard is the connection's, and a busy machine is no fact about them.
export async function statsOf(daemon: Daemon): Promise<StatsSnapshot> {
  const { resp } = await daemon.reply(
    { v: PROTOCOL_VERSION, kind: "stats" },
    () => false,
    daemon.clock.monotonic(),
  );
  if (!resp.ok || !("stats" in resp)) throw new Error(`stats failed: ${JSON.stringify(resp)}`);
  return resp.stats;
}

export interface InWorkerDaemon extends DaemonEndpoint {
  readonly daemon: Daemon;
  // A client's end of a new connection.
  connect(): Duplex;
  // Serves a real socket too, for a client that opens one itself: the frame
  // stream, and the doctor's CLI. Each connection is the daemon's own, as one
  // from `connect` is.
  listen(sockPath: string): Promise<void>;
  stop(): Promise<void>;
}

// What a spawned daemon is given is its whole environment, so a key `env` leaves
// out is unset here too.
function placeEnv(env: NodeJS.ProcessEnv): void {
  const placed = { ...env };
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, placed);
}

// A daemon a case arms, for what only an armed daemon does: the update notice.
// Its memory backstop and bundle watch end a daemon through `exit`, so they get
// nothing to act on: no file to stat, and a limit past any worker's memory.
export function startArmedDaemon(
  env: NodeJS.ProcessEnv,
  bundle: RunningBundle,
): InWorkerDaemon {
  const started = startDaemon(env, {
    bundle: { ...bundle, targets: [] },
    memoryLimitBytes: Number.MAX_SAFE_INTEGER,
  });
  started.daemon.arm();
  return started;
}

// A bar on a daemon in this worker (test/helpers/drive-bar.ts).
export const startBarDaemon: StartBarDaemon = async (env) => {
  const daemon = startDaemon(env);
  return { target: daemon, stop: daemon.stop };
};

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
  let daemon: Daemon;
  try {
    daemon = buildDaemon(overrides);
  } catch (e) {
    // A daemon already live here reads its paths from this env.
    placeEnv(before);
    throw e;
  }
  // A booted daemon holds these from arming, so every config's gate here is
  // built against them too.
  const releaseUpdateKeys = reserveUpdateKeys();
  const open = new Set<Duplex>();
  const servers: net.Server[] = [];

  const serve = (end: Duplex): void => {
    open.add(end);
    end.once("close", () => open.delete(end));
    handleConnection(daemon, end);
  };

  const connect = (): Duplex => {
    const { daemonEnd, client } = memoryConnection();
    serve(daemonEnd);
    return client;
  };

  return {
    daemon,
    log: logPath(),
    now: () => daemon.clock.date().getTime(),
    connect,
    listen: (sockPath) =>
      new Promise((resolve, reject) => {
        const server = net.createServer(serve);
        servers.push(server);
        server.once("error", reject);
        server.listen(sockPath, () => {
          // A server's later error is nobody's rejection: left unheard, it's loud.
          server.off("error", reject);
          resolve();
        });
      }),
    send: (req, budgetMs) =>
      sendOne(connect(), req as unknown as Request, Date.now() + budgetMs),
    // [LAW:single-enforcer] A close leaves a connection open because a process's
    // exit ends it, so here the shell's end does: a subscriber hears the daemon
    // go, and a request's backstop goes with its stream. What is logged by now
    // is awaited before the env goes back, because the log reads its path when
    // it writes. A closed daemon's work is not waited for here: its launches are refused, by its own launcher, and a line
    // of its says it came after the close, whichever log the env names by then.
    stop: async () => {
      void daemon.close();
      for (const end of open) end.destroy();
      await Promise.all(
        servers.map((server) => new Promise((closed) => server.close(closed))),
      );
      await drained();
      releaseUpdateKeys();
      placeEnv(before);
    },
  };
}

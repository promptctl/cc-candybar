// [LAW:one-source-of-truth] The tests' one composition root for a daemon in a
// jest worker. It is the shell a process puts over the daemon, and no more: the
// request handling is the daemon's and a connection is `handleConnection`, so
// the render a test reads is the one a client reads. What a test talks to it
// through is daemon-e2e's helpers, which take this in place of a socket path.

import type { TmuxAtExit } from "../../src/daemon/tmux-status";
import { HOST } from "./host";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import type { Duplex } from "node:stream";
import { pathToFileURL } from "node:url";

import { handleConnection } from "../../src/daemon/connection";
import {
  createDaemon,
  type Daemon,
  type DaemonInputs,
  type DaemonStorage,
  type RunningBundle,
} from "../../src/daemon/daemon";
import { memoryLimitBytes } from "../../src/daemon/limits";
import { fileStorage } from "../../src/daemon/file-storage";
import { offlinePricing } from "../../src/segments/pricing";
import { DaemonLog } from "../../src/daemon/log";
import { homeOf, type RendererHome } from "../../src/daemon/home";
import { daemonPaths, type DaemonPaths } from "../../src/daemon/paths";
import { productionAdapters } from "../../src/daemon/production-adapters";
import { PROTOCOL_VERSION, sendOne, type Request } from "../../src/daemon/protocol";
import { systemTimekeeper } from "../../src/time";
import type { StatsSnapshot } from "../../src/daemon/stats";
import { daemonGates } from "../../src/daemon/update-keys";
import type { DaemonLogger } from "../../src/utils/logger";
import type { DaemonEndpoint } from "./daemon-wire";
import type { StartBarDaemon } from "./drive-bar";
import { memoryConnection } from "./memory-connection";
import { writesInTurn } from "./writes-in-turn";
import { LEDGER_ENV, TEST_FILE_ENV, recordDaemonStart } from "./process-tier.cjs";

// [LAW:single-enforcer] What a boot here is recorded with. `startDaemon` replaces
// the worker's env with the case's own, which holds neither, so both are read
// once as this module loads, before a case places anything. Both exist by then:
// global setup made the ledger, and test/setup-after-env.ts named the file.
const LEDGER = ledgerPath();
// [LAW:no-silent-failure] A boot with nowhere to record itself would go unseen.
function ledgerPath(): string {
  const ledger = process.env[LEDGER_ENV];
  if (ledger === undefined) {
    throw new Error(`${LEDGER_ENV} is unset: a daemon built in a worker records itself in the run's ledger, which global setup makes`);
  }
  return ledger;
}
const TEST_FILE = process.env[TEST_FILE_ENV] ?? null;

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

// A daemon with the log it writes to, which the case that built it ends.
export interface BuiltDaemon {
  readonly daemon: Daemon;
  readonly daemonLog: DaemonLog;
  // The home the daemon was built under, which the env no longer says once a
  // case passes its own, and the paths derived from it.
  readonly home: RendererHome;
  readonly paths: DaemonPaths;
}

// A daemon built as a process builds one, unarmed unless its case arms it: the
// memory backstop and the bundle watch would end it on the worker's own memory
// and a bundle that isn't running. Arming also starts file-event delivery, whose
// period drives the watcher's judge and the catch-up reload, so a daemon here
// hears a watch only by a delivered event, which is what a watcher case proves.
// Delivery unstarted is `unmeasured` with nothing missed, and adds no warning
// (src/daemon/cache/file-events.ts).
export function buildDaemon(overrides: DaemonOverrides = {}): BuiltDaemon {
  // [LAW:nothing-unseen] Every daemon built in a worker comes through here, so the
  // judge sees each one by the file that built it, as it sees a real daemon.
  recordDaemonStart({ ledger: LEDGER, file: TEST_FILE, route: "harness" });
  // The home the case's env names, or the one it hands in, read once here;
  // every path the daemon and its adapters write derives from it.
  const home = overrides.home ?? homeOf(HOST);
  const paths = daemonPaths(home);
  fs.mkdirSync(paths.state, { recursive: true });
  const daemonLog = overrides.daemonLog ?? new DaemonLog(paths.log, systemTimekeeper);
  try {
    const daemon = createDaemon({
      ...productionAdapters(paths, daemonLog, systemTimekeeper),
      // [LAW:nothing-unseen] Every request and click a daemon here serves
      // writes through the ordering instrument (test/helpers/writes-in-turn.ts).
      sessionWrites: writesInTurn,
      // [LAW:effects-at-boundaries] A daemon under test prices by the bundled
      // rates: it reaches no network, and leaves no load out at its close.
      pricing: () => offlinePricing(),
      bundle: bundleAt(path.join(paths.state, "checkout")),
      host: HOST,
      memoryLimitBytes: memoryLimitBytes(process.env),
      // test/setup.ts points it at a closed port.
      registryUrl: process.env.CC_CANDYBAR_REGISTRY_URL!,
      clock: systemTimekeeper,
      // A daemon's gates are its own: none is shared with another built here.
      gates: daemonGates(),
      // [LAW:no-silent-failure] Nothing here should end a worker, so a reply that
      // carries an exit is loud. A case about the exit passes its own.
      exit: (code) => {
        throw new Error(`a daemon under test asked to exit ${code}`);
      },
      ...overrides,
      home,
      daemonLog,
      storage: (log) => ({
        ...fileStorage(paths, log, systemTimekeeper),
        ...overrides.storage?.(log),
      }),
    });
    return { daemon, daemonLog, home, paths };
  } catch (e) {
    // A log this call opened is the call's to end when no daemon takes it up.
    if (overrides.daemonLog === undefined) daemonLog.dispose();
    throw e;
  }
}

// A worker's daemon lays out no tmux status line, so nothing is put back.
export const NO_TMUX_AT_EXIT: TmuxAtExit = () => ({
  kind: "failed",
  reason: "no tmux at this daemon's exit",
});

// The daemon's counts from its request handling, past the connection: the 200 ms
// guard is the connection's, and a busy machine is no fact about them.
export async function statsOf(daemon: Daemon): Promise<StatsSnapshot> {
  const { resp } = await daemon.reply(
    { v: PROTOCOL_VERSION, kind: "stats" },
    () => false,
    daemon.clock.monotonic(),
    () => false,
  );
  if (!resp.ok || !("stats" in resp)) throw new Error(`stats failed: ${JSON.stringify(resp)}`);
  return resp.stats;
}

export interface InWorkerDaemon extends DaemonEndpoint {
  readonly daemon: Daemon;
  // Every path the daemon touches, as its home derives them.
  readonly paths: DaemonPaths;
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

// [LAW:no-shared-mutable-globals] The env that daemons started here hold, and
// how many, with the env the first of them found, which the last to stop puts
// back. `process.env` is the worker's one ambient value, so the harness is its
// single owner: a start that asks for another env than a daemon not yet stopped
// holds would swap it under that daemon, and a stop that put back what its own
// start found would leave an earlier start's env behind.
let held: {
  readonly env: NodeJS.ProcessEnv;
  readonly before: NodeJS.ProcessEnv;
  starts: number;
} | null = null;

const sameEnv = (a: NodeJS.ProcessEnv, b: NodeJS.ProcessEnv): boolean =>
  JSON.stringify(Object.entries(a).sort()) ===
  JSON.stringify(Object.entries(b).sort());

// A daemon serving this worker, placed by `env`: the env a spawned daemon would
// be given is this file's own until `stop`, and the daemon's paths are read from
// it once, at the build. One test file's `process.env` is its own, so a start
// asking for another env than a daemon not yet stopped holds is refused; a case
// that wants two daemons over different places builds them with `buildDaemon`
// and paths of their own.
export function startDaemon(
  env: NodeJS.ProcessEnv,
  overrides: DaemonOverrides = {},
): InWorkerDaemon {
  if (held !== null && !sameEnv(held.env, env)) {
    throw new Error(
      "startDaemon: this worker's env is held by a daemon that has not stopped, and this start asks for another",
    );
  }
  const before = held?.before ?? { ...process.env };
  placeEnv(env);
  let daemon: Daemon;
  let daemonLog: DaemonLog;
  let paths: DaemonPaths;
  let home: RendererHome;
  try {
    ({ daemon, daemonLog, paths, home } = buildDaemon(overrides));
  } catch (e) {
    if (held === null) placeEnv(before);
    throw e;
  }
  held = held ?? { env: { ...env }, before, starts: 0 };
  let stopped = false;
  held.starts++;
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
    paths,
    log: paths.log,
    name: home.name,
    now: () => daemon.clock.now(),
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
      sendOne(
        connect(),
        req as unknown as Request,
        Date.now() + budgetMs,
        systemTimekeeper,
      ),
    // [LAW:single-enforcer] A close leaves a connection open because a process's
    // exit ends it, so here the shell's end does: a subscriber hears the daemon
    // go, and a request's backstop goes with its stream. What is logged by now
    // is awaited and the log ended before the case's next daemon opens the same
    // file. A closed daemon's work needs no wait here, so close's value goes
    // unread: its launches are refused, by its own launcher, and a line of its
    // says it came after the close.
    stop: async () => {
      // A second stop of one daemon (inline, then the case's afterEach) is no
      // second daemon ending: only a first one counts down what is held.
      if (stopped) return;
      stopped = true;
      void daemon.close(NO_TMUX_AT_EXIT);
      for (const end of open) end.destroy();
      await Promise.all(
        servers.map((server) => new Promise((closed) => server.close(closed))),
      );
      await daemonLog.drained();
      daemonLog.dispose();
      if (held !== null && --held.starts === 0) {
        placeEnv(held.before);
        held = null;
      }
    },
  };
}

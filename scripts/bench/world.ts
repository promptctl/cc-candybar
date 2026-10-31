// The built daemon in a world of its own, driven the way Claude Code's client
// drives it.
//
// [LAW:effects-at-boundaries] The daemon is the subject and a black box. Its
// whole environment is named here, not inherited: its socket, state, cache and
// config directories, `~`, data directories, Claude Code directory, git
// configuration and `gh` are this world's, so no render reads the developer's
// files, no PR lookup reaches the network, and nothing here touches a daemon
// the developer is running. A variable not named is not passed on.
//
// [LAW:one-source-of-truth] A render is sent through the client's own entry
// points (`tryRenderViaDaemon`, `detectClientHints`, `nodeClientHint`), so a
// request carries the hints, budgets and outcome classes a real one does; the
// daemon's own render event, read back from its log, is the record of what it
// did with it.
//
// [LAW:no-shared-mutable-globals] exception: the client reads its socket from
// `process.env.CC_CANDYBAR_SOCKET` at call time and nothing in its API can say
// otherwise, so the one world alive points the process's env at its socket. A
// world's owner is `startWorld` and `stop`; two worlds at once would fight
// over it.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { nodeClientHint } from "../../src/client-hint.js";
import { detectClientHints } from "../../src/client-hints.js";
import { daemonArgs } from "../../src/daemon/acquire.js";
import { tryRenderViaDaemon } from "../../src/daemon/client.js";
import { fetchStats } from "../../src/daemon/client-stats.js";
import { describeFailure } from "../../src/daemon/client-transport.js";
import { logLines } from "../../src/daemon/log.js";
import { PARENT_PID_ENV } from "../../src/daemon/parent-watchdog.js";
import { logPath } from "../../src/daemon/paths.js";
import type { StatsSnapshot } from "../../src/daemon/stats.js";
import type { ClaudeHookData } from "../../src/utils/claude.js";
import { valueOf } from "../../src/utils/logfmt.js";
import { hookData as barHookData } from "../lib/hook-data.js";
import { sessionEnv } from "../lib/session-env.js";
import { transcriptPath } from "../lib/transcript.js";
import { BUNDLE, requireCurrentBundle } from "./environment.js";
import {
  HERMETIC_GIT_ENV,
  makeRepo,
  removeTree,
  scratchDir,
  writeTranscript,
  type RepoShape,
} from "./fixtures.js";
import { sleep } from "./measure.js";

// What the daemon was asked and answered for one render, from its own event.
export interface RenderEvent {
  // When the daemon logged it, ms since the epoch.
  readonly at: number;
  readonly tookMs: number;
  readonly queuedMs: number;
  readonly outcome: string;
  // `-` when nothing drew pending.
  readonly pending: string;
}

// One Claude Code session: a checkout it works in and a transcript it writes.
export interface Session {
  readonly id: string;
  readonly cwd: string;
  readonly transcript: string;
}

// [LAW:types-are-the-program] A tick the client answered, or one it did not:
// the second is a fact about a cold daemon (a first render can spend its whole
// deadline compiling), not an error, so it is a value the caller folds. A
// benchmark that needs a bar uses `drawn`, which is the checkpoint.
export type Tick =
  | { readonly ok: true; readonly ms: number; readonly output: string }
  | { readonly ok: false; readonly ms: number; readonly why: string };

// What it took to get a bar fully drawn from a session the daemon had not seen.
export interface Settled {
  // Ticks sent, the last of which drew every source answered.
  readonly attempts: number;
  // The first tick's round trip, answered or not.
  readonly firstMs: number;
  // From the first tick sent to the answer that drew nothing pending.
  readonly settledMs: number;
}

export interface World {
  readonly claudeDir: string;
  readonly configFile: string;
  // The daemon's boot: from its spawn to its first answered `stats`.
  readonly bootMs: number;
  /** A new session in a new checkout of `shape`, its transcript at `turns`. */
  session(name: string, shape: RepoShape, turns: number): Session;
  /** A new session in the checkout `of` works in. */
  another(of: Session, name: string, turns: number): Session;
  /** The Status hook Claude Code sends a session at its `n`th tick. */
  hookData(session: Session, n: number): ClaudeHookData;
  /** The environment a client process runs in, at a terminal `columns` wide. */
  clientEnv(columns: number): NodeJS.ProcessEnv;
  /** One render, as the client sends it. */
  tick(session: Session, columns: number, n: number): Promise<Tick>;
  /** The daemon's own counters, now. */
  stats(): Promise<StatsSnapshot>;
  /** Ticks until the daemon draws the session with nothing pending. */
  settle(session: Session, columns: number): Promise<Settled>;
  /** How many render events of a session the log holds now. */
  mark(sessionId: string): number;
  /** The `count` render events of a session after the first `from`, once they have landed. */
  events(sessionId: string, from: number, count: number): Promise<RenderEvent[]>;
  stop(): Promise<void>;
}

const CLIENT = nodeClientHint("node", BUNDLE);
// A client ticks on its own beat, not in a loop: a cold daemon is asked again
// at about the rate Claude Code asks, and given up on after about a minute.
const SETTLE_PACE_MS = 50;
const SETTLE_ATTEMPTS = 1200;
// The daemon writes its log off its event loop; a line lands within this.
const LOG_LANDS_MS = 10_000;
const BOOT_BUDGET_MS = 20_000;
const BOOT_POLL_MS = 25;

// A PR lookup answers with a fixed open PR and any other `gh` question is
// recorded and fails: the host's `gh` would reach the network, and a bar that
// drew an error for a refused lookup is not the bar being measured. The record
// is read, and thrown, when the world stops.
const GH_STUB = (unknown: string): string => `#!/bin/sh
case "$*" in
  "pr view"*) printf '{"number":1,"state":"OPEN","url":"https://example.invalid/pull/1","headRefOid":"0000000000000000000000000000000000000000"}\\n' ;;
  *) echo "gh $*" >> "${unknown}"; exit 1 ;;
esac
`;

export async function startWorld(config = "{}\n"): Promise<World> {
  // Short, under /tmp: a unix socket path is capped at 104 bytes on macOS.
  const root = scratchDir("ccbn");
  const dirs = {
    state: path.join(root, "state"),
    cache: path.join(root, "cache"),
    config: path.join(root, "config", "cc-candybar"),
    data: path.join(root, "data"),
    home: path.join(root, "home"),
    bin: path.join(root, "bin"),
    claude: path.join(root, "claude"),
    checkouts: path.join(root, "w"),
  };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  // The socket's parent must be this user's and mode 0700.
  const socketDir = path.join(dirs.state, "cc-candybar");
  fs.mkdirSync(socketDir, { mode: 0o700 });
  const socket = path.join(socketDir, "socket");
  const unknownCalls = path.join(root, "unknown-gh-calls");
  fs.writeFileSync(path.join(dirs.bin, "gh"), GH_STUB(unknownCalls), {
    mode: 0o755,
  });
  const configFile = path.join(dirs.config, "config.json5");
  fs.writeFileSync(configFile, config);

  // Everything the daemon sees. A variable not here is not passed on: not the
  // host's NODE_OPTIONS, TMUX, CC_CANDYBAR_*, nor its data directories.
  const env: NodeJS.ProcessEnv = {
    PATH: `${dirs.bin}${path.delimiter}${process.env.PATH ?? ""}`,
    LANG: process.env.LANG ?? "C.UTF-8",
    TMPDIR: process.env.TMPDIR ?? "/tmp",
    HOME: dirs.home,
    XDG_STATE_HOME: dirs.state,
    XDG_CACHE_HOME: dirs.cache,
    XDG_CONFIG_HOME: path.dirname(dirs.config),
    XDG_DATA_HOME: dirs.data,
    XDG_DATA_DIRS: dirs.data,
    CLAUDE_CONFIG_DIR: dirs.claude,
    CC_CANDYBAR_SOCKET: socket,
    // No update notice reaches the network: the registry is a closed port.
    CC_CANDYBAR_REGISTRY_URL: "http://127.0.0.1:1",
    // The daemon dies with this process, however this process ends.
    [PARENT_PID_ENV]: String(process.pid),
    ...HERMETIC_GIT_ENV,
  };
  const terminal = sessionEnv(dirs.claude);
  const log = logPath(env);

  process.env.CC_CANDYBAR_SOCKET = socket;
  // The shipped daemon's own argv, heap cap included. A process group of its
  // own, so the whole daemon is signalled and not only its first process.
  const spawned = performance.now();
  const child = spawn(process.execPath, daemonArgs(BUNDLE, env), {
    env,
    detached: true,
    stdio: "ignore",
  });
  let exited: string | null = null;
  child.once("exit", (code, signal) => {
    exited = `exit code ${code} signal ${signal}`;
  });
  // A spawn that failed reports here and has no pid; unheard, it would crash
  // this process, and the boot wait would run out its budget.
  child.once("error", (e) => {
    exited = `did not start: ${e.message}`;
  });

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    try {
      if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
    } catch {
      // Already gone: killing a dead daemon is the goal reached.
    }
    delete process.env.CC_CANDYBAR_SOCKET;
    const refused = fs.existsSync(unknownCalls)
      ? fs.readFileSync(unknownCalls, "utf8").trim()
      : null;
    removeTree(root);
    // [LAW:no-silent-failure] A question the world does not answer means the
    // bars drawn here were not the ones the benchmark names.
    if (refused !== null) {
      throw new Error(`the daemon asked gh what the stub does not answer:\n${refused}`);
    }
  };

  const stats = async (): Promise<StatsSnapshot> => {
    const outcome = await fetchStats();
    if (outcome.kind !== "ok") {
      throw new Error(`the daemon did not answer stats: ${describeFailure(outcome)}`);
    }
    return outcome.value;
  };

  let bootMs: number;
  try {
    for (;;) {
      if (exited !== null) {
        throw new Error(`the daemon ${exited} before it answered:\n${logLines(log).slice(-20).join("\n")}`);
      }
      if ((await fetchStats()).kind === "ok") break;
      if (performance.now() - spawned > BOOT_BUDGET_MS) {
        throw new Error(`the daemon did not answer within ${BOOT_BUDGET_MS} ms of its spawn`);
      }
      await sleep(BOOT_POLL_MS);
    }
    bootMs = performance.now() - spawned;
    // [LAW:no-silent-failure] A bundle built from other source answers for
    // code that is not in this checkout.
    requireCurrentBundle((await stats()).sourceDigest);
  } catch (e) {
    await stop().catch(() => {});
    throw e;
  }

  const eventsOf = (sessionId: string): RenderEvent[] =>
    logLines(log)
      .filter((l) => l.includes(`] render sid=${valueOf(sessionId)} `))
      .map(parseRenderEvent);

  const lastEventSince = async (
    sessionId: string,
    since: number,
  ): Promise<RenderEvent> => {
    const deadline = Date.now() + LOG_LANDS_MS;
    for (;;) {
      const late = eventsOf(sessionId).filter((e) => e.at >= since);
      if (late.length > 0) return late.at(-1)!;
      if (Date.now() >= deadline) {
        throw new Error(
          `${sessionId}: no render event in the log ${LOG_LANDS_MS} ms after an answered tick`,
        );
      }
      await sleep(50);
    }
  };

  const world: World = {
    claudeDir: dirs.claude,
    configFile,
    bootMs,
    session(name, shape, turns) {
      const cwd = path.join(dirs.checkouts, name);
      makeRepo(cwd, shape);
      const id = `bench-${name}`;
      const transcript = transcriptPath(dirs.claude, cwd, id);
      writeTranscript(transcript, id, cwd, turns);
      return { id, cwd, transcript };
    },
    another(of, name, turns) {
      const id = `bench-${name}`;
      const transcript = transcriptPath(dirs.claude, of.cwd, id);
      writeTranscript(transcript, id, of.cwd, turns);
      return { id, cwd: of.cwd, transcript };
    },
    hookData: hookDataOf,
    clientEnv: (columns) => ({
      PATH: env.PATH,
      HOME: dirs.home,
      CC_CANDYBAR_SOCKET: socket,
      ...terminal,
      COLUMNS: String(columns),
    }),
    async tick(session, columns, n) {
      const started = performance.now();
      const outcome = await tryRenderViaDaemon(
        hookDataOf(session, n),
        [BUNDLE],
        session.cwd,
        {
          ...detectClientHints(terminal, session.cwd, { columns, rows: 48 }),
          client: CLIENT,
        },
      );
      const ms = performance.now() - started;
      return outcome.kind === "ok"
        ? { ok: true, ms, output: outcome.value }
        : { ok: false, ms, why: describeFailure(outcome) };
    },
    stats,
    async settle(session, columns) {
      const started = performance.now();
      let firstMs = 0;
      for (let attempts = 1; attempts <= SETTLE_ATTEMPTS; attempts++) {
        const since = Date.now();
        const tick = await world.tick(session, columns, attempts);
        if (attempts === 1) firstMs = tick.ms;
        // A tick the client gave up on may never have reached the daemon (a
        // connect that timed out) or may still be running in it, so a failed
        // tick has no event to wait for. An answered tick has one, logged
        // before the answer was sent; it is the last event since the tick
        // began. A straggler from an earlier tick can land among them, and it
        // is older, so it drew more pending, never less: it can delay the
        // verdict by a tick and cannot forge one.
        if (tick.ok) {
          const last = await lastEventSince(session.id, since);
          if (last.outcome === "ok" && last.pending === "-") {
            return { attempts, firstMs, settledMs: performance.now() - started };
          }
        }
        await sleep(SETTLE_PACE_MS);
      }
      throw new Error(
        `${session.id}: no bar drawn with nothing pending in ${SETTLE_ATTEMPTS} ticks`,
      );
    },
    mark: (sessionId) => eventsOf(sessionId).length,
    async events(sessionId, from, count) {
      const deadline = Date.now() + LOG_LANDS_MS;
      for (;;) {
        const found = eventsOf(sessionId);
        if (found.length >= from + count) return found.slice(from, from + count);
        if (Date.now() >= deadline) {
          throw new Error(
            `${sessionId}: ${found.length} of ${from + count} render events in the log ${LOG_LANDS_MS} ms after the last tick`,
          );
        }
        await sleep(50);
      }
    },
    stop,
  };
  return world;
}

function fieldOf(line: string, name: string): string {
  const match = new RegExp(` ${name}=(\\S+)`).exec(line);
  if (match === null) throw new Error(`no ${name}= in the render event: ${line}`);
  return match[1]!;
}

const msOf = (line: string, name: string): number =>
  Number(fieldOf(line, name).replace(/ms$/, ""));

function parseRenderEvent(line: string): RenderEvent {
  return {
    at: Date.parse(line.slice(0, 24)),
    tookMs: msOf(line, "took"),
    queuedMs: msOf(line, "queued"),
    outcome: fieldOf(line, "outcome"),
    pending: fieldOf(line, "pending"),
  };
}

// A world for the length of `body`, stopped after. When both fail, the body's
// error is the cause and stop's is told beside it, not instead of it.
// [LAW:no-silent-failure]
export async function inWorld<T>(
  body: (world: World) => Promise<T>,
  config?: string,
): Promise<T> {
  const world = await startWorld(config);
  let result: T;
  try {
    result = await body(world);
  } catch (e) {
    await world.stop().catch((stopped: unknown) => {
      console.error(`and stopping the world failed too: ${String(stopped)}`);
    });
    throw e;
  }
  await world.stop();
  return result;
}

// [LAW:no-silent-failure] The checkpoint a benchmark of a drawn bar crosses: a
// tick that did not draw is not a fast tick.
export function drawn(tick: Tick, what: string): { ms: number; output: string } {
  if (!tick.ok) throw new Error(`${what}: the tick drew no bar (${tick.why})`);
  return tick;
}

// The Status hook Claude Code sends at tick `n` of a session: what moves
// between ticks (cost, duration) moves.
function hookDataOf(session: Session, n: number): ClaudeHookData {
  const base = barHookData(session.cwd, session.transcript);
  return {
    ...base,
    session_id: session.id,
    cost: {
      ...base.cost!,
      total_cost_usd: 0.39 + n * 0.001,
      total_duration_ms: 930_000 + n * 1600,
    },
  };
}

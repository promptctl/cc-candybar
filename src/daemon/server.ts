import fs from "node:fs";
import net from "node:net";
import v8 from "node:v8";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  daemonDir,
  diagnosticsDir,
  ensureSocketParentSafe,
  leasePath,
  leasePathFor,
  socketPath,
  sessionStatePath,
} from "./paths";
import {
  arbitrateSocket,
  readLease,
  removeLeaseIfOwned,
  writeLease,
} from "./socket-lease";
import {
  makeOwnershipWatch,
  readSocketIdentity,
  type SocketIdentity,
} from "./socket-ownership";
import {
  readStartTime,
  readOwnStartTime,
  sameLiveProcess,
} from "./process-fingerprint";
import {
  admitDaemon,
  realBreakerDeps,
  releaseRegistration,
  readRegistryEntry,
} from "./fork-bomb-breaker";
import { dlog } from "./log";
import { makeUpdateWatch, UPDATE_DISMISSED_KEY } from "./update-notice";
import { REGISTRY_URL } from "../install/currency";
import {
  PROTOCOL_VERSION,
  encodeFrame,
  makeFrameReader,
  parseClientHints,
  sanitizeConfigPath,
} from "./protocol";
import type { Request, Response } from "./protocol";
import { GitDataProvider } from "./cache/git";
import { SessionUsageStore } from "./cache/session-usage-store";
import { RenderCache } from "./cache/render";
import { WatcherRegistry } from "./cache/watchers";
import { RuntimeStats } from "./stats";
import {
  makeLimits,
  realLimitsDeps,
  rssLimitBytes,
  type LimitsHandle,
} from "./limits";
import { armParentWatchdog, anchorFromEnv, pidAlive } from "./parent-watchdog";
import { resetSpawnBackoff } from "./acquire";
import { SessionState } from "./session-state";
import { FileSessionStorage } from "./session-state-file";
import {
  VERBS,
  BadVerbArgs,
  SESSION_CONFIG_OVERRIDE_KEY,
  SESSION_RENDER_ORIGIN_KEY,
  SESSION_CLIENT_HINTS_KEY,
  encodeRenderOrigin,
} from "./verbs";
import { validateHookData } from "../utils/schema-validator.js";
import { productionEdge } from "../doctor/edge";
import { setLaunchStats } from "../proc/launch";
import { buildDebugSnapshot } from "./debug";
import { DEBUG_WHATS, isDebugWhat } from "./debug-types";
import { renderDsl } from "../dsl/render.js";
import { lookKeyByName, paletteForThemeName } from "../themes/index.js";
import {
  renderStripCells,
  DEFAULT_CHARSET,
  DEFAULT_COLOR_COMPATIBILITY,
  DEFAULT_PADDING,
  DEFAULT_TERMINAL_WIDTH,
  DEFAULT_WRAP,
  type BuildLineOptions,
  type Charset,
  type ColorCompatibility,
} from "../render/strip.js";
import { applyClaudeCodeReserve } from "../utils/terminal-width.js";
import type { RichText } from "@promptctl/rich-js";
import {
  buildRenderPayload,
  resolveEffectiveGlobals,
  type EffectiveGlobals,
} from "./render-payload.js";
import { ContextProvider } from "../segments/context.js";
import { MetricsProvider } from "../segments/metrics.js";
import { TmuxService } from "../segments/tmux.js";
import {
  collectDiagnostics,
  composeWithDiagnostics,
  diagnosticRowCap,
  formatDiagnosticDump,
} from "../render/diagnostic-strip.js";
import { DiagnosticDump } from "./diagnostic-dump.js";

const stats = new RuntimeStats();
setLaunchStats(stats.launchStats);
const watcherRegistry = new WatcherRegistry({
  counters: stats,
  logger: dlog,
});
const gitService = new GitDataProvider({
  watchers: watcherRegistry,
  logger: dlog,
});
const usageStore = new SessionUsageStore();
// [LAW:locality-or-seam] Ephemeral, so importing this module does no disk I/O.
const sessionState = new SessionState();
const diagnosticDump = new DiagnosticDump(diagnosticsDir());
const contextProvider = new ContextProvider();
const metricsProvider = new MetricsProvider();
const tmuxService = new TmuxService();
const renderCache = new RenderCache(
  {
    gitService,
    sessionState,
    watchers: watcherRegistry,
  },
  {
    observers: {
      onReload: (entry) =>
        dlog(
          "info",
          `config loaded projectDir=${entry.projectDir} cwd=${entry.cwd} file=${entry.configFilePath ?? "<bundled default>"} error=${entry.lastError === null ? "none" : JSON.stringify(entry.lastError)} warning=${entry.lastWarning === null ? "none" : JSON.stringify(entry.lastWarning)}`,
        ),
    },
  },
);

const REQUEST_TIMEOUT_MS = 200;
const BIN_CHECK_INTERVAL_MS = 60 * 1000;
const RELEASE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

// If the compiled output changes on disk, exit at the next sample so the next
// client respawns from fresh code; `checkNow` skips the wait after our own build.
function makeBinaryWatch(): { arm(): void; checkNow(): void } {
  // Watch the resolved entry point; the bin/cc-candybar shim never changes.
  const entryUrl = import.meta.url;
  const targets: string[] = [];
  if (entryUrl.startsWith("file://")) {
    targets.push(fileURLToPath(entryUrl));
  }
  if (process.argv[1]) targets.push(process.argv[1]!);

  const originalMtimes = new Map<string, number>();
  for (const t of targets) {
    try {
      originalMtimes.set(t, fs.statSync(t).mtimeMs);
    } catch {
      // File may not exist yet — skip it.
    }
  }
  let timer: NodeJS.Timeout | null = null;
  const sample = (): void => {
    for (const [t, originalMtime] of originalMtimes) {
      try {
        const nowMtime = fs.statSync(t).mtimeMs;
        if (nowMtime !== originalMtime) {
          dlog("info", `binary mtime changed (${t}); shutting down`);
          if (timer) clearInterval(timer);
          shutdown(0);
          return;
        }
      } catch (e) {
        dlog("warn", `bin stat failed: ${(e as Error).message}`);
      }
    }
  };
  return {
    arm() {
      if (originalMtimes.size === 0) return;
      timer = setInterval(sample, BIN_CHECK_INTERVAL_MS);
      timer.unref();
    },
    checkNow: sample,
  };
}
const binaryWatch = makeBinaryWatch();

// [LAW:single-enforcer] The daemon observes the bundle it runs, so it owns this.
const updateWatch = makeUpdateWatch({
  entryUrl: import.meta.url,
  intervalMs: BIN_CHECK_INTERVAL_MS,
  releaseIntervalMs: RELEASE_CHECK_INTERVAL_MS,
  registryUrl: process.env.CC_CANDYBAR_REGISTRY_URL ?? REGISTRY_URL,
  fetchImpl: fetch,
  onApplied: () => binaryWatch.checkNow(),
  log: dlog,
});

// [LAW:one-source-of-truth] Stamped into our lease so a future daemon can tell
// us from a recycled pid; null when this host cannot fingerprint.
let myStartTime: string | null = null;

let breakerRegistryPath: string | null = null;

let budgetBytes = 0;

export function runDaemon(): void {
  // [LAW:single-enforcer] Registered FIRST, before any startup call that can
  // throw synchronously, so an early throw still funnels through shutdown(1).
  process.on("uncaughtException", (err) => {
    dlog("error", `uncaughtException: ${err.stack || err.message}`);
    shutdown(1);
  });
  process.on("unhandledRejection", (reason) => {
    dlog("error", `unhandledRejection: ${String(reason)}`);
    shutdown(1);
  });
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(sig, () => {
      dlog("info", `received ${sig}, shutting down`);
      shutdown(0);
    });
  }

  // [LAW:effects-at-boundaries] Parsed before any resource is committed, and
  // refused through the same death funnel as every other boot failure.
  try {
    budgetBytes = rssLimitBytes(process.env);
  } catch (err) {
    dlog("error", `refusing to boot: ${(err as Error).message}`);
    shutdown(1);
    return;
  }

  // [LAW:single-enforcer] The breaker runs FIRST among the resource-committing
  // steps: a load-independent backstop must hold when downstream is thrashing.
  myStartTime = readOwnStartTime(process.pid);
  const admission = admitDaemon(realBreakerDeps(myStartTime));
  if (!admission.decision.allow) {
    dlog(
      "warn",
      `fork-bomb breaker: ${admission.decision.reason}; refusing to boot`,
    );
    shutdown(1);
    return;
  }
  breakerRegistryPath = admission.registryPath;

  fs.mkdirSync(daemonDir(), { recursive: true });
  // [LAW:single-enforcer] Verify the socket parent before we bind, or a
  // same-host attacker could pre-create it and squat the socket name.
  ensureSocketParentSafe(socketPath());

  sessionState.useStorage(
    new FileSessionStorage(sessionStatePath(), 500, dlog),
  );
  armParentWatchdog({
    anchor: anchorFromEnv(process.env),
    isAlive: pidAlive,
    onOrphaned: (reason) => {
      dlog("info", `parent watchdog: ${reason}; shutting down`);
      shutdown(0);
    },
  });

  const server = net.createServer({ allowHalfOpen: false }, (sock) => {
    handleConnection(sock);
  });

  // [LAW:single-enforcer] The atomic bind() is the daemon-singleton enforcer.
  bindOrAttachAndExit(server, socketPath(), /* retried */ false);
}

function bindOrAttachAndExit(
  server: net.Server,
  sockPath: string,
  retried: boolean,
): void {
  server.removeAllListeners("error");
  // [LAW:no-ambient-temporal-coupling] listen's cb is a ONE-TIME listener a
  // failed listen leaves pending; uncleared, a rebind fires onListening twice.
  server.removeAllListeners("listening");
  server.once("error", (err) => {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EADDRINUSE") {
      dlog("error", `server error: ${err.message}`);
      shutdown(1);
      return;
    }
    if (retried) {
      dlog("info", "lost rebind race; another daemon is alive — exiting");
      process.exit(0);
      return;
    }
    handleAddressInUse(server, sockPath);
  });
  server.listen(sockPath, () => onListening(sockPath));
}

// [LAW:one-source-of-truth] Arbitration consults the pid lease, NEVER a connect
// probe, and is synchronous — no await gap for a racing recoverer.
// [LAW:effects-at-boundaries] arbitrateSocket decides; the effects happen here.
function handleAddressInUse(server: net.Server, sockPath: string): void {
  const decision = arbitrateSocket(
    readLease(leasePathFor(sockPath)),
    (pid, startTime) =>
      sameLiveProcess(pid, startTime, { readStartTime, pidAlive }),
  );
  if (decision.kind === "attach-and-exit") {
    dlog("info", `EADDRINUSE: ${decision.reason} — exiting`);
    process.exit(0);
    return;
  }
  dlog(
    "warn",
    `EADDRINUSE: ${decision.reason} — unlinking stale socket and rebinding`,
  );
  // [LAW:no-defensive-null-guards] A failed unlink leaves no daemon plus a stale
  // socket blocking future starts. ENOENT already makes the path bindable.
  try {
    fs.unlinkSync(sockPath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      dlog(
        "error",
        `cannot unlink stale socket ${sockPath}: ${(e as Error).message}`,
      );
      shutdown(1);
      return;
    }
  }
  bindOrAttachAndExit(server, sockPath, /* retried */ true);
}

function onListening(sockPath: string): void {
  // [LAW:no-ambient-temporal-coupling] Identity comes from the PATH: an AF_UNIX
  // listener's fstat reports a socket-namespace inode. [FRAMING:representation]
  // It cannot see a thief that rebound inside the bind→listening tick.
  const boundRead = readSocketIdentity(sockPath);
  if (boundRead.kind !== "present") {
    dlog(
      "warn",
      `no ownable socket at bind callback (${boundRead.kind}); exiting`,
    );
    shutdown(0);
    return;
  }

  // [LAW:no-ambient-temporal-coupling] Claim ownership FIRST, minimising the gap.
  writeLeaseFile(sockPath);
  try {
    fs.chmodSync(sockPath, 0o600);
  } catch (e) {
    dlog("warn", `chmod socket failed: ${(e as Error).message}`);
  }
  dlog(
    "info",
    // [FRAMING:representation] The cap V8 applied, not the flag it was passed.
    `daemon up: pid=${process.pid} v=${PROTOCOL_VERSION} sock=${sockPath} ` +
      `heapCap=${Math.round(v8.getHeapStatistics().heap_size_limit / 1048576)}MB ` +
      `rssLimit=${Math.round(budgetBytes / 1048576)}MB`,
  );
  // [LAW:single-enforcer] The one fact that answers "did an outage just end".
  resetSpawnBackoff();
  const wipeFailure = diagnosticDump.reset();
  if (wipeFailure !== null)
    dlog("warn", `diagnostic dump wipe failed: ${wipeFailure}`);
  binaryWatch.arm();
  updateWatch.arm();
  armLimits();
  armOwnershipWatch(sockPath, boundRead.identity);
}

// [LAW:single-enforcer] The sole enforcer of "serving implies owning the socket
// path over time": the inode and the lease's pid are both re-read, and either
// mismatch drains through the SAME shutdown funnel.
function armOwnershipWatch(sockPath: string, bound: SocketIdentity): void {
  makeOwnershipWatch({
    bound,
    myPid: process.pid,
    readIdentity: () => readSocketIdentity(sockPath),
    readLease: () => readLease(leasePathFor(sockPath)),
    shutdown: (code) => shutdown(code),
    log: dlog,
  }).arm();
}

let limits: LimitsHandle | null = null;
function armLimits(): void {
  limits = makeLimits(
    realLimitsDeps(stats.startedAt.getTime(), (code) => shutdown(code), {
      rssLimitBytes: budgetBytes,
    }),
  );
  limits.arm();
}

// [LAW:one-source-of-truth] The lease is the authority for ownership over time;
// bind() is what excludes right now, so a failed write degrades to reclaim.

function writeLeaseFile(sockPath: string): void {
  const reason = writeLease(leasePathFor(sockPath), {
    pid: process.pid,
    version: PROTOCOL_VERSION,
    binPath: process.argv[1],
    startTime: myStartTime,
  });
  if (reason !== null) dlog("warn", `lease write failed: ${reason}`);
}

let inFlight = 0;

let shuttingDown = false;
function shutdown(code: number): void {
  if (shuttingDown) return;
  shuttingDown = true;
  // [LAW:single-enforcer] Arm the SIGKILL backstop FIRST: an active handle can
  // keep the loop alive past process.exit, so this timer is NOT unref'd.
  setTimeout(() => process.kill(process.pid, "SIGKILL"), 500);
  // [LAW:single-enforcer] bind() is the ONLY mutex preventing duplicate daemons.
  // Do NOT unlink here: it frees the path instantly while the FD is held until
  // exit, so a fresh daemon could bind and serve mid-cleanup.
  try {
    gitService.close();
  } catch (e) {
    dlog("warn", `gitService close failed: ${(e as Error).message}`);
  }
  try {
    usageStore.close();
  } catch (e) {
    dlog("warn", `usageStore close failed: ${(e as Error).message}`);
  }
  try {
    watcherRegistry.closeAll();
  } catch (e) {
    dlog("warn", `watcherRegistry close failed: ${(e as Error).message}`);
  }
  try {
    sessionState.flush();
  } catch (e) {
    dlog("warn", `sessionState flush failed: ${(e as Error).message}`);
  }
  // [LAW:one-source-of-truth] Only if it still names us, or the theft cascades.
  removeLeaseIfOwned(leasePath(), process.pid);
  if (breakerRegistryPath !== null) {
    releaseRegistration(
      breakerRegistryPath,
      process.pid,
      readRegistryEntry,
      (p) => fs.unlinkSync(p),
    );
  }
  process.exit(code);
}

function handleConnection(sock: net.Socket): void {
  inFlight++;
  stats.inFlight = inFlight;
  let responded = false;

  // [LAW:no-ambient-temporal-coupling] sock.end's callback fires on 'finish' OR
  // 'error', so the exit wish can never be stranded on a dead socket.
  const respond = (resp: Response, exitAfterFlush: number | null): void => {
    if (responded) {
      // [LAW:no-silent-failure] A daemon told to exit must not stay up quietly.
      if (exitAfterFlush !== null) {
        dlog(
          "warn",
          "exit-after-flush dropped: an earlier responder settled this socket",
        );
      }
      return;
    }
    responded = true;
    const settle =
      exitAfterFlush === null
        ? undefined
        : (): void => shutdown(exitAfterFlush);
    try {
      sock.end(encodeFrame(resp), settle);
    } catch (e) {
      // [LAW:no-silent-failure] The response is lost, but the exit wish is not.
      dlog("warn", `response write failed: ${(e as Error).message}`);
      settle?.();
    }
  };

  // The timeout abandons the RESPONSE, not the work. [LAW:one-source-of-truth]
  // A SingleFlight leaves one in-flight scan the next render coalesces onto.
  const timer = setTimeout(() => {
    stats.requestsTimedOut++;
    respond(
      {
        ok: false,
        error: "request exceeded 200ms",
        code: "TIMEOUT",
        daemonV: PROTOCOL_VERSION,
      },
      null,
    );
  }, REQUEST_TIMEOUT_MS);

  const reader = makeFrameReader(
    (frame) => {
      void handleRequest(frame as Request)
        .then((r) => respond(r.resp, r.exitAfterFlush))
        .catch((err) => {
          dlog("error", `handler threw: ${err?.stack || err}`);
          respond(
            {
              ok: false,
              error: String(err?.message || err),
              code: "RENDER_FAILED",
              daemonV: PROTOCOL_VERSION,
            },
            null,
          );
        });
    },
    (err) => {
      dlog("warn", `frame parse failed: ${err.message}`);
      respond(
        {
          ok: false,
          error: err.message,
          code: "BAD_REQUEST",
          daemonV: PROTOCOL_VERSION,
        },
        null,
      );
    },
  );

  sock.on("data", reader);
  sock.on("error", (err) => {
    dlog("warn", `socket error: ${err.message}`);
  });
  sock.on("close", () => {
    clearTimeout(timer);
    inFlight = Math.max(0, inFlight - 1);
    stats.inFlight = inFlight;
  });
}

// [LAW:no-ambient-temporal-coupling] "Then exit" is DATA; the connection
// boundary owns the flush. [LAW:effects-at-boundaries] It performs, we describe.
interface HandledRequest {
  resp: Response;
  exitAfterFlush: number | null;
}

const stay = (resp: Response): HandledRequest => ({
  resp,
  exitAfterFlush: null,
});

async function handleRequest(req: Request): Promise<HandledRequest> {
  if (
    !req ||
    typeof req !== "object" ||
    typeof (req as Request).v !== "number"
  ) {
    return stay({
      ok: false,
      error: "malformed request",
      code: "BAD_REQUEST",
      daemonV: PROTOCOL_VERSION,
    });
  }

  if (req.v !== PROTOCOL_VERSION) {
    // [LAW:types-are-the-program] Client > daemon means the binary upgraded
    // under us; client < daemon means respawning cannot help, so stay up.
    if (req.v > PROTOCOL_VERSION) {
      dlog(
        "info",
        `version mismatch: client=${req.v} > daemon=${PROTOCOL_VERSION}; binary likely upgraded — exiting after the response flushes`,
      );
    } else {
      dlog(
        "info",
        `version mismatch: client=${req.v} < daemon=${PROTOCOL_VERSION}; client is stale — staying up`,
      );
    }
    return {
      resp: {
        ok: false,
        error: `protocol v${req.v} not supported (daemon at v${PROTOCOL_VERSION})`,
        code: "VERSION_MISMATCH",
        daemonV: PROTOCOL_VERSION,
      },
      // [LAW:dataflow-not-control-flow] Sequenced on the flush, never a dead socket.
      exitAfterFlush: req.v > PROTOCOL_VERSION ? 0 : null,
    };
  }

  if (req.kind === "shutdown") {
    return { resp: { ok: true, output: "" }, exitAfterFlush: 0 };
  }

  if (req.kind === "stats") {
    // [LAW:single-enforcer] Observability must not pollute the metric observed.
    return stay({
      ok: true,
      stats: stats.snapshot({
        gitCache: gitService.getStats(),
        usageCache: usageStore.getStats(),
        renderCacheSize: renderCache.size,
        watchersActive: watcherRegistry.size(),
        nextRestartReason: limits?.describeNextRestart() ?? null,
      }),
    });
  }

  if (req.kind === "render") {
    stats.requestsTotal++;
    const t0 = Date.now();
    try {
      const { report } = validateHookData(req.hookData as unknown);
      for (const field of report.unknownTopLevelFields) {
        dlog(
          "info",
          `schema: unknown field '${field}' — Anthropic may have added it`,
        );
      }
      // [LAW:no-silent-fallbacks][LAW:types-are-the-program] Gate hard, or
      // "absent" collapses into an empty-string cache key every request shares.
      const wireProblems: string[] = [];
      for (const path of report.missingRequired) {
        wireProblems.push(`missing required field '${path}'`);
      }
      for (const { path, expected, got } of report.typeMismatches) {
        wireProblems.push(`field '${path}' expected ${expected}, got ${got}`);
      }
      if (req.cwd === "") {
        wireProblems.push("request 'cwd' is empty");
      }
      if (wireProblems.length > 0) {
        stats.requestsErrored++;
        dlog("warn", `BAD_REQUEST: ${wireProblems.join("; ")}`);
        return stay({
          ok: false,
          error: `malformed hookData: ${wireProblems.join("; ")}`,
          code: "BAD_REQUEST",
          daemonV: PROTOCOL_VERSION,
        });
      }
      const projectDir = req.hookData.workspace.project_dir;
      // [LAW:dataflow-not-control-flow] The request's cwd, never the daemon's.
      const { configFile, unknownFlagsError } = parseRenderArgs(req.args);
      const sessionId = req.hookData.session_id;
      // [LAW:parse-dont-validate] The ONE checkpoint; raw hints stop here.
      // [LAW:single-enforcer] The daemon's env describes a different session.
      const hints = parseClientHints(req);
      // [LAW:one-source-of-truth] A click carries no hints; the doctor reads these.
      const hintRecord = JSON.stringify(hints);
      if (
        sessionState.get(sessionId, SESSION_CLIENT_HINTS_KEY) !== hintRecord
      ) {
        sessionState.set(sessionId, SESSION_CLIENT_HINTS_KEY, hintRecord);
      }
      // [LAW:one-source-of-truth] Three spellings of a config path, ONE precedence.
      const sessionConfigFile =
        sessionState.get(sessionId, SESSION_CONFIG_OVERRIDE_KEY) ??
        configFile ??
        hints.configEnv;
      const entry = renderCache.getOrCreate(
        projectDir,
        req.cwd,
        sessionConfigFile,
      );
      // [LAW:one-source-of-truth] The inputs THIS render resolved its config
      // from, so a durable click resolves the same chain. Compared before
      // writing: set() fires the session atom and invalidates every computed.
      const origin = encodeRenderOrigin({
        projectDir,
        cwd: req.cwd,
        configFile: sessionConfigFile ?? null,
      });
      if (sessionState.get(sessionId, SESSION_RENDER_ORIGIN_KEY) !== origin) {
        sessionState.set(sessionId, SESSION_RENDER_ORIGIN_KEY, origin);
      }
      const termCols = hints.termCols;
      const width = applyClaudeCodeReserve(termCols ?? DEFAULT_TERMINAL_WIDTH);
      const rowCap = diagnosticRowCap(hints.termRows);
      const renderOpts: BuildLineOptions = { ...RENDER_OPTS_BASE, width };
      // [LAW:dataflow-not-control-flow] The entry always holds a renderable
      // state, so there is no "did the config load" branch.
      // [LAW:one-source-of-truth] Globals resolved ONCE feed both the payload's
      // `*.effective` fields and renderOpts, so a label cannot lie about the bar.
      const { authoredRoots } = entry.state;
      const effective: EffectiveGlobals = resolveEffectiveGlobals(
        entry.state.config,
        (key: string) => sessionState.get(req.hookData.session_id, key),
        (preset: string) => authoredRoots.has(preset),
      );
      const payload = await buildRenderPayload(
        req.hookData,
        payloadDeps,
        req.cwd,
        entry.state.neededInputPaths,
        effective,
        hints,
      );
      // [LAW:one-source-of-truth][LAW:dataflow-not-control-flow] Never frozen on
      // a cache entry that serves many sessions, so a theme click recolors live.
      const basePalette = paletteForThemeName(effective.theme);
      renderOpts.style = effective.style;
      // `undefined` is pickJoiner's own default, not an absence to branch on.
      renderOpts.separator = effective.separator;
      renderOpts.wrap = effective.autoWrap;
      renderOpts.padding = effective.padding;
      renderOpts.charset = effective.charset;
      renderOpts.colorCompatibility = effective.colorCompatibility;
      // [LAW:single-enforcer] renderDsl applies the input; pre-applying double-fires.
      const body = renderDsl(
        entry.state.config,
        entry.state.compiled,
        entry.state.store,
        entry.state.registry,
        payload,
        basePalette,
        renderOpts,
        { perSegmentSink: entry.state.lastRenderCellsBySegment },
        {
          look: lookKeyByName(entry.state.config.looks, effective.look),
          preset: effective.preset,
        },
      );
      // [LAW:one-source-of-truth] Cleared so it shows exactly once, and only
      // when non-null so an idle render pays no persist and no MobX tick.
      const clickError = sessionState.get(
        req.hookData.session_id,
        "click.error",
      );
      if (clickError)
        sessionState.clear(req.hookData.session_id, "click.error");
      const combinedError = [unknownFlagsError, entry.lastError, clickError]
        .filter(Boolean)
        .join("\n");
      const updates = updateWatch.notice({
        sessionId,
        dismissed: sessionState.get(sessionId, UPDATE_DISMISSED_KEY),
        enabled: effective.updateNotice,
      });
      // [LAW:no-silent-failure] Rides along so the strip offers a file:// link
      // when our own click path may be the broken thing.
      const failedConfigFile =
        entry.lastError === null ? null : entry.configFilePath;
      const diagnostics = collectDiagnostics(
        combinedError,
        updates,
        entry.lastWarning ?? "",
      );
      // [LAW:effects-at-boundaries] Written before the strip that links it, and
      // the link comes from the outcome, so the trailer names no missing file.
      const dumpFailure = diagnosticDump.sync(
        sessionId,
        diagnostics === null ? null : formatDiagnosticDump(diagnostics),
      );
      if (dumpFailure !== null)
        dlog("warn", `diagnostic dump failed: ${dumpFailure}`);
      const output = composeWithDiagnostics(
        body,
        diagnostics,
        {
          fullText:
            dumpFailure === null
              ? { kind: "file", path: diagnosticDump.pathFor(sessionId) }
              : { kind: "unavailable", reason: dumpFailure },
          failedConfigFile,
        },
        { width, rowCap, colorCompatibility: effective.colorCompatibility },
      );
      const ms = Date.now() - t0;
      const g = gitService.getStats();
      const u = usageStore.getStats();
      dlog(
        "info",
        `render sid=${req.hookData.session_id ?? "?"} took=${ms}ms termCols=${termCols ?? "?"} termRows=${hints.termRows ?? "?"} width=${width} git=${g.size}/${g.hits}h/${g.misses}m usage=${u.size}/${u.hits}h/${u.misses}m err=${combinedError ? "Y" : "N"} upd=${updates.length} warn=${entry.lastWarning ? "Y" : "N"}`,
      );
      return stay({ ok: true, output: output + "\n" });
    } catch (e) {
      stats.requestsErrored++;
      throw e;
    }
  }

  if (req.kind === "click") {
    return stay(await handleClick(req.verb, req.value));
  }

  if (req.kind === "debug") {
    // [LAW:single-enforcer] One trust-boundary check at the wire edge.
    if (!isDebugWhat(req.what)) {
      return stay({
        ok: false,
        // [LAW:errors-context-in-errors] Name the allowed values, so no grep.
        error: `unknown debug 'what': ${String(req.what)} (have: ${DEBUG_WHATS.join(", ")})`,
        code: "BAD_REQUEST",
        daemonV: PROTOCOL_VERSION,
      });
    }
    // [LAW:dataflow-not-control-flow] Sample an EXISTING entry; never create one
    // keyed on the daemon's own process.cwd().
    const dbgEntry = renderCache.firstState();
    // [LAW:dataflow-not-control-flow] Serialize only when the request fires, so
    // normal renders pay no per-segment serializer cost.
    const dbgState =
      dbgEntry === null
        ? null
        : {
            store: dbgEntry.store,
            registry: dbgEntry.registry,
            config: dbgEntry.config,
            compiled: dbgEntry.compiled,
            lastRenderBySegment:
              req.what === "segments"
                ? serializeSegmentCells(
                    dbgEntry.lastRenderCellsBySegment,
                    dbgEntry.config.globals.charset ?? DEFAULT_CHARSET,
                    dbgEntry.config.globals.colorCompatibility ??
                      DEFAULT_COLOR_COMPATIBILITY,
                  )
                : EMPTY_RENDER_MAP,
          };
    return stay({ ok: true, debug: buildDebugSnapshot(req.what, dbgState) });
  }

  return stay({
    ok: false,
    error: "unknown kind",
    code: "BAD_REQUEST",
    daemonV: PROTOCOL_VERSION,
  });
}

// [LAW:single-enforcer][LAW:no-silent-fallbacks] `--config <path>` is the sole
// valid render flag; every other becomes a render-time diagnostic. The token
// options emit an entry per flag without throwing on the unknown ones.
function parseRenderArgs(args: string[]): {
  configFile: string | undefined;
  unknownFlagsError: string | null;
} {
  const { values, tokens } = parseArgs({
    args: args.slice(1), // skip binary path
    options: { config: { type: "string" } },
    strict: false,
    tokens: true,
    allowPositionals: true,
  });
  const unknown = [
    ...new Set(
      (tokens ?? [])
        .filter(
          (t): t is Extract<typeof t, { kind: "option" }> =>
            t.kind === "option" && t.name !== "config",
        )
        .map((t) => `--${t.name}`),
    ),
  ];
  return {
    configFile: sanitizeConfigPath(values.config),
    unknownFlagsError:
      unknown.length > 0 ? `Unknown flags: ${unknown.join(", ")}` : null,
  };
}

// [LAW:dataflow-not-control-flow] The dispatcher only routes; the verb table is
// canonical. [LAW:types-are-the-program] The error class picks the response code.

const verbCtx = {
  sessionState,
  dlog,
  applyUpdate: () => updateWatch.act(),
  doctor: productionEdge(),
};

const RENDER_OPTS_BASE = {
  style: "powerline" as const,
  colorCompatibility: DEFAULT_COLOR_COMPATIBILITY,
  wrap: DEFAULT_WRAP,
  padding: DEFAULT_PADDING,
  charset: DEFAULT_CHARSET,
};
const DEBUG_RENDER_OPTS: BuildLineOptions = {
  ...RENDER_OPTS_BASE,
  width: Number.POSITIVE_INFINITY,
};

// [LAW:no-defensive-null-guards] Reused empty map the type still requires.
const EMPTY_RENDER_MAP = new Map<string, string>();

// [LAW:one-source-of-truth] Config-only, so derivable from the sampled entry —
// unlike style, whose resolution needs a session a debug request does not carry.
function serializeSegmentCells(
  cells: ReadonlyMap<string, readonly RichText[]>,
  charset: Charset,
  colorCompatibility: ColorCompatibility,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const [name, segCells] of cells) {
    out.set(
      name,
      renderStripCells(segCells, {
        ...DEBUG_RENDER_OPTS,
        charset,
        colorCompatibility,
      }),
    );
  }
  return out;
}

// [LAW:single-enforcer] The data the daemon brings to each render tick.
const payloadDeps = {
  gitProvider: gitService,
  usageStore,
  contextProvider,
  metricsProvider,
  tmuxService,
  log: dlog,
  // [LAW:single-enforcer] The one instant source ETA and countdown both read.
  clock: () => new Date(),
};

function handleClick(verb: string, value: string): Response {
  const handler = VERBS.get(verb);
  if (!handler) {
    return {
      ok: false,
      error: `unknown click verb: ${verb}`,
      code: "BAD_REQUEST",
      daemonV: PROTOCOL_VERSION,
    };
  }
  try {
    handler(value, verbCtx);
    return { ok: true, output: "" };
  } catch (e) {
    const code = e instanceof BadVerbArgs ? "BAD_REQUEST" : "RENDER_FAILED";
    return {
      ok: false,
      error: String(e instanceof Error ? e.message : e),
      code,
      daemonV: PROTOCOL_VERSION,
    };
  }
}

// [LAW:verifiable-goals] `cc-candybar doctor` — the doctor's second surface,
// and the agent-runnable one: the SAME `runDoctor` fold the bar's 🩺 click
// runs, over facts gathered from THIS process's environment (Claude Code's own
// when run from a Claude Code shell, so `TMUX`/`TMUX_PANE`/the truecolor
// switch are what Claude Code sees), projected onto text + an exit code:
//   0 — every check ok
//   1 — at least one check failed (its reason on the line)
//   2 — usage error, or Claude Code's settings.json unreadable
//
// [LAW:single-enforcer] No parallel check logic: the CLI differs from the click
// only in WHERE its facts come from — its own env and directory here, the
// session's recorded client hint and render origin there; a link it opens
// itself here (handler-probe.ts), the click that asked there — and the fold
// is one function either way.

import { openSync } from "node:fs";
import process from "node:process";
import { WriteStream } from "node:tty";
import type { CliPlan } from "../check.js";
import { DOOR_GLYPH } from "../config/disclosure.js";
import {
  barsOf,
  inScope,
  ownProject,
  scopeOf,
  type SightedBar,
  type SightingScope,
} from "./sightings.js";
import { detectClientHints } from "../client-hints.js";
import {
  runDoctor,
  type Asked,
  type Width,
  type CheckReport,
  type DoctorFacts,
  type InstallFacts,
} from "./checks.js";
import {
  askDaemon,
  type DaemonAnswer,
  type DaemonClients,
  type FrameSightings,
  type RateLimitSightings,
  type TranscriptSightings,
  type WidthSightings,
} from "./daemon-answer.js";
import {
  gatherFacts,
  installFacts,
  productionEdge,
  sessionWidth,
  type ConfigLoad,
  type InstallEdge,
  type ConfigOrigin,
  type DoctorEdge,
} from "./edge.js";
import {
  probeUrlHandler,
  productionHandlerProbeEdge,
  type HandlerProbeEdge,
} from "./handler-probe.js";
import { detectConfigEnv } from "../config-hint.js";
import { explicitConfigPath } from "../utils/user-path.js";
import { fallbackState, loadFromDisk } from "../daemon/cache/render.js";
import { SessionState } from "../daemon/session-state.js";
import { WatcherRegistry } from "../daemon/cache/watchers.js";
import { ManagedStorage } from "../daemon/cache/managed-storage.js";
import { quietLogger } from "../utils/logger.js";
import { claudeConfigDir } from "../claude-settings.js";
import type {
  RateLimitsSeen,
  TranscriptSaid,
} from "../daemon/render-sightings.js";

const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_USAGE = 2;

const FIX_HINT = ` (fix: click the settings menu (${DOOR_GLYPH} by default) › 🧰 tools › 🩺 doctor, then [fix] on the bar)`;

// The CLI has no bar to show glyphs in, so it cannot take a mark; it reads the
// marks made in the bar's doctor (the mark book), and points there.
const MARK_HINT = `mark them ✓ shapes or ✗ boxes in the bar's doctor, and this command reads your mark: the settings menu (${DOOR_GLYPH} by default) › 🧰 tools › 🩺 doctor`;

// A failed check's line, then one indented line per further problem it found,
// then what it asks the user to look at.
function reportLine({ check, verdict }: CheckReport): string {
  return verdict.ok
    ? `✓ ${check.label}${verdict.note === undefined ? "" : ` — ${verdict.note}`}\n`
    : `✗ ${check.label} — ${verdict.reason}${verdict.fix === undefined ? "" : FIX_HINT}\n` +
        (verdict.more ?? []).map((problem) => `    ${problem}\n`).join("") +
        (verdict.sighting === undefined
          ? ""
          : `    look: ${verdict.sighting.glyphs} — ${MARK_HINT}\n`);
}

// [LAW:single-enforcer] The CLI's config load is the daemon's own
// `loadFromDisk`, run once: it has no cache entry to read, so it builds the
// state, keeps the outcome, and releases the sources the state started. A
// load that failed reads the bar a fresh daemon would draw under the error.
export function loadConfigOnce(origin: ConfigOrigin): ConfigLoad {
  // The load holds the storage folders its plugins declare, as the daemon's
  // does, and releases them with the state.
  const watchers = new WatcherRegistry();
  const storage = new ManagedStorage({ watchers, logger: quietLogger });
  const deps = { sessionState: new SessionState(), storage };
  try {
    const loaded = loadFromDisk(
      origin.projectDir,
      origin.cwd,
      origin.configFile ?? undefined,
      deps,
    );
    const state =
      loaded.state ?? fallbackState(origin.cwd, origin.projectDir, deps);
    state.registry.dispose();
    return {
      layers: loaded.layers,
      error: loaded.error,
      warning: loaded.warning,
      unused: state.unused,
      config: state.config,
    };
  } finally {
    storage.close();
    watchers.closeAll();
  }
}

// The install facts of the daemon's answer: the clients that drew the scope's
// bars, and the bundle the daemon runs.
export function installOf(
  edge: InstallEdge,
  scope: SightingScope,
  asked: Asked<DaemonClients>,
): InstallFacts {
  return asked.kind === "failed"
    ? asked
    : installFacts(
        edge,
        asked.value.bundle,
        inScope(scope, asked.value.clients).map(({ client }) => client),
      );
}

// What the scope's renders said of the rate-limit windows, from sessions
// running with this Claude Code directory — the windows are that directory's
// account's, so a session of another (a second Claude Code directory on the
// machine) says nothing about this one.
export function rateLimitsOf(
  scope: SightingScope,
  asked: Asked<RateLimitSightings>,
  configDir: string,
): Asked<readonly RateLimitsSeen[]> {
  return asked.kind === "failed"
    ? asked
    : {
        kind: "ok",
        value: inScope(scope, asked.value)
          .filter((s) => s.claudeConfigDir === configDir)
          .map((s) => s.rateLimits),
      };
}

// The transcripts the scope's renders named — a transcript is its session's,
// whichever Claude Code directory it runs in.
export function transcriptsOf(
  scope: SightingScope,
  asked: Asked<TranscriptSightings>,
): Asked<readonly TranscriptSaid[]> {
  return asked.kind === "failed"
    ? asked
    : {
        kind: "ok",
        value: inScope(scope, asked.value).map((s) => s.transcript),
      };
}

// The bars the scope's renders drew, each with where its session reads its
// settings — so each is judged against its own chain, whichever Claude Code
// directory or project it runs in (brandon-doctor-v62x.y5d).
export function framesOf(
  scope: SightingScope,
  asked: Asked<FrameSightings>,
): Asked<readonly SightedBar[]> {
  return asked.kind === "failed"
    ? asked
    : { kind: "ok", value: barsOf(scope, asked.value) };
}

// [LAW:one-source-of-truth] The width the terminal-width row judges. Run in a
// Claude Code session's shell, it is the width that session's own statusline
// client measured, as the daemon recorded it — the fact the 🩺 click reads —
// never this shell's, which may have no terminal at all. Outside any session
// there is no client to read, so the command's own measurement stands in for
// one started here.
export function widthOf(
  scope: SightingScope,
  asked: Asked<WidthSightings>,
  measured: number | null,
): Asked<Width> {
  if (scope.kind === "recent") {
    return {
      kind: "ok",
      value: { columns: measured, of: { kind: "command" } },
    };
  }
  return asked.kind === "failed"
    ? asked
    : sessionWidth(scope.sessionId, inScope(scope, asked.value));
}

// [LAW:effects-at-boundaries] The whole CLI as data: facts in, (streams,
// exit code) out. `runDoctorCli` performs it; a test reads it.
export async function doctorPlan(
  edge: DoctorEdge,
  handler: HandlerProbeEdge,
  daemon: () => Promise<DaemonAnswer>,
  env: Readonly<Record<string, string | undefined>>,
  cwd: string,
  // Measures the terminal the command runs in (`commandTerminal`), inside
  // the one try below, so a measurement that throws is a `doctor:` line and
  // exit 2 like every other fact the run could not gather.
  measureTerminal: () => { readonly columns?: number; readonly rows?: number },
  configFile: string | undefined = undefined,
): Promise<CliPlan> {
  let facts: DoctorFacts;
  try {
    const answer = await daemon();
    // [LAW:one-source-of-truth] The hints a statusline client started here
    // would report, by the client's own detection — over the terminal the
    // command runs in, standing in for the stream Claude Code would hand
    // that client (which the command's own redirects say nothing about).
    const hints = detectClientHints(env, cwd, measureTerminal());
    // [LAW:single-enforcer] Whose bars this run judges, decided once: the
    // session it runs in, else every session that drew one recently.
    const scope = scopeOf(env.CLAUDE_CODE_SESSION_ID);
    const gathered = gatherFacts(
      edge,
      hints,
      // The config the daemon would load for a session started here: this
      // directory, in the session's own project when the run is in one,
      // under the file named on the command line (a statusline command's own
      // `--config`), else the override the statusline client would report.
      {
        projectDir: ownProject(
          scope,
          answer.frames.kind === "ok" ? answer.frames.value : [],
          cwd,
        ),
        cwd,
        configFile:
          explicitConfigPath(cwd, configFile) ??
          detectConfigEnv(env, cwd) ??
          null,
      },
      // No session: the bar a session started here opens on.
      () => null,
      answer.serving,
      rateLimitsOf(
        scope,
        answer.rateLimits,
        claudeConfigDir(hints.claudeConfigDir),
      ),
      transcriptsOf(scope, answer.transcripts),
      scope,
      framesOf(scope, answer.frames),
      widthOf(scope, answer.widths, hints.termCols ?? null),
      // [LAW:one-source-of-truth] The stores as the daemon that files them
      // read them, never under this shell's own XDG_STATE_HOME.
      answer.stores,
    );
    // Last: the probe opens a link and waits, which a run that cannot report
    // has no reason to do.
    facts = {
      ...gathered,
      urlHandler: await probeUrlHandler(handler),
      install: installOf(edge.install, scope, answer.clients),
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { stdout: "", stderr: `doctor: ${message}\n`, code: EXIT_USAGE };
  }
  const reports = runDoctor(facts);
  return {
    stdout: reports.map(reportLine).join(""),
    stderr: "",
    code: reports.every((r) => r.verdict.ok) ? EXIT_OK : EXIT_FAILED,
  };
}

// The terminal the command runs in, which the bar of a Claude Code started
// here would be drawn in: its stderr, else — `2>&1 | tee`, `2>/dev/null` —
// its controlling terminal. A process that cannot open one — none at all
// (ENXIO, an agent's tool shell), none in its container (ENOENT), or one a
// sandbox refuses (EACCES) — has no terminal to measure, which is the width
// row's failure, not the run's: every other check still has its facts.
function commandTerminal(): { readonly columns?: number } {
  if (process.stderr.isTTY) return process.stderr;
  let fd: number;
  try {
    fd = openSync("/dev/tty", "r+");
  } catch {
    return {};
  }
  const tty = new WriteStream(fd);
  const { columns } = tty;
  tty.destroy();
  return { columns };
}

// `cc-candybar doctor [config-file]` — the argv binding. The one argument is
// the config file a session's statusline command names with `--config`, so
// the CLI can check the file that session's bar renders.
export async function runDoctorCli(args: readonly string[]): Promise<never> {
  // An empty string is a mis-expanded shell variable, never "no argument".
  if (args.length > 1 || args[0] === "" || args[0]?.startsWith("--")) {
    process.stderr.write(
      "doctor: expected at most one config file\nUsage: cc-candybar doctor [config-file]\n",
    );
    process.exit(EXIT_USAGE);
  }
  const cwd = process.cwd();
  const plan = await doctorPlan(
    productionEdge(loadConfigOnce),
    productionHandlerProbeEdge(),
    askDaemon,
    process.env,
    cwd,
    commandTerminal,
    args[0],
  );
  process.stdout.write(plan.stdout);
  process.stderr.write(plan.stderr);
  process.exit(plan.code);
}

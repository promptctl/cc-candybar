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
import { detectClientHints } from "../client-hints.js";
import { runDoctor, type CheckReport, type DoctorFacts } from "./checks.js";
import {
  gatherFacts,
  productionEdge,
  type ConfigLoad,
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
    ? `✓ ${check.label}\n`
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
  const deps = { sessionState: new SessionState() };
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
}

// [LAW:effects-at-boundaries] The whole CLI as data: facts in, (streams,
// exit code) out. `runDoctorCli` performs it; a test reads it.
export async function doctorPlan(
  edge: DoctorEdge,
  handler: HandlerProbeEdge,
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
    const gathered = gatherFacts(
      edge,
      // [LAW:one-source-of-truth] The hints a statusline client started here
      // would report, by the client's own detection — over the terminal the
      // command runs in, standing in for the stream Claude Code would hand
      // that client (which the command's own redirects say nothing about).
      detectClientHints(env, cwd, measureTerminal()),
      // The config the daemon would load for a session started here: this
      // directory, under the file named on the command line (a statusline
      // command's own `--config`), else the override the statusline client
      // would report.
      {
        projectDir: cwd,
        cwd,
        configFile:
          explicitConfigPath(cwd, configFile) ??
          detectConfigEnv(env, cwd) ??
          null,
      },
      // No session: the bar a session started here opens on.
      () => null,
    );
    // Last: the probe opens a link and waits, which a run that cannot report
    // has no reason to do.
    facts = {
      ...gathered,
      urlHandler: await probeUrlHandler(handler),
      askedBy: "command",
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
    process.env,
    cwd,
    commandTerminal,
    args[0],
  );
  process.stdout.write(plan.stdout);
  process.stderr.write(plan.stderr);
  process.exit(plan.code);
}

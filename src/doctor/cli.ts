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
// session's recorded client hint and render origin there — and the fold is
// one function either way.

import process from "node:process";
import type { CliPlan } from "../check.js";
import { DOOR_GLYPH } from "../config/disclosure.js";
import { detectTmuxHint } from "../tmux-hint.js";
import { runDoctor, type CheckReport, type DoctorFacts } from "./checks.js";
import {
  gatherFacts,
  productionEdge,
  type ConfigLoad,
  type ConfigOrigin,
  type DoctorEdge,
} from "./edge.js";
import { detectConfigEnv } from "../config-hint.js";
import { loadFromDisk } from "../daemon/cache/render.js";
import { SessionState } from "../daemon/session-state.js";
import { sanitizeConfigPath } from "../daemon/protocol.js";
import { detectClaudeConfigDir } from "../claude-settings.js";

const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_USAGE = 2;

const FIX_HINT = ` (fix: click the settings menu (${DOOR_GLYPH} by default) › 🧰 tools › 🩺 doctor, then [fix] on the bar)`;

// A failed check's line, then one indented line per further problem it found.
function reportLine({ check, verdict }: CheckReport): string {
  return verdict.ok
    ? `✓ ${check.label}\n`
    : `✗ ${check.label} — ${verdict.reason}${verdict.fix === undefined ? "" : FIX_HINT}\n` +
        (verdict.more ?? []).map((problem) => `    ${problem}\n`).join("");
}

// [LAW:single-enforcer] The CLI's config load is the daemon's own
// `loadFromDisk`, run once: it has no cache entry to read, so it builds the
// state, keeps the outcome, and releases the sources the state started.
export function loadConfigOnce(origin: ConfigOrigin): ConfigLoad {
  const loaded = loadFromDisk(
    origin.projectDir,
    origin.cwd,
    origin.configFile ?? undefined,
    { sessionState: new SessionState() },
  );
  loaded.state?.registry.dispose();
  return {
    path: loaded.resolvedPath,
    error: loaded.error,
    warning: loaded.warning,
    unused: loaded.state?.unused ?? [],
  };
}

// [LAW:effects-at-boundaries] The whole CLI as data: facts in, (streams,
// exit code) out. `runDoctorCli` performs it; a test reads it.
export function doctorPlan(
  edge: DoctorEdge,
  env: Readonly<Record<string, string | undefined>>,
  cwd: string,
): CliPlan {
  let facts: DoctorFacts;
  try {
    facts = gatherFacts(
      edge,
      {
        tmux: detectTmuxHint(env),
        claudeConfigDir: detectClaudeConfigDir(env, cwd),
      },
      // The config the daemon would load for a session started here: this
      // directory, under the override the statusline client would report.
      {
        projectDir: cwd,
        cwd,
        configFile: sanitizeConfigPath(detectConfigEnv(env)) ?? null,
      },
    );
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

export function runDoctorCli(args: readonly string[]): never {
  if (args.length > 0) {
    process.stderr.write(
      "doctor: takes no arguments\nUsage: cc-candybar doctor\n",
    );
    process.exit(EXIT_USAGE);
  }
  const plan = doctorPlan(
    productionEdge(loadConfigOnce),
    process.env,
    process.cwd(),
  );
  process.stdout.write(plan.stdout);
  process.stderr.write(plan.stderr);
  process.exit(plan.code);
}

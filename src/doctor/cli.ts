// [LAW:verifiable-goals] `cc-candybar doctor` — the doctor's second surface,
// and the agent-runnable one: the SAME `runDoctor` fold the bar's 🩺 click
// runs, over facts gathered from THIS process's environment (Claude Code's own
// when run from a Claude Code shell, so `TMUX`/`TMUX_PANE`/the truecolor
// switch are what Claude Code sees), projected onto text + an exit code:
//   0 — every check ok
//   1 — at least one check failed (its reason on the line)
//   2 — usage error, or ~/.claude/settings.json unreadable
//
// [LAW:single-enforcer] No parallel check logic: the CLI differs from the click
// only in WHERE its tmux facts come from — its own env here, the session's
// recorded client hint there — and the fold is one function either way.

import process from "node:process";
import { DISCLOSURE_GLYPH_CLOSED } from "../config/disclosure.js";
import { detectTmuxHint } from "../tmux-hint.js";
import { runDoctor, type DoctorFacts } from "./checks.js";
import { gatherFacts, productionEdge } from "./edge.js";

const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_USAGE = 2;

export function runDoctorCli(args: readonly string[]): never {
  if (args.length > 0) {
    process.stderr.write(
      "doctor: takes no arguments\nUsage: cc-candybar doctor\n",
    );
    process.exit(EXIT_USAGE);
  }
  let facts: DoctorFacts;
  try {
    facts = gatherFacts(productionEdge(), detectTmuxHint(process.env));
  } catch (e) {
    process.stderr.write(
      `doctor: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    process.exit(EXIT_USAGE);
  }
  const reports = runDoctor(facts);
  for (const { check, verdict } of reports) {
    process.stdout.write(
      verdict.ok
        ? `✓ ${check.label}\n`
        : `✗ ${check.label} — ${verdict.reason}${
            verdict.fix === undefined
              ? ""
              : ` (fix: click ☰ ${DISCLOSURE_GLYPH_CLOSED} 🧰 tools ${DISCLOSURE_GLYPH_CLOSED} 🩺 doctor, then [fix] on the bar)`
          }\n`,
    );
  }
  process.exit(reports.every((r) => r.verdict.ok) ? EXIT_OK : EXIT_FAILED);
}

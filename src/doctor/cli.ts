// [LAW:single-enforcer] The same `runDoctor` fold the bar's click runs, over facts from this process's own env.

import process from "node:process";
import type { CliPlan } from "../check.js";
import { DISCLOSURE_GLYPH_CLOSED } from "../config/disclosure.js";
import { detectTmuxHint } from "../tmux-hint.js";
import { runDoctor, type CheckReport, type DoctorFacts } from "./checks.js";
import { gatherFacts, productionEdge, type DoctorEdge } from "./edge.js";

const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_USAGE = 2;

const FIX_HINT = ` (fix: click ☰ ${DISCLOSURE_GLYPH_CLOSED} 🧰 tools ${DISCLOSURE_GLYPH_CLOSED} 🩺 doctor, then [fix] on the bar)`;

function reportLine({ check, verdict }: CheckReport): string {
  return verdict.ok
    ? `✓ ${check.label}\n`
    : `✗ ${check.label} — ${verdict.reason}${verdict.fix === undefined ? "" : FIX_HINT}\n`;
}

// [LAW:effects-at-boundaries] The CLI as data: facts in, (streams, code) out.
export function doctorPlan(
  edge: DoctorEdge,
  env: Readonly<Record<string, string | undefined>>,
): CliPlan {
  let facts: DoctorFacts;
  try {
    facts = gatherFacts(edge, detectTmuxHint(env));
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
  const plan = doctorPlan(productionEdge(), process.env);
  process.stdout.write(plan.stdout);
  process.stderr.write(plan.stderr);
  process.exit(plan.code);
}

// The doctor's report as SessionState: one (verdict, reason, fixable) triple
// per check, keyed by check name.
//
// [LAW:one-source-of-truth] The settings menu (src/config/settings-menu.ts)
// declares a `state` variable for every key this module names, and the
// doctor verbs (src/daemon/verbs/index.ts) write those same keys — both spell
// them through `doctorReportKeys`, so the row a check renders and the write
// its click lands cannot address different variables.
//
// Session state, not a RenderPayload projection: the report is click-driven
// per-session state, which is exactly what SessionState is THE store for, and
// `CHECKS` is static, so a fixed set of scalar keys needs no series encoding.

import { BOOLEAN_FALSE, BOOLEAN_TRUE } from "../themes/policy.js";
import {
  GLYPH_MARKS,
  type CheckReport,
  type DoctorFacts,
  type GlyphMark,
  type NerdFontFacts,
  type RecordedMark,
} from "./checks.js";
import { SETTINGS_NS } from "../config/loader/reserved-namespace.js";

export const DOCTOR_NS = `${SETTINGS_NS}doctor.`;

export const VERDICT_OK = "ok";
export const VERDICT_FAILED = "failed";
// An unwritten key reads as the state variable's default — the empty string —
// which is the report's "this check has not run" state, gating the row off.
export const VERDICT_UNRUN = "";

// `sighting` holds the glyphs a failed verdict shows the user to mark, empty
// when it shows none.
export interface ReportKeys {
  readonly verdict: string;
  readonly reason: string;
  readonly fixable: string;
  readonly sighting: string;
}

export function doctorReportKeys(checkName: string): ReportKeys {
  const base = `${DOCTOR_NS}${checkName}.`;
  return {
    verdict: `${base}verdict`,
    reason: `${base}reason`,
    fixable: `${base}fixable`,
    sighting: `${base}sighting`,
  };
}

// [LAW:one-source-of-truth] Where a check's mark lives — beside its report,
// but never written by it: a report rewrites every key it names on every run,
// and a mark is the user's, outliving the runs that read it.
export function doctorMarkKey(checkName: string): string {
  return `${DOCTOR_NS}${checkName}.mark`;
}

// The one spelling of a recorded mark, `<mark>:<sighting id>`, and its one
// reading. Only the doctor verb writes the key, so a value that does not read
// is a fault to name, never a missing mark.
export function markValue({ mark, sighting }: RecordedMark): string {
  return `${mark}:${sighting}`;
}

export function parseMark(raw: string): RecordedMark {
  const split = raw.indexOf(":");
  const mark = raw.slice(0, Math.max(split, 0));
  if (!(GLYPH_MARKS as readonly string[]).includes(mark)) {
    throw new Error(
      `doctor: a recorded mark reads ${JSON.stringify(raw)}, not <${GLYPH_MARKS.join("|")}>:<sighting>`,
    );
  }
  return { mark: mark as GlyphMark, sighting: raw.slice(split + 1) };
}

// [LAW:nothing-unseen] What the Nerd Font check reasoned over, as logfmt
// fields for the doctor's event: the glyphs it needed, the terminal it found
// (`<name>@<release>`, `-` for an unsaid release, else the arm that kept it
// from finding one) and the font it read — every field `-` where there was
// nothing to find. A value a terminal or font chose is a JSON string, since it
// may hold a space.
export function nerdFontFields(facts: NerdFontFacts): string {
  if (facts.kind === "none") return "glyphs=- terminal=- font=-";
  const { glyphs, terminal } = facts;
  const codes = [...glyphs].map((g) => g.codePointAt(0)!.toString(16));
  const found = ((): string => {
    switch (terminal.kind) {
      case "unreported":
      case "unasked":
        return terminal.kind;
      case "unknown":
        return `unknown:${JSON.stringify(terminal.called)}`;
      case "bundling":
      case "configured":
        return `${terminal.name}@${terminal.version ?? "-"}`;
    }
  })();
  const font = ((): string => {
    if (terminal.kind !== "configured") return "-";
    if (terminal.font.kind === "failed") return "failed";
    const { font: name, lacks } = terminal.font.value;
    return `${JSON.stringify(name)}:${lacks === null ? "not-installed" : `lacks${lacks.length}`}`;
  })();
  return `glyphs=${codes.join(",")} terminal=${found} font=${font}`;
}

// [LAW:nothing-unseen] The marks a doctor run reasoned over, as one logfmt
// field: `<check>:<mark>` each, `-` for none.
export function marksField(marks: DoctorFacts["marks"]): string {
  const each = Object.entries(marks).map(([check, m]) => `${check}:${m!.mark}`);
  return `marks=${each.join(",") || "-"}`;
}

// The bar's row has room for one problem: it names the first and counts the
// rest, pointing at the surface that lists them.
function rowReason(reason: string, more: readonly string[] = []): string {
  return more.length === 0
    ? reason
    : `${reason} (+${more.length} more — run \`cc-candybar doctor\`)`;
}

// [LAW:dataflow-not-control-flow] One fold from reports to the pairs a single
// setBatch commits — every key written on every run, so a check that was
// failed and is now ok has its reason and fixable cleared by the same write
// that flips its verdict, never by a second conditional clear.
export function doctorReportPairs(
  reports: readonly CheckReport[],
): ReadonlyArray<{ key: string; value: string }> {
  return reports.flatMap(({ check, verdict }) => {
    const keys = doctorReportKeys(check.name);
    return verdict.ok
      ? [
          { key: keys.verdict, value: VERDICT_OK },
          { key: keys.reason, value: "" },
          { key: keys.fixable, value: BOOLEAN_FALSE },
          { key: keys.sighting, value: "" },
        ]
      : [
          { key: keys.verdict, value: VERDICT_FAILED },
          { key: keys.reason, value: rowReason(verdict.reason, verdict.more) },
          {
            key: keys.fixable,
            value: verdict.fix === undefined ? BOOLEAN_FALSE : BOOLEAN_TRUE,
          },
          { key: keys.sighting, value: verdict.sighting?.glyphs ?? "" },
        ];
  });
}

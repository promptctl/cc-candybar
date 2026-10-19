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
import { sightingOf } from "./terminal.js";
import {
  NERD_FONT_CHECK,
  glyphSighting,
  clientStanding,
  type Asked,
  type CheckReport,
  type InstallFacts,
  type MarkBook,
  type NerdFontFacts,
  type TerminalIdentity,
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

// [LAW:nothing-unseen] What the links check reasoned over, as logfmt fields:
// whether tmux writes OSC 8 to the client the bar's terminal is attached as
// (`-` outside tmux, or where no client was seen), and whether a doctor click
// has come back from the terminal — a click's own run carries the terminal it
// just filed, so `no` there is a filing that failed; `unread` when the list
// could not be read, `-` where nothing names the terminal.
export function linkFields(
  terminal: TerminalIdentity,
  clicked: Asked<readonly string[]>,
): string {
  const client = terminal.kind === "seen" ? terminal.tmuxClient : null;
  const sighting =
    terminal.kind === "seen" ? sightingOf(terminal.identified) : null;
  const from =
    clicked.kind === "failed"
      ? "unread"
      : sighting === null
        ? "-"
        : clicked.value.includes(sighting)
          ? "yes"
          : "no";
  return `tmuxLinks=${client === null ? "-" : client.features.includes("hyperlinks") ? "yes" : "no"} clicked=${from}`;
}

// [LAW:nothing-unseen] What the UTF-8 and terminal-width checks reasoned
// over, as logfmt fields: the columns measured (`-`: none was), and whether
// tmux writes UTF-8 to the client attached to the pane's session — the same
// client `linkFields` reads (`-` where none was seen).
export function terminalFeatureFields(
  terminal: TerminalIdentity,
  termCols: number | null,
): string {
  const client = terminal.kind === "seen" ? terminal.tmuxClient : null;
  return `cols=${termCols ?? "-"} clientUtf8=${client === null ? "-" : client.utf8 ? "yes" : "no"}`;
}

// [LAW:nothing-unseen] What the install check reasoned over, as one logfmt
// field: each client it judged as `<kind>/<bundle>/<source>` — its kind
// (`unreported` for one too old to say), and its standing (clientStanding):
// its bundle `same`/`other`/`unresolved`, its build `same`/`other`/
// `unstamped`/`unreadable`, `-` where it is not compared. `unasked` when the daemon could
// not be asked, `-` when no client was.
export function installFields(install: InstallFacts): string {
  if (install.kind === "failed") return "clients=unasked";
  const { daemon, clients } = install.value;
  const described = clients.map((c) => {
    if (c.kind === "unreported") return "unreported/-/-";
    const { bundle, source } = clientStanding(daemon, c);
    return `${c.client}/${bundle.kind}/${source.kind === "uncompared" ? "-" : source.kind}`;
  });
  return `clients=${described.join(",") || "-"}`;
}

// [LAW:nothing-unseen] What the Nerd Font check reasoned over, as logfmt
// fields for the doctor's event: the glyphs it needed, the terminal it found
// (`<name>@<release>`, `-` for an unsaid release, else the arm that kept it
// from finding one), the font it read and the mark it honoured, the one made
// on the sighting it shows (`unread` when the mark book could not be read) —
// every field `-` where there was nothing to find.
// A value a terminal or font chose is a JSON string, since it may hold a space.
export function nerdFontFields(
  facts: NerdFontFacts,
  marks: Asked<MarkBook>,
): string {
  if (facts.kind === "none") return "glyphs=- terminal=- font=- mark=-";
  const { glyphs, terminal } = facts;
  const codes = [...glyphs].map((g) => g.codePointAt(0)!.toString(16));
  const found = ((): string => {
    switch (terminal.kind) {
      case "unreported":
      case "unasked":
        return terminal.kind;
      case "unknown":
        return `unknown:${JSON.stringify(terminal.called)}`;
      case "unnamed":
        return `unnamed:${JSON.stringify(terminal.term)}`;
      case "bundling":
      case "unread":
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
  const sighting = glyphSighting(facts);
  const mark =
    marks.kind === "failed"
      ? "unread"
      : sighting === undefined
        ? "-"
        : (marks.value[NERD_FONT_CHECK]?.[sighting.id] ?? "-");
  return `glyphs=${codes.join(",")} terminal=${found} font=${font} mark=${mark}`;
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

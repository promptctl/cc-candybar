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
  otherDaemons,
  unreadPostMortems,
  refreshedFrames,
  statusLineOf,
  envVarOf,
  TMUX_TRUECOLOR_VAR,
  type Asked,
  type Width,
  type CheckReport,
  type ConfigFacts,
  type DaemonFacts,
  type DoctorFacts,
  type InstallFacts,
  type MarkBook,
  type NerdFontFacts,
  type SegmentDataFacts,
  type TranscriptRead,
  type TerminalIdentity,
} from "./checks.js";
import type { SettingsSource } from "../claude-settings.js";
import { SETTINGS_NS } from "../config/reserved-names.js";
import { mb, measureOf } from "../daemon/limits.js";
import { valueOf } from "../utils/logfmt.js";
import { FRAMES_SEEN, type FrameSeen } from "../daemon/render-sightings.js";

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

// Which spelling named the config the run judged.
export function configFields({ target }: ConfigFacts): string {
  return `configTarget=${target.source}`;
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
// over, as logfmt fields: the columns measured (`-`: none was, `failed`: no
// render of the session says) and whose terminal they are, and whether
// tmux writes UTF-8 to the client attached to the pane's session — the same
// client `linkFields` reads (`-` where none was seen).
export function terminalFeatureFields(
  terminal: TerminalIdentity,
  width: Asked<Width>,
): string {
  const client = terminal.kind === "seen" ? terminal.tmuxClient : null;
  const cols =
    width.kind === "failed"
      ? "failed widthOf=-"
      : `${width.value.columns ?? "-"} widthOf=${width.value.of.kind}`;
  return `cols=${cols} clientUtf8=${client === null ? "-" : client.utf8 ? "yes" : "no"}`;
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

const signedMb = (bytes: number): string =>
  `${bytes >= 0 ? "+" : ""}${mb(bytes)}`;

// [LAW:nothing-unseen] What the daemon check reasoned over, as logfmt fields:
// how many daemons run and which besides the serving one, the serving one's
// memory against its limit (RSS standing in carrying, signed, what its gap
// moved it by: `rss-stand-in(-150)`, or `(+5)` where the footprint ran over
// RSS), and its post-mortems as
// `<unread>/<total>` — `unread` where a list could not be read, `unasked`
// where no daemon answered.
export function daemonFields({
  serving,
  processes,
  read,
}: DaemonFacts): string {
  const running =
    processes.kind === "failed"
      ? "daemons=unread others=-"
      : `daemons=${processes.value.length} others=${
          otherDaemons(serving, processes.value)
            .map((p) => p.pid)
            .join(",") || "-"
        }`;
  if (serving.kind === "failed") {
    return `${running} memory=unasked postMortems=unasked`;
  }
  const { memory, limit, postMortems } = serving.value;
  const told =
    postMortems.kind === "failed" || read.kind === "failed"
      ? "unread"
      : `${unreadPostMortems(serving.value, read).length}/${postMortems.value.length}`;
  const held =
    memory.kind === "unmeasured"
      ? "unmeasured"
      : `${measureOf(memory.charge)}${
          memory.charge.kind === "stand-in"
            ? `(${signedMb(-memory.charge.gap)})`
            : ""
        }:${mb(memory.charge.bytes)}`;
  return `${running} memory=${held}/${mb(limit)} postMortems=${told}`;
}

// [LAW:nothing-unseen] What the segment-data check reasoned over, as one
// logfmt field: per source, what was found — `-` where no segment needs it.
// `pr`: ready, missing, logged-out, no-forge (the checkout names none) or
// failed; `rateLimits`: the renders that carried / lacked / had no response
// yet.
export function dataFields(data: SegmentDataFacts): string {
  const pr = (): string => {
    if (data.pullRequests.kind === "unneeded") return "-";
    const fact = data.pullRequests.fact;
    if (fact.kind === "failed") return "failed";
    if (fact.value === null) return "no-forge";
    const { status } = fact.value;
    return typeof status === "string" ? status : "logged-out";
  };
  const rateLimits = (): string => {
    if (data.rateLimits.kind === "unneeded") return "-";
    const fact = data.rateLimits.fact;
    if (fact.kind === "failed") return "failed";
    const count = (seen: string) => fact.value.filter((v) => v === seen).length;
    return `${count("carried")}/${count("missing")}/${count("unanswered")}`;
  };
  return `data=pr:${pr()},rateLimits:${rateLimits()}`;
}

// [LAW:nothing-unseen] What the effect-refresh check reasoned over, as two
// logfmt fields: the frames the statusline renders drew, counted per
// `FRAMES_SEEN` member in its order — moves/can-move/still/failed/drawing
// (brandon-doctor-v62x.tgp); `failed` when the renders could not be asked.
// Then each settings chain read, the run's own first
// (brandon-doctor-v62x.y5d): the scope its statusLine comes from and the
// refresh interval it holds (`-` for none), `absent` when no file sets one,
// `not-an-object`, or `failed` when the chain could not be read.
export function frameFields(
  frames: DoctorFacts["frames"],
  { origin, elsewhere }: DoctorFacts["claudeSettings"],
): string {
  const chains = [origin, ...elsewhere];
  const lines = chains.map(({ sources }) => statusLineValue(sources)).join(",");
  if (frames.kind === "failed") {
    return `frames=failed chains=${valueOf(lines)}`;
  }
  const drawn = refreshedFrames(chains.flatMap((c) => c.bars));
  const count = (seen: FrameSeen) =>
    drawn.filter((f) => f.frame === seen).length;
  return `frames=${FRAMES_SEEN.map(count).join("/")} chains=${valueOf(lines)}`;
}

// One chain's statusLine, as the `chains=` field spells it. The interval is
// the file's raw value, quoted with the whole field by `valueOf`, so a string
// with a space in it cannot open a field of its own.
function statusLineValue(sources: Asked<readonly SettingsSource[]>): string {
  const line = statusLineOf(sources);
  switch (line.kind) {
    case "unread":
      return "failed";
    case "absent":
    case "not-an-object":
      return line.kind;
    case "present":
      return `${line.from.scope}:${line.refreshInterval === undefined ? "-" : JSON.stringify(line.refreshInterval)}`;
  }
}

// [LAW:nothing-unseen] Which settings file holds the truecolor variable
// Claude Code runs with, as one logfmt field: its scope and the raw value,
// `unset` when no file sets it, or `failed` when the chain could not be read.
export function truecolorEnvFields(
  sources: Asked<readonly SettingsSource[]>,
): string {
  const told = envVarOf(sources, TMUX_TRUECOLOR_VAR);
  if (told.kind === "failed") return "truecolorEnv=failed";
  return told.value.kind === "unset"
    ? "truecolorEnv=unset"
    : `truecolorEnv=${valueOf(`${told.value.from.scope}:${JSON.stringify(told.value.value)}`)}`;
}

// [LAW:nothing-unseen] What the session-data check reasoned over, as one
// logfmt field: the transcripts read, absent (no file — a finding only once
// Claude Code has answered) and unreadable, then the lines that were not JSON
// objects across them; `failed` when the renders could not be asked.
export function transcriptFields(
  transcripts: Asked<readonly TranscriptRead[]>,
): string {
  if (transcripts.kind === "failed") return "transcripts=failed";
  const count = (kind: TranscriptRead["read"]["kind"]) =>
    transcripts.value.filter((t) => t.read.kind === kind).length;
  const unparsed = transcripts.value.reduce(
    (n, t) => n + (t.read.kind === "ok" ? t.read.value.unparsed : 0),
    0,
  );
  return `transcripts=${count("ok")}/${count("absent")}/${count("failed")} unparsed=${unparsed}`;
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
          { key: keys.reason, value: verdict.note ?? "" },
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

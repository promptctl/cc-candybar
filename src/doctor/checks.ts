// The doctor: checks over the user's setup, each landing in ok or failed, a
// failed check carrying a reason and — when one exists — a typed fix.
//
// [LAW:effects-at-boundaries] Everything here is pure over a `DoctorFacts`
// record. The edge (src/doctor/edge.ts) assembles the facts (the recorded
// client hint, the tmux query, the settings.json read) and performs a `Fix`;
// a probe only decides, so every verdict is unit-testable over a fixture with
// no mocks (test/doctor-checks.test.ts).
//
// [LAW:one-type-per-behavior] Checks are DATA in one `CHECKS` list and the
// doctor is a fold over it: the second check is one more row here (and one
// more label), no logic edit anywhere — the settings menu mints its report row
// from this list, the CLI prints one line per entry, the verbs gate `[fix]` by
// membership in it.

import { TMUX_ENV, type TmuxHint } from "../tmux-hint.js";
import { CONFIG_ENV, chainName, type ConfigTarget } from "../config-hint.js";
import { LANE_NAMES } from "../config/lanes.js";
import type { ClientKind } from "../client-hint.js";
import { DEFAULT_TERMINAL_WIDTH } from "../render/strip.js";
import type { Outcome } from "../utils/outcome.js";
import {
  isJsonObject,
  projectLocalSettingsFile,
  type SettingsChainAt,
  type SettingsScope,
  type SettingsSource,
} from "../claude-settings.js";
import {
  SIGHTINGS_KEPT,
  type FrameSighting,
  type RateLimitsSeen,
  type TranscriptSaid,
} from "../daemon/render-sightings.js";
import type { DeclKind, UnusedDecl } from "../config/unused.js";
import type { SightingScope } from "./sightings.js";
import {
  approachingLimit,
  chargeWords,
  laterIdentity,
  mb,
  type PostMortem,
  type ServingDaemon,
} from "../daemon/limits.js";
import {
  LINK_TERMINALS,
  TERMINALS,
  identifiedAs,
  linkSupport,
  releasedSince,
  sightingOf,
  terminalLabel,
  type BundlingTerminal,
  type ConfiguredTerminal,
  type Identified,
  type LinkSupport,
  type TmuxClientTerm,
  type UnreadTerminal,
} from "./terminal.js";

// [LAW:types-are-the-program] What tmux says about the client attached to the
// session's pane, or why it could not be asked: its verdict on the terminal's
// features (`#{client_termfeatures}`), what that terminal is
// (TmuxClientTerm), and the client's process (`#{client_pid}`), whose
// ancestry says whether it was attached over a remote login. No `absent` arm:
// the query either answers or fails — there is no "tmux has no opinion", so a
// probe never has to decide what an absent answer would mean.
export interface TmuxClient extends TmuxClientTerm {
  readonly features: readonly string[];
  readonly pid: number;
  // `#{client_utf8}`: whether tmux writes UTF-8 to this client. Without it
  // tmux draws every non-ASCII cell as `_` (measured on tmux 3.7b).
  readonly utf8: boolean;
}

// A question put to the system: it answers or it fails, never "no opinion".
export type Asked<T> = Extract<Outcome<T>, { kind: "ok" | "failed" }>;

// [LAW:types-are-the-program] The tmux facts have THREE states and each is a
// different truth the check must say: the client that rendered last carried
// no tmux hint at all (too old — the staged native binary does not turn over
// with the npm package), it reported "not in tmux", or it reported the facts.
// Collapsing `unreported` into `outside` would make a stale client look like a
// healthy setup ([LAW:no-silent-failure]).
export type TmuxFacts =
  | { readonly kind: "unreported" }
  | { readonly kind: "outside" }
  | {
      readonly kind: "inside";
      readonly hint: TmuxHint;
      // null: no client is attached to the pane's session — tmux's answer,
      // not a failure.
      readonly client: Asked<TmuxClient | null>;
    };

// [LAW:types-are-the-program] What loading the session's config found. The
// two arms are the loader's own: a config that did not load has an error and
// nothing to analyse (the bar is rendering an older config, or the bundled
// default, under it), and one that loaded has no error. `layers` are the
// files merged, lowest first — none is the bundled default. `warnings` are
// the advisories the load earned on the way, in either arm.
export type ConfigFacts = {
  readonly layers: readonly string[];
  readonly target: ConfigTarget;
  readonly warnings: readonly string[];
} & (
  | { readonly kind: "failed"; readonly error: string }
  | {
      readonly kind: "loaded";
      // What the file declares that nothing uses.
      readonly unused: readonly UnusedDecl[];
    }
);

// The app Launch Services opens `cc-candybar://` with, and the files its
// script runs that are not on disk (or why the script could not be read).
export interface HandlerApp {
  readonly app: string;
  readonly missing: Asked<readonly string[]>;
}

// [LAW:types-are-the-program] What became of a `cc-candybar://` link. The one
// proof that the URL handler works is a link coming back through it, so that
// is the discriminator: `arrived` carries the version the handler that
// delivered it reports (null from one too old to say) beside the bar's own;
// `lost` carries what the system says about why — only a lost link is
// diagnosed, an arrived one needs no explanation. `unsupported` is a platform
// with no handler (clicks are macOS-only), `unprobed` a probe that could not
// be attempted.
export type UrlHandlerFacts =
  | { readonly kind: "unsupported" }
  | { readonly kind: "unprobed"; readonly reason: string }
  | {
      readonly kind: "arrived";
      readonly handler: string | null;
      readonly bar: string;
    }
  | {
      readonly kind: "lost";
      // Why the link could not be opened at all, or null: it was opened.
      readonly unopened: string | null;
      readonly opener: Asked<HandlerApp | null>;
    };

// [LAW:types-are-the-program] The `statusLine` Claude Code runs, as the
// settings chain resolves it, and the file it comes from. Absent is its own
// arm, not an empty object: a fix may only add a key beside a command that is
// already there, because a `statusLine` holding nothing but a refresh interval
// is one Claude Code cannot run — and it names the files that were read, since
// the statusLine then comes from a scope no file holds. `refreshInterval` is
// raw — whatever the file holds; a probe decides what it means. A `statusLine`
// that is not an object is a fact too, read by the one check it concerns, and
// so is a chain that could not be read: never a throw that would take every
// other verdict with it.
export type StatusLineFacts =
  | { readonly kind: "unread"; readonly reason: string }
  | { readonly kind: "absent"; readonly read: readonly string[] }
  | {
      readonly kind: "not-an-object";
      readonly value: unknown;
      readonly from: SettingsFrom;
    }
  | {
      readonly kind: "present";
      readonly refreshInterval: unknown;
      readonly from: SettingsFrom;
    };

export type SettingsFrom = Pick<SettingsSource, "scope" | "path">;

// [LAW:one-source-of-truth] "Claude Code uses the value from the highest level
// that sets it" (code.claude.com/docs/en/settings), read over the one chain
// `readSettingsChain` lists: the first scope holding a file that sets
// `statusLine` wins it whole. Inside that scope its files merge as Claude Code
// merges managed drop-ins — a nested block key by key, a later file's single
// value replacing an earlier one — so the run of objects from the highest
// file down, stopping at a file whose `statusLine` is not one (the object
// above replaces it), is the statusLine; `refreshInterval` comes from the
// highest of them that sets it. Whether Claude Code also merges a statusLine's
// keys ACROSS scopes is undocumented and unverified: read as not merged, a
// wrong guess fails the check where it might pass, never the reverse.
export function statusLineOf(
  sources: Asked<readonly SettingsSource[]>,
): StatusLineFacts {
  if (sources.kind === "failed") {
    return { kind: "unread", reason: sources.reason };
  }
  const lines = sources.value.flatMap(({ scope, path, settings }) =>
    "statusLine" in settings
      ? [{ from: { scope, path }, line: settings.statusLine }]
      : [],
  );
  const top = lines[0];
  if (top === undefined) {
    return { kind: "absent", read: sources.value.map((s) => s.path) };
  }
  if (!isJsonObject(top.line)) {
    return { kind: "not-an-object", value: top.line, from: top.from };
  }
  for (const { from, line } of lines) {
    if (from.scope !== top.from.scope || !isJsonObject(line)) break;
    if ("refreshInterval" in line) {
      return { kind: "present", refreshInterval: line.refreshInterval, from };
    }
  }
  return { kind: "present", refreshInterval: undefined, from: top.from };
}

// [LAW:one-source-of-truth] Claude Code merges `env` key by key across its
// settings files, so a variable's value is the one the highest file holding
// that key sets — read over the one chain `readSettingsChain` lists, as
// `statusLineOf` reads `statusLine`.
export function envVarOf(
  sources: Asked<readonly SettingsSource[]>,
  name: string,
): Asked<
  | { readonly kind: "unset" }
  | {
      readonly kind: "set";
      readonly value: unknown;
      readonly from: SettingsFrom;
    }
> {
  if (sources.kind === "failed") return sources;
  const top = sources.value.find((s) => Object.hasOwn(s.env, name));
  return {
    kind: "ok",
    value:
      top === undefined
        ? { kind: "unset" }
        : {
            kind: "set",
            value: top.env[name],
            from: { scope: top.scope, path: top.path },
          },
  };
}

// The scopes the doctor never writes: managed settings are an
// administrator's policy, and a project's shared `.claude/settings.json`
// belongs to its repository.
const UNWRITTEN_SCOPES = [
  "managed",
  "project",
] as const satisfies readonly SettingsScope[];

// A settings file the doctor may write: the user's own.
export type WritableSettings = SettingsFrom & {
  readonly scope: Exclude<SettingsScope, (typeof UNWRITTEN_SCOPES)[number]>;
};

// [LAW:single-enforcer] A `claude-settings` fix carries a `WritableSettings`,
// so the type is THE rule for which file a fix may name; this narrows a file
// a check read to one.
export const doctorWrites = (from: SettingsFrom): from is WritableSettings =>
  !(UNWRITTEN_SCOPES as readonly SettingsScope[]).includes(from.scope);

// [LAW:types-are-the-program] Where a fix to an `env` variable goes, by the
// scope of the file deciding its value. `env` merges key by key, so a value
// counts written in that file or any above it and loses anywhere lower: the
// lowest of those that is the user's own. Over a project's shared file that
// is its project-local one; over managed settings, none. Keyed by every
// scope, so a new scope is a compile error here until it is placed.
const ENV_FIX_FILE: {
  readonly [S in SettingsScope]: (
    path: string,
    at: SettingsChainAt,
  ) => WritableSettings | null;
} = {
  managed: () => null,
  "project-local": (path) => ({ scope: "project-local", path }),
  project: (_, at) => ({
    scope: "project-local",
    path: projectLocalSettingsFile(at.projectDir),
  }),
  user: (path) => ({ scope: "user", path }),
};

// [LAW:types-are-the-program] Which terminal draws the session's bar, or why
// the doctor could not tell: a client too old to say, or a tmux server that
// could not be asked about its client. A terminal seen is `identified` by
// what named it, and `tmuxClient` is the client tmux attached it as — null
// outside tmux, where nothing stands between the bar and the terminal.
export type TerminalIdentity =
  | { readonly kind: "unreported" }
  | { readonly kind: "unasked"; readonly reason: string }
  | {
      readonly kind: "seen";
      readonly identified: Identified;
      readonly tmuxClient: TmuxClient | null;
    };

// The font a configured terminal draws private-use glyphs with, where that
// was read from (`iTerm2 profile "Default"`, an Alacritty config file), and
// which of the bar's glyphs it lacks — null when no installed font goes by
// that name, so the terminal draws with whatever it falls back to.
export interface FontInUse {
  readonly font: string;
  readonly from: string;
  readonly lacks: readonly string[] | null;
}

// [LAW:types-are-the-program] What the doctor knows about the terminal that
// draws the session's bar. `unreported` is a client too old to say,
// `unasked` a tmux server that could not be asked about its client, `unknown`
// a terminal the doctor does not know by the name it gave itself, and
// `unnamed` one that gave none, only its TERM said of it (Identified, in
// src/doctor/terminal.ts). A known terminal is one of three kinds
// (src/doctor/terminal.ts): one that ships its own Nerd Font symbols, whose
// release is the whole question; one that draws them only from the font it is
// set to, which is read; and one whose font the doctor has no reader for.
export type TerminalFacts =
  | { readonly kind: "unreported" }
  | { readonly kind: "unasked"; readonly reason: string }
  | Exclude<Identified, { readonly kind: "known" }>
  | {
      readonly kind: "bundling";
      readonly name: BundlingTerminal;
      readonly version: string | null;
    }
  | {
      readonly kind: "unread";
      readonly name: UnreadTerminal;
      readonly version: string | null;
    }
  | {
      readonly kind: "configured";
      readonly name: ConfiguredTerminal;
      readonly version: string | null;
      readonly font: Asked<FontInUse>;
    };

// What the user saw when the doctor showed them the bar's glyphs: shapes, or
// the boxes a terminal draws for a glyph no font it has supplies.
export const GLYPH_MARKS = ["drawn", "boxes"] as const;
export type GlyphMark = (typeof GLYPH_MARKS)[number];

// Every mark the user has made: per check that takes one, the mark on each
// sighting (Sighting.id) it was made on (src/doctor/mark-book.ts keeps it).
export type MarkBook = Readonly<
  Partial<Record<string, Readonly<Record<string, GlyphMark>>>>
>;

// [LAW:types-are-the-program] A bar that draws no private-use glyph has no
// terminal to ask about, so `none` carries none and nothing is read for it.
// `glyphs` are the private-use glyphs the session's bar draws (its joiner's,
// src/render/strip.ts measures them, and its config text's), never empty.
export type NerdFontFacts =
  | { readonly kind: "none" }
  | {
      readonly kind: "glyphs";
      readonly glyphs: string;
      readonly terminal: TerminalFacts;
    };

export type DrawnGlyphs = Extract<NerdFontFacts, { kind: "glyphs" }>;

// [LAW:types-are-the-program] One client the bar was drawn by. A client too
// old to say what it is is its own arm, never a guessed kind. Its bundle is
// the path it reported, resolved through every link — or why it could not be:
// a bundle that does not exist is a finding, not a throw.
export type ClientFact =
  | { readonly kind: "unreported" }
  | {
      readonly kind: "reported";
      readonly client: ClientKind;
      readonly bundle: Asked<string>;
      // The native binary's build stamp (src/client-hint.ts).
      readonly source: string | null;
    };

// [LAW:types-are-the-program] Where the daemon runs from. `checkout` is null
// for a published install; in a source checkout it carries the digest of the
// Rust source a native client there must be built from, or why it could not
// be taken.
export interface DaemonInstall {
  readonly bundle: string;
  readonly checkout: {
    readonly root: string;
    readonly rustSource: Asked<string>;
  } | null;
}

// What the install check reasons over, or why the daemon could not be asked
// (the CLI's one way to see the clients the bar runs). `nativeShipped`: a
// native client ships for this platform. Either it does, or the daemon runs
// from a checkout, where `just install-rust` builds one on any platform cargo
// targets; then the Node fallback is a choice the install made rather than
// the only client there is.
export type InstallFacts = Asked<{
  readonly daemon: DaemonInstall;
  readonly nativeShipped: boolean;
  readonly clients: readonly ClientFact[];
}>;

// One cc-candybar daemon process of this user, as the process table shows it
// (src/doctor/edge.ts `daemonProcesses`): `rss` in bytes, `started` the
// table's own start time, its zone named.
export interface DaemonProcess {
  readonly pid: number;
  readonly ppid: number;
  readonly rss: number;
  readonly started: string;
}

// The newest post-mortem the user has filed as read: `null` while none is.
export interface PostMortemsRead {
  readonly through: string | null;
}

// The daemon row's facts (brandon-doctor-v62x.5mq): the daemon that serves
// this bar, as it reports itself (src/daemon/limits.ts `serving`); every
// daemon process running; and the newest post-mortem the user filed as read
// (src/doctor/post-mortems-read.ts).
export interface DaemonFacts {
  readonly serving: Asked<ServingDaemon>;
  readonly processes: Asked<readonly DaemonProcess[]>;
  readonly read: Asked<PostMortemsRead>;
}

// [LAW:types-are-the-program] One outside source of segment data
// (src/doctor/data-needs.ts): no placed segment counts its absence as a
// failure — so nothing was asked — or the segments that do, never empty, and
// what was found.
export type DataNeed<T> =
  | { readonly kind: "unneeded" }
  | {
      readonly kind: "needed";
      readonly segments: readonly [string, ...string[]];
      readonly fact: T;
    };

// What the forge CLI said of itself, asked locally (`gh auth token`): ready,
// not installed, or installed with no login for the remote's host (its own
// line saying so).
export type ForgeStatus = "ready" | "missing" | { readonly loggedOut: string };

export interface ForgeLogin {
  readonly cli: string;
  readonly host: string;
  readonly status: ForgeStatus;
}

export interface SegmentDataFacts {
  // null: the session's checkout names no forge (or is no checkout) — a PR
  // lookup has nothing to ask, so there is nothing to have.
  readonly pullRequests: DataNeed<Asked<ForgeLogin | null>>;
  // What each recent render's payload said of the rate-limit windows.
  readonly rateLimits: DataNeed<Asked<readonly RateLimitsSeen[]>>;
}

// The last TRANSCRIPT_WINDOW_BYTES of a transcript, read as the bar's parse
// reads each line (`jsonLine`, src/utils/claude.ts): how many lines it held, how
// many were not a JSON object, and whether the window reached the file's
// start.
export const TRANSCRIPT_WINDOW_BYTES = 1024 * 1024;

export interface TranscriptWindow {
  readonly lines: number;
  readonly unparsed: number;
  readonly whole: boolean;
}

// One session's transcript as its render named it, and what reading it found:
// absent is no file at the path.
export interface TranscriptRead extends TranscriptSaid {
  readonly read: Outcome<TranscriptWindow>;
}

// The columns a terminal was measured at (COLUMNS, else the terminal's own
// geometry), or null: none was, so the daemon lays the bar out for
// DEFAULT_TERMINAL_WIDTH — and whose terminal it was: a session's statusline
// client, as its last render said, or the one `cc-candybar doctor` runs in,
// standing in for a client started there.
export interface Width {
  readonly columns: number | null;
  readonly of:
    | { readonly kind: "session"; readonly sessionId: string }
    | { readonly kind: "command" };
}

const whoseWidth = (of: Width["of"]): string =>
  of.kind === "session"
    ? `session ${of.sessionId}'s statusline client`
    : "this command's terminal";

export interface DoctorFacts {
  readonly tmux: TmuxFacts;
  // Failed: no render of the session says.
  readonly width: Asked<Width>;
  readonly terminal: TerminalIdentity;
  readonly config: ConfigFacts;
  readonly urlHandler: UrlHandlerFacts;
  // The clients that drew the bar and the install the daemon runs from: the
  // click's own render, or — for the CLI — every session's latest render this
  // daemon process served (src/daemon/render-sightings.ts).
  readonly install: InstallFacts;
  readonly daemon: DaemonFacts;
  readonly nerdFont: NerdFontFacts;
  // The user's marks, or why the book could not be read; a check honours
  // only the mark on the sighting it shows.
  readonly marks: Asked<MarkBook>;
  // The terminals a doctor click has come back from, by their sightings
  // (`sightingOf`), or why they could not be read
  // (src/doctor/clicked-terminals.ts).
  readonly clicked: Asked<readonly string[]>;
  // Whose bars the sightings below are, and so what asked for this run
  // (src/doctor/sightings.ts): a click on the bar's 🩺 doctor, the
  // `cc-candybar doctor` command in a session's shell, or the command
  // anywhere else, judging every session that drew a bar recently.
  readonly sighted: SightingScope;
  // Whether the daemon answered what the bars drew (brandon-doctor-v62x.tgp);
  // the bars themselves sit in `claudeSettings`, beside the settings chain
  // that redraws each one.
  readonly frames:
    | { readonly kind: "read" }
    | { readonly kind: "failed"; readonly reason: string };
  // The outside data the session's placed segments read
  // (brandon-doctor-v62x.onf).
  readonly data: SegmentDataFacts;
  // The transcripts the recent renders named, each read (brandon-doctor-v62x
  // .p4l): the click's own session's, or every session `cc-candybar doctor`
  // sees.
  readonly transcripts: Asked<readonly TranscriptRead[]>;
  // The Claude Code settings chains the run read, each once: its own
  // location's (`origin`: the session's render origin for a click, the
  // command's cwd), and every other location a bar's settings are read at
  // (brandon-doctor-v62x.y5d) — each holding the bars it redraws.
  readonly claudeSettings: {
    readonly origin: SettingsChain;
    readonly elsewhere: readonly SettingsChain[];
  };
}

// [LAW:types-are-the-program] One location's Claude Code settings files,
// highest precedence first (`readSettingsChain`), and where they were read — a
// daemon-observable fact beside the client-observed env, so a verdict can say
// the truthful thing after a fix has landed but Claude Code has not
// restarted, naming the file it landed in. A chain that could not be read
// fails the rows that read it, never the run. `bars`: what the bars whose
// sessions read this chain drew — a bar's chain is where it sits, so no bar
// can name a chain the run did not read.
export interface SettingsChain {
  readonly at: SettingsChainAt;
  readonly sources: Asked<readonly SettingsSource[]>;
  readonly bars: readonly FrameSighting[];
}

// [LAW:types-are-the-program] A fix is a DESCRIPTION of an edit the edge
// performs, discriminated by kind so a second repair shape is one more arm
// here and one more case at the edge, never a callback smuggled in a verdict.
// `claude-settings` sets one value at one key path in one of the session's
// Claude Code settings files — the one its check read the value from;
// `post-mortems-read` files every post-mortem up to
// `through` as read (src/doctor/post-mortems-read.ts).
export type Fix =
  | {
      readonly kind: "claude-settings";
      readonly file: WritableSettings;
      readonly path: readonly [string, ...string[]];
      readonly value: string | number;
    }
  | { readonly kind: "post-mortems-read"; readonly through: string };

// The fix as the doctor's event names it.
export function describeFix(fix: Fix): string {
  switch (fix.kind) {
    case "claude-settings":
      return `${fix.kind} ${fix.path.join(".")}=${JSON.stringify(fix.value)} file=${JSON.stringify(fix.file.path)} scope=${fix.file.scope}`;
    case "post-mortems-read":
      return `${fix.kind} through=${fix.through}`;
  }
}

// What a check asks the user to look at when it cannot see for itself — a
// terminal cannot be asked what it drew. `glyphs` is what to show; `id` names
// the sighting (the terminal and the glyphs), which a mark is recorded under,
// so a mark answers for exactly what was shown.
export interface Sighting {
  readonly glyphs: string;
  readonly id: string;
}

// A check never has a third state: the reason string and the optional fix
// carry every difference between one failure and another. A check that found
// several problems leads with one as its `reason` and lists the rest in `more`:
// the bar's row has room for one and counts the others, the CLI prints them all.
// A `sighting` is the user's way to settle what the check could not: the row
// shows its glyphs with a ✓ and a ✗ to mark them.
// `S` is `never` for a check that takes no mark, so its verdict cannot carry
// a sighting nobody could answer.
export type Verdict<S extends Sighting = Sighting> =
  // `note`: what a pass rests on, where the user would otherwise wonder.
  | { readonly ok: true; readonly note?: string }
  | {
      readonly ok: false;
      readonly reason: string;
      readonly more?: readonly string[];
      readonly fix?: Fix;
      readonly sighting?: S;
    };

function problemsVerdict(problems: readonly string[]): Verdict<never> {
  const [reason, ...more] = problems;
  return reason === undefined ? { ok: true } : { ok: false, reason, more };
}

interface CheckBase {
  // camelCase: the name splices into state-variable and action names
  // (`candybar.doctor.<name>.verdict`), where a hyphen is not an identifier.
  readonly name: string;
  readonly label: string;
}

// [LAW:types-are-the-program] Whether a check takes the user's mark is a fact
// of the check, and only one that does may show a sighting: the menu declares
// mark actions for it alone, and the loader and the verb refuse a mark on any
// other.
export type Check =
  | (CheckBase & {
      readonly takesMark: false;
      readonly probe: (facts: DoctorFacts) => Verdict<never>;
    })
  | (CheckBase & {
      readonly takesMark: true;
      readonly probe: (facts: DoctorFacts) => Verdict;
    });

export interface CheckReport {
  readonly check: Check;
  readonly verdict: Verdict;
}

export const TMUX_TRUECOLOR_VAR = TMUX_ENV.truecolor;

// [LAW:single-enforcer] Every check of how tmux draws the bar reads the tmux
// facts through here, so none can disagree with another about what an
// unreported hint, a failed query, or a session nobody is attached to means:
// outside tmux and with no client attached, tmux draws nothing for the bar,
// so there is nothing to fault. (Which TERMINAL is attached is a different
// question — `terminalIdentity` in edge.ts — and no client there is unasked.)
function ofTmuxClient(
  tmux: TmuxFacts,
  decide: (client: TmuxClient, hint: TmuxHint) => Verdict<never>,
): Verdict<never> {
  switch (tmux.kind) {
    case "unreported":
      return {
        ok: false,
        reason:
          "the client reported no tmux facts — re-run `cc-candybar install` to stage a current client",
      };
    case "outside":
      return { ok: true };
    case "inside":
      if (tmux.client.kind === "failed") {
        return {
          ok: false,
          reason: `tmux could not be asked: ${tmux.client.reason}`,
        };
      }
      return tmux.client.value === null
        ? { ok: true }
        : decide(tmux.client.value, tmux.hint);
  }
}

// Diagnosed 2026-09-04 (brandon-doctor-b6a): Claude Code re-encodes the
// statusline at 256 colours whenever TMUX is in its environment, unless its own
// CLAUDE_CODE_TMUX_TRUECOLOR switch is truthy. The bar's daemon emits identical
// truecolor in and out of tmux, so this is a setup fault outside cc-candybar
// that makes cc-candybar look broken — which is why the bar is where it is
// diagnosed and repaired.
//
// "tmux and the outer terminal support truecolor" is ONE fact: `RGB` in
// `#{client_termfeatures}` is tmux's verdict for both layers at once.
const tmuxTruecolor: Check = {
  name: "tmuxTruecolor",
  label: "tmux truecolor",
  takesMark: false,
  probe: ({ tmux, claudeSettings: { origin } }) =>
    ofTmuxClient(tmux, (client, hint) => {
      // Not applicable is not a failure: without RGB there is nothing for
      // Claude Code to be told about.
      if (!client.features.includes("RGB")) return { ok: true };
      if (hint.truecolor !== null) return { ok: true };
      const staged = envVarOf(origin.sources, TMUX_TRUECOLOR_VAR);
      if (staged.kind === "failed") return { ok: false, reason: staged.reason };
      const told = staged.value;
      // [LAW:one-source-of-truth] The same truthiness Claude Code applies to
      // its env: a non-empty string. Anything else — absent, empty, a
      // non-string — is "not told".
      if (
        told.kind === "set" &&
        typeof told.value === "string" &&
        told.value !== ""
      ) {
        return {
          ok: false,
          reason: `${TMUX_TRUECOLOR_VAR} is set in ${told.from.path} — restart Claude Code to apply`,
        };
      }
      const reason = "Claude Code renders the bar in 256 colours inside tmux";
      const fixInto = (file: WritableSettings): Verdict<never> => ({
        ok: false,
        reason,
        fix: {
          kind: "claude-settings",
          file,
          path: ["env", TMUX_TRUECOLOR_VAR],
          value: "1",
        },
      });
      if (told.kind === "unset") {
        return fixInto({ scope: "user", path: origin.at.userFile });
      }
      const file = ENV_FIX_FILE[told.from.scope](told.from.path, origin.at);
      return file === null
        ? {
            ok: false,
            reason: `${reason} — the value that counts is in managed settings, ${told.from.path}: set ${TMUX_TRUECOLOR_VAR} to "1" there`,
          }
        : fixInto(file);
    }),
};

// "A UTF-8 locale" (brandon-doctor-v62x.1ku) is tmux's question, not the
// session's: the bar's bytes are UTF-8 whatever Claude Code's locale, and
// outside tmux nothing re-encodes them on the way to the terminal. tmux
// decides per client whether to write UTF-8, from the environment the client
// was started in, and the doctor reads its decision rather than re-deriving
// it — tmux 3.7b answered `1` for `LANG=C` and `0` for `LC_ALL=C`, which no
// reading of the variables would have predicted.
const utf8: Check = {
  name: "utf8",
  label: "UTF-8",
  takesMark: false,
  probe: ({ tmux }) =>
    ofTmuxClient(tmux, (client) =>
      client.utf8
        ? { ok: true }
        : {
            ok: false,
            reason:
              "tmux draws this terminal without UTF-8, so every glyph on the bar arrives as `_` — attach with `tmux -u`, or set a UTF-8 LC_ALL/LC_CTYPE/LANG in the shell that runs tmux",
          },
    ),
};

// The client measures the terminal so the daemon can fit the bar to it: rows
// wrap, fills spread and menus page at that width. A client that could not
// measure leaves the bar laid out for a terminal it is not drawn in. No fix:
// Claude Code, not cc-candybar, decides what the client is spawned with.
const termWidth: Check = {
  name: "termWidth",
  label: "terminal width",
  takesMark: false,
  probe: ({ width }) =>
    width.kind === "failed"
      ? { ok: false, reason: width.reason }
      : width.value.columns !== null
        ? {
            ok: true,
            note: `${width.value.columns} columns, as ${whoseWidth(width.value.of)} measured`,
          }
        : {
            ok: false,
            reason: `${whoseWidth(width.value.of)} measured no width (no COLUMNS, and no terminal to ask — or the daemon refused the width sent, which the bar's diagnostics name), so the bar is laid out as if the terminal were ${DEFAULT_TERMINAL_WIDTH} columns wide`,
          },
};

const UNUSED: Readonly<Record<DeclKind, string>> = {
  variable: "is never read",
  action: "is never clicked",
  helper: "is never called",
  segment: "is in no preset",
};

// What named a file the run judged. The search names none: its chain says what
// it found.
const NAMED_BY: Readonly<
  Record<Exclude<ConfigTarget["source"], "search">, string>
> = {
  argument: "command argument",
  environment: `$${CONFIG_ENV}`,
  pick: "load-config pick",
  unknown: "source unknown",
};

// [LAW:no-silent-failure] Which config a verdict is about. A named file reads
// as itself, never as its layers: one that is missing has none, and it is not
// the bundled default the bar draws under it.
function judgedConfig({ target, layers }: ConfigFacts): string {
  if (target.source !== "search") {
    return `${target.path} (${NAMED_BY[target.source]})`;
  }
  return layers.length === 0
    ? chainName(layers)
    : `${chainName(layers)} (searched)`;
}

function configProblems(config: ConfigFacts): readonly string[] {
  switch (config.kind) {
    case "failed": {
      const problems = [
        ...config.error
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line !== ""),
        ...config.warnings,
      ];
      // [LAW:no-silent-failure] A load that failed is never ok, even when the
      // error it threw carries no text.
      return problems.length === 0 ? ["the config failed to load"] : problems;
    }
    case "loaded":
      return [
        ...config.warnings,
        ...config.unused.map(
          ({ kind, name }) => `${kind} "${name}" ${UNUSED[kind]}`,
        ),
      ];
  }
}

// "The config is correct" (brandon-doctor-v62x.e91): it loads, the load earned
// no advisory (a duplicate key, a `.json`/`.json5` collision, a location the
// search could not check, a variable that failed to declare), and everything
// the files declare is used. A threshold whose knobs do not ascend is a load error, so it is the first of
// those. Either verdict names the file or chain it judged and what named it.
const config: Check = {
  name: "config",
  label: "config",
  takesMark: false,
  probe: ({ config }) => {
    const judged = judgedConfig(config);
    const verdict = problemsVerdict(configProblems(config));
    return verdict.ok
      ? { ok: true, note: judged }
      : { ...verdict, reason: `${judged}: ${verdict.reason}` };
  },
};

const REINSTALL = "re-run `cc-candybar install`";

function handlerAppProblems(opener: Asked<HandlerApp | null>): string[] {
  if (opener.kind === "failed") {
    return [
      `Launch Services could not be asked which app opens cc-candybar:// — ${opener.reason}`,
    ];
  }
  if (opener.value === null) {
    return [`no app is registered for cc-candybar:// — ${REINSTALL}`];
  }
  const { app, missing } = opener.value;
  return missing.kind === "failed"
    ? [`${app} opens cc-candybar://, but ${missing.reason} — ${REINSTALL}`]
    : missing.value.map(
        (file) => `${file} is missing, and ${app} runs it — ${REINSTALL}`,
      );
}

// "The URL handler works" (brandon-doctor-v62x.a1z): a `cc-candybar://` link
// comes back through it, delivered by the version the bar runs. In the bar the
// doctor's own click is that link; the CLI opens one and asks the daemon
// whether it arrived.
const urlHandler: Check = {
  name: "urlHandler",
  label: "URL handler",
  takesMark: false,
  probe: ({ urlHandler }) => {
    switch (urlHandler.kind) {
      case "unsupported":
        return { ok: true };
      case "unprobed":
        return { ok: false, reason: urlHandler.reason };
      case "arrived":
        if (urlHandler.handler === urlHandler.bar) return { ok: true };
        return {
          ok: false,
          reason:
            urlHandler.handler === null
              ? `the URL handler does not report its version, so it is older than the bar (${urlHandler.bar}) — ${REINSTALL}`
              : `the URL handler runs cc-candybar ${urlHandler.handler}; the bar runs ${urlHandler.bar} — ${REINSTALL}`,
        };
      case "lost":
        return problemsVerdict([
          ...handlerAppProblems(urlHandler.opener),
          urlHandler.unopened === null
            ? "a cc-candybar:// link was opened and did not arrive at the daemon"
            : `a cc-candybar:// link could not be opened — ${urlHandler.unopened}`,
        ]);
    }
  },
};

// For the command, which sees every session's latest client: one that has
// not rendered for this long is a session that stopped, not one the bar runs
// — long enough to keep a session with no `refreshInterval`, which renders
// only on events (src/doctor/cli.ts). A click judges its own bar however long
// it has been idle: the click is the proof it is on screen.
export const RECENT_CLIENT_S = 300;

// [LAW:types-are-the-program] Where one reported client stands against the
// daemon's install, each arm carrying what its finding names: whether its
// bundle is the daemon's, and whether its build is the Rust source of the
// checkout — `uncompared` for a Node client or a published install, where
// there is no such source.
export interface ClientStanding {
  readonly bundle:
    | { readonly kind: "same" }
    | { readonly kind: "other"; readonly path: string }
    | { readonly kind: "unresolved"; readonly reason: string };
  readonly source:
    | { readonly kind: "uncompared" }
    | {
        readonly kind: "unreadable";
        readonly root: string;
        readonly reason: string;
      }
    | { readonly kind: "unstamped" }
    | { readonly kind: "same" }
    | { readonly kind: "other"; readonly root: string };
}

// [LAW:one-source-of-truth] The one comparison of a client with the install:
// the probe words it, the doctor's event logs it (src/doctor/report.ts).
export function clientStanding(
  { bundle, checkout }: DaemonInstall,
  client: Extract<ClientFact, { kind: "reported" }>,
): ClientStanding {
  return {
    bundle:
      client.bundle.kind === "failed"
        ? { kind: "unresolved", reason: client.bundle.reason }
        : client.bundle.value === bundle
          ? { kind: "same" }
          : { kind: "other", path: client.bundle.value },
    source:
      client.client !== "native" || checkout === null
        ? { kind: "uncompared" }
        : checkout.rustSource.kind === "failed"
          ? {
              kind: "unreadable",
              root: checkout.root,
              reason: checkout.rustSource.reason,
            }
          : client.source === null
            ? { kind: "unstamped" }
            : client.source === checkout.rustSource.value
              ? { kind: "same" }
              : { kind: "other", root: checkout.root },
  };
}

// How to run the client the daemon's install draws with. `frames` from the
// daemon's own bundle, a published install's or a checkout's alike; the
// statusline through what `cc-candybar install` stages, or in a checkout
// through the native client `just install-rust` stages beside it.
function remedy(daemon: DaemonInstall, client: ClientKind): string {
  if (client === "frames")
    return `run \`node ${daemon.bundle} frames --lane <${LANE_NAMES.join("|")}>\``;
  return daemon.checkout === null
    ? REINSTALL
    : `run \`just install-rust\` and point the statusLine command at ${daemon.checkout.root}/bin/cc-candybar-native`;
}

function installProblems(
  daemon: DaemonInstall,
  nativeShipped: boolean,
  client: ClientFact,
): string[] {
  const { checkout } = daemon;
  if (client.kind === "unreported") {
    return [
      `the bar is drawn by a statusline client too old to say what it is — ${remedy(daemon, "native")}`,
    ];
  }
  const { bundle, source } = clientStanding(daemon, client);
  switch (bundle.kind) {
    case "unresolved":
      return [
        `the statusline client's bundle cannot be resolved: ${bundle.reason}`,
      ];
    case "other":
      return [
        `the statusline client runs ${bundle.path}, not the daemon's ${daemon.bundle} — ${remedy(daemon, client.client)}`,
      ];
    case "same":
      break;
  }
  if (client.client === "node" && (nativeShipped || checkout !== null)) {
    return [
      `the bar is drawn by the Node fallback, which starts node on every render — ${remedy(daemon, "native")}`,
    ];
  }
  switch (source.kind) {
    case "uncompared":
    case "same":
      return [];
    case "unreadable":
      return [`${source.root}/rust-client could not be read: ${source.reason}`];
    case "unstamped":
      return [
        "the native client carries no source stamp, so which source it was built from is unknown — run `just install-rust`",
      ];
    case "other":
      return [
        `the native client was built from other source than ${source.root}/rust-client holds — run \`just install-rust\``,
      ];
  }
}

// "The install is current" (brandon-doctor-v62x.tfb): the bar is drawn by the
// native client of the install the daemon runs from, built from the source
// beside it. Judged on the clients that DREW the bar, not on the settings
// file — managed settings, a project file or a launcher script may stand
// between what it names and what runs.
// [LAW:one-source-of-truth] Why a run judging one session's bar finds no
// sighting of it — the install, effect-refresh, segment-data and session-data
// checks all say it. A click proves the bar was drawn, so only the daemon can
// have lost it; a shell proves only that its session is alive.
const noRenderOf = (
  sighted: Exclude<SightingScope, { kind: "recent" }>,
): string => {
  const lost = `restarted since the bar was drawn, or has served ${SIGHTINGS_KEPT} newer sessions`;
  return sighted.kind === "clicked"
    ? `this daemon holds no render of this bar (it ${lost})`
    : `this daemon holds no render of session ${sighted.sessionId}'s bar (its statusLine does not run cc-candybar — a \`claude -p\` session draws none — or the daemon ${lost}; unset CLAUDE_CODE_SESSION_ID to judge every bar drawn recently)`;
};

const install: Check = {
  name: "install",
  label: "install",
  takesMark: false,
  probe: ({ install, sighted }) => {
    if (install.kind === "failed") {
      return {
        ok: false,
        reason: `the daemon could not be asked which clients draw the bar: ${install.reason}`,
      };
    }
    const { daemon, nativeShipped, clients } = install.value;
    if (clients.length === 0) {
      return {
        ok: false,
        reason:
          sighted.kind !== "recent"
            ? `${noRenderOf(sighted)}, so which client draws it is unknown — run the doctor again once the bar has redrawn`
            : `no statusline client has drawn a bar for this daemon in the last ${RECENT_CLIENT_S / 60} minutes — run the doctor again once the bar has redrawn; if it never does, the statusLine command does not run cc-candybar`,
      };
    }
    // One line per distinct problem: sessions sharing a client share it.
    return problemsVerdict([
      ...new Set(
        clients.flatMap((c) => installProblems(daemon, nativeShipped, c)),
      ),
    ]);
  },
};

// [LAW:one-source-of-truth] The post-mortems the user has not been told of:
// every one newer than the one filed read, newest first. None can be judged
// while either list is unreadable. The probe reports them; the doctor's event
// counts them (src/doctor/report.ts).
export function unreadPostMortems(
  { postMortems }: ServingDaemon,
  read: Asked<PostMortemsRead>,
): readonly PostMortem[] {
  return postMortems.kind === "ok" && read.kind === "ok"
    ? postMortems.value.filter(
        (m) =>
          read.value.through === null ||
          laterIdentity(m.identity, read.value.through),
      )
    : [];
}

// [LAW:one-source-of-truth] The daemons beside the one serving the bar:
// every one but it — every one at all when none answered. The probe names
// them; the doctor's event lists them (src/doctor/report.ts).
export function otherDaemons(
  serving: Asked<ServingDaemon>,
  processes: readonly DaemonProcess[],
): readonly DaemonProcess[] {
  return serving.kind === "failed"
    ? processes
    : processes.filter((p) => p.pid !== serving.value.pid);
}

// "The daemon is healthy" (brandon-doctor-v62x.5mq): exactly one daemon runs,
// it holds well under its memory budget, and it has died of memory no time
// the user has not been told of. A post-mortem leads when there is one: it is
// the one problem with a fix, and a verdict carries its lead's.
const daemon: Check = {
  name: "daemon",
  label: "daemon",
  takesMark: false,
  probe: ({ daemon: { serving, processes, read } }) => {
    // The process table is its own problem whether or not a daemon answered.
    const unreadable =
      processes.kind === "failed"
        ? [`the process table could not be read: ${processes.reason}`]
        : [];
    const others =
      processes.kind === "ok" ? otherDaemons(serving, processes.value) : [];
    if (serving.kind === "failed") {
      // The reason says what went wrong in its own words: no daemon, or one
      // of another build that answered without saying what it holds.
      const running =
        others.length > 0
          ? ` — daemon ${others.map((p) => p.pid).join(", ")} running`
          : "";
      return problemsVerdict([`${serving.reason}${running}`, ...unreadable]);
    }
    const { pid, memory, limit, postMortems } = serving.value;
    const unread = unreadPostMortems(serving.value, read);
    const verdict = problemsVerdict([
      ...unread.map(
        (m) =>
          `the daemon ran out of memory and restarted (${m.identity}) — post-mortem: ${Object.values(m.artifacts).join(", ")}`,
      ),
      ...(postMortems.kind === "failed"
        ? [
            `the daemon's post-mortems could not be listed: ${postMortems.reason}`,
          ]
        : []),
      // Which were read decides nothing only while none are listed.
      ...(read.kind === "failed" &&
      !(postMortems.kind === "ok" && postMortems.value.length === 0)
        ? [`which post-mortems were read could not be read: ${read.reason}`]
        : []),
      ...unreadable,
      ...others.map(
        (p) =>
          `daemon ${p.pid} (started ${p.started}, rss ${mb(p.rss)} MB${p.ppid === 1 ? "" : `, child of ${p.ppid}`}) runs beside the one serving the bar (${pid}) — \`kill ${p.pid}\``,
      ),
      // [LAW:no-silent-failure] RSS standing in for the platform's charge is
      // the limit judging an estimate — or, with no gap yet read, what macOS
      // has already reclaimed, the very misjudgment the charge exists to end —
      // so it is a finding, near the limit or not.
      ...(memory.kind === "measured" && memory.charge.kind === "stand-in"
        ? [
            `the daemon could not read what macOS charges it (${memory.charge.unread}), so its memory limit judges ${
              memory.charge.gap !== 0
                ? `RSS less the ${mb(memory.charge.gap)} MB it last ran over that charge, an estimate`
                : "RSS, which counts pages macOS has reclaimed"
            }`,
          ]
        : []),
      ...(memory.kind === "measured" &&
      approachingLimit(memory.charge.bytes, limit)
        ? [
            `the daemon holds ${chargeWords(memory.charge)} of its ${mb(limit)} MB limit — at the limit it records a post-mortem and restarts`,
          ]
        : []),
    ]);
    // [LAW:no-silent-failure] A pass that judged no memory says so, rather
    // than reading like one that judged it and found it well under.
    if (verdict.ok && memory.kind === "unmeasured") {
      return { ok: true, note: "the daemon has not measured its memory yet" };
    }
    const newest = unread[0];
    return verdict.ok || newest === undefined
      ? verdict
      : {
          ...verdict,
          fix: { kind: "post-mortems-read", through: newest.identity },
        };
  },
};

type SeenTerminal = Extract<TerminalIdentity, { kind: "seen" }>;

const CLICK_TO_SEE =
  "click 🩺 doctor in the bar's settings menu: if it runs, links work";

// Whether the terminal draws the bar's links: a doctor click that came back
// from it settles that for good; otherwise what the doctor knows of its
// releases, and of a terminal it does not know, nothing.
function drawsLinks(
  identified: Identified,
  clicked: Asked<readonly string[]>,
): LinkSupport | { readonly kind: "unknown" } {
  const id = sightingOf(identified);
  if (clicked.kind === "ok" && id !== null && clicked.value.includes(id)) {
    return { kind: "draws" };
  }
  return identified.kind === "known"
    ? linkSupport(identified.terminal)
    : { kind: "unknown" };
}

// Why the bar's links do not reach the user, the terminal's own reason first:
// tmux passing links through helps only a terminal that draws them.
function linkProblems(
  { identified, tmuxClient }: SeenTerminal,
  clicked: Asked<readonly string[]>,
): string[] {
  const called = identifiedAs(identified);
  const support = drawsLinks(identified, clicked);
  // A click is remembered under the terminal's sighting, so one with none is
  // proved afresh by every click.
  const prove =
    sightingOf(identified) === null
      ? CLICK_TO_SEE
      : `${CLICK_TO_SEE}, and the doctor remembers it for this terminal`;
  const terminal = ((): string[] => {
    switch (support.kind) {
      case "draws":
        return [];
      case "none":
        return [
          `${called} draws no links (OSC 8), so nothing on the bar can be clicked — run Claude Code in a terminal that draws them: ${LINK_TERMINALS}`,
        ];
      case "older":
        return [
          `${called} ${support.version} draws no links (OSC 8 came in ${support.since}) — update ${called}`,
        ];
      case "unsaid":
        return [
          `${called} draws links (OSC 8) since ${support.since}, and did not say which release this is — ${prove}`,
        ];
      case "unknown":
        return [
          `the doctor does not know whether ${called} draws links (OSC 8) — ${prove}`,
        ];
    }
  })();
  // A remembered click overturns any verdict but `draws`, so a list that
  // cannot be read is named beside every other.
  const remembered =
    clicked.kind === "failed" && support.kind !== "draws"
      ? [
          `the terminals a doctor click came back from could not be read: ${clicked.reason}`,
        ]
      : [];
  // `hyperlinks` in `#{client_termfeatures}` is tmux's word that it writes
  // OSC 8 to the client (tmux 3.4 and later; measured on 3.6a, where
  // XTVERSION turns it on for iTerm2) — without it tmux keeps the bar's links
  // to itself. The pattern tmux matches a client's features by is its TERM.
  const tmux =
    support.kind === "none" ||
    tmuxClient === null ||
    tmuxClient.features.includes("hyperlinks")
      ? []
      : [
          `tmux does not pass links through to ${called} — add \`set -as terminal-features ",${tmuxClient.termname}:hyperlinks"\` to tmux.conf, then detach and reattach (tmux 3.4 or later)`,
        ];
  return [...terminal, ...remembered, ...tmux];
}

// "Links are available and clickable" (brandon-doctor-v62x.ryu): the terminal
// drawing the bar draws OSC 8 links, and inside tmux, tmux passes them
// through. A click on the bar's 🩺 doctor is such a link, drawn and clicked,
// so a run it asked for is its own proof — and the click files its terminal
// (src/doctor/clicked-terminals.ts), where the command, which reasons from
// what tmux and the terminal say about themselves, reads it. A click on the
// tmux status line's 🩺 is tmux's own, no link, so it reasons as the command
// does.
const links: Check = {
  name: "links",
  label: "links",
  takesMark: false,
  probe: ({ sighted, terminal, clicked }) => {
    if (sighted.kind === "clicked" && sighted.via === "link")
      return { ok: true };
    switch (terminal.kind) {
      case "unreported":
        return {
          ok: false,
          reason:
            "the client reported no terminal — re-run `cc-candybar install` to stage a current client",
        };
      case "unasked":
        return {
          ok: false,
          reason: `tmux could not be asked which terminal is attached: ${terminal.reason}`,
        };
      case "seen":
        return problemsVerdict(linkProblems(terminal, clicked));
    }
  },
};

// Claude Code's fastest statusline cadence, in seconds (`refreshInterval`'s
// minimum; design-docs/ANTHROPIC-STATUSLINE-DOCS.md) — the frame rate every
// effect curve is tuned for.
export const EFFECT_REFRESH_INTERVAL = 1;

// [LAW:single-enforcer] The frames Claude Code's refresh redraws: the
// statusline's, never a `cc-candybar frames` display's.
export const refreshedFrames = (
  frames: readonly FrameSighting[],
): readonly FrameSighting[] => frames.filter((f) => f.role === "statusline");

// "A bar that moves is redrawn every second" (brandon-effects-2gka.21e).
// Without `refreshInterval` Claude Code runs the statusline only on events, so
// an effect's frames land seconds apart and an idle session stops moving.
// `cc-candybar install` does not write it — a render a second costs every
// session whether or not anything animates — so the doctor asks for it exactly
// when a bar Claude Code drew moves, or its config can start motion with no
// click. A `cc-candybar frames` display is not one: the daemon's feed pushes
// its frames, whatever Claude Code's refresh.
// [LAW:one-source-of-truth] Whether it moves is what the drawn frame says
// (brandon-doctor-v62x.tgp), not what the config asks for: a template's
// `frames` — the effort gauge at max — moves the bar with no effect on.
const effectRefresh: Check = {
  name: "effectRefresh",
  label: "effect refresh",
  takesMark: false,
  probe: ({ frames, claudeSettings: { origin, elsewhere }, sighted }) => {
    // [LAW:one-source-of-truth] Each bar is judged against the chain that
    // redraws it (brandon-doctor-v62x.y5d). The run's own chain first; the
    // first failure leads the others', which follow as `more`, and the fix
    // is the lead's.
    const verdicts = [origin, ...elsewhere].flatMap(
      ({ sources, bars }) => chainVerdict(sources, barsSeen(bars)) ?? [],
    );
    const [first] = verdicts;
    if (first === undefined) {
      // No chain redraws every second, and none holds a bar.
      if (frames.kind === "failed") return { ok: false, reason: frames.reason };
      return unknownMotion(
        sighted.kind !== "recent"
          ? noRenderOf(sighted)
          : `no session has drawn a statusline for this daemon in the last ${RECENT_CLIENT_S / 60} minutes`,
      );
    }
    const [lead, ...others] = verdicts.flatMap((v) => (v.ok ? [] : [v]));
    if (lead === undefined) return first;
    const more = [...new Set(others.map((f) => f.reason))].filter(
      (r) => r !== lead.reason,
    );
    return more.length === 0 ? lead : { ...lead, more };
  },
};

// What a chain's bars say about motion: the first that holds, in this order.
type BarsSeen =
  | { readonly kind: "moving"; readonly wearing: string }
  | { readonly kind: "still" }
  | { readonly kind: "unknown"; readonly unseen: string }
  | { readonly kind: "none" };

// [LAW:single-enforcer] The one reading of what a chain's bars drew.
const barsSeen = (bars: readonly FrameSighting[]): BarsSeen => {
  const drawn = refreshedFrames(bars).map((f) => f.frame);
  if (drawn.includes("moves")) {
    return {
      kind: "moving",
      wearing:
        "the bar moves (an effect, a fade, an animated segment, or an open menu counting down to its close)",
    };
  }
  if (drawn.includes("can-move")) {
    return {
      kind: "moving",
      wearing:
        "the bar can start moving (an open menu, which flashes and closes on its own, a globals.effect rule, placements that fade in and out, or a placement with an effect of its own that is not drawn now)",
    };
  }
  if (drawn.includes("still")) return { kind: "still" };
  if (drawn.includes("drawing")) {
    return {
      kind: "unknown",
      unseen: "the bar's latest render has not finished",
    };
  }
  if (drawn.length > 0) {
    return { kind: "unknown", unseen: "the bar's recent renders failed" };
  }
  if (bars.length > 0) {
    return {
      kind: "unknown",
      unseen:
        "only a `cc-candybar frames` display has drawn this bar, not Claude Code's statusline",
    };
  }
  return { kind: "none" };
};

const unknownMotion = (unseen: string): Verdict<never> => ({
  ok: false,
  reason: `${unseen}, so whether it moves is unknown — run the doctor again once the bar has redrawn`,
});

// One settings chain's verdict, or null when it has nothing to judge: a chain
// whose statusLine redraws every second passes whatever its bars drew, and
// one asking for less is judged on the bars it redraws.
function chainVerdict(
  sources: Asked<readonly SettingsSource[]>,
  seen: BarsSeen,
): Verdict<never> | null {
  const statusLine = statusLineOf(sources);
  // [LAW:one-source-of-truth] Claude Code's own reading: a number of
  // seconds, no fewer than the minimum, so the minimum itself is the one
  // value that redraws every second — and once it is set, nothing the bar
  // draws needs more. Unset runs on events only; anything under the minimum
  // or not a number is a value the docs give no meaning, so the reason names
  // it rather than guess, and the fix overwrites it.
  if (
    statusLine.kind === "present" &&
    statusLine.refreshInterval === EFFECT_REFRESH_INTERVAL
  ) {
    return {
      ok: true,
      note: `statusLine.refreshInterval is ${EFFECT_REFRESH_INTERVAL} in ${statusLine.from.path}`,
    };
  }
  switch (seen.kind) {
    case "none":
      return null;
    case "still":
      return { ok: true };
    case "unknown":
      return unknownMotion(seen.unseen);
    case "moving":
      break;
  }
  const { wearing } = seen;
  switch (statusLine.kind) {
    case "unread":
      return {
        ok: false,
        reason: `${wearing}, and Claude Code's settings could not be read: ${statusLine.reason}`,
      };
    case "absent":
      return {
        ok: false,
        reason: `${wearing}, and no settings file Claude Code reads here sets a statusLine (read: ${statusLine.read.join(", ") || "none"}) — the one that runs the bar comes from --settings, MDM or server-managed settings, which the doctor cannot read; set "refreshInterval": ${EFFECT_REFRESH_INTERVAL} beside its command there`,
      };
    case "not-an-object":
      return {
        ok: false,
        // `cc-candybar install` writes the user file only, so only there
        // does re-running it replace the line.
        reason: `${wearing}, and ${statusLine.from.path} sets statusLine to ${JSON.stringify(statusLine.value)}, not a statusLine object — ${statusLine.from.scope === "user" ? "re-run `cc-candybar install` to write one" : "replace it there with the statusLine object that runs cc-candybar"}`,
      };
    case "present": {
      const { from, refreshInterval: interval } = statusLine;
      const why =
        interval === undefined
          ? "its statusLine sets no refreshInterval, so Claude Code redraws it only on events"
          : typeof interval === "number" && interval > EFFECT_REFRESH_INTERVAL
            ? `its statusLine redraws it only every ${interval} s`
            : `its statusLine.refreshInterval is ${JSON.stringify(interval)}, not a number of seconds Claude Code accepts (its minimum is ${EFFECT_REFRESH_INTERVAL})`;
      // [LAW:single-enforcer] The doctor writes only a file that is the
      // user's own (`doctorWrites`). Nor can it put the interval alone in a
      // file it may write: under the scope-wins-whole reading above
      // (unverified), managed settings outrank every such file, and a
      // project-local statusLine holding only an interval would outrank the
      // project's, which holds the command. So for those two the reason
      // says where the line goes.
      return doctorWrites(from)
        ? {
            ok: false,
            reason: `${wearing}, but ${why} (statusLine from ${from.path})`,
            fix: {
              kind: "claude-settings",
              file: from,
              path: ["statusLine", "refreshInterval"],
              value: EFFECT_REFRESH_INTERVAL,
            },
          }
        : {
            ok: false,
            reason: `${wearing}, but ${why} — its statusLine is in ${from.scope === "managed" ? "managed settings" : "the project's shared settings"}, ${from.path}: set "refreshInterval": ${EFFECT_REFRESH_INTERVAL} there`,
          };
    }
  }
}

const codePoints = (glyphs: Iterable<string>): string =>
  [...glyphs]
    .map((g) => `U+${g.codePointAt(0)!.toString(16).toUpperCase()}`)
    .join(" ");

// The terminal as a sentence names it.
function terminalCalled(terminal: TerminalFacts): string {
  switch (terminal.kind) {
    case "unreported":
    case "unasked":
      return "this terminal";
    case "unknown":
    case "unnamed":
      return identifiedAs(terminal);
    case "bundling":
    case "unread":
    case "configured":
      return [terminalLabel(terminal.name), terminal.version]
        .filter((part) => part !== null)
        .join(" ");
  }
}

// What a mark answers for: the terminal's sighting (`sightingOf`), and for
// one whose font was read, the font and where it was read too — so a mark
// made under one font, or before the built-in glyphs were turned on, answers
// nothing once the reading changes, and the fresh reading speaks again.
function sightedIn(terminal: TerminalFacts): string | null {
  switch (terminal.kind) {
    case "unreported":
    case "unasked":
      return null;
    case "unknown":
    case "unnamed":
      return sightingOf(terminal);
    case "bundling":
    case "unread":
      return terminalLabel(terminal.name);
    case "configured": {
      const label = terminalLabel(terminal.name);
      return terminal.font.kind === "ok"
        ? `${label} with ${terminal.font.value.font} (${terminal.font.value.from})`
        : `${label}, its font unread: ${terminal.font.reason}`;
    }
  }
}

// [LAW:one-source-of-truth] The sighting the Nerd Font check shows, and the
// one spelling of its id: the doctor verb files a mark under it, and the
// probe honours a mark only under it, so a mark made in one terminal, under
// another font, or on another joiner's glyphs, answers nothing here.
// Undefined where nothing names the terminal: there is nothing to mark.
export function glyphSighting(
  facts: Pick<DrawnGlyphs, "glyphs" | "terminal">,
): Sighting | undefined {
  const where = sightedIn(facts.terminal);
  return where === null
    ? undefined
    : { glyphs: facts.glyphs, id: `${where}|${codePoints(facts.glyphs)}` };
}

// "A Nerd Font is set up and in use" (brandon-doctor-v62x.2ww): the terminal
// that draws the bar has the private-use glyphs the bar draws — its joiner's
// caps and seams — so they read as shapes, not boxes. A terminal cannot be
// asked its font, so the font is read where the terminal reads it, and what
// the doctor cannot settle that way the user settles by looking: every failed
// verdict shows the glyphs to mark, and a mark on them is the answer.
// The check's name, which its marks are filed under in the mark book.
export const NERD_FONT_CHECK = "nerdFont";

const nerdFont: Check = {
  name: NERD_FONT_CHECK,
  label: "Nerd Font",
  takesMark: true,
  probe: ({ nerdFont: facts, marks }) => {
    if (facts.kind === "none") return { ok: true };
    const sighting = glyphSighting(facts);
    // [LAW:no-silent-failure] A book that does not read is told where a mark
    // could have settled the verdict — beside every failure, which then offers
    // no mark the book would refuse to file — and nowhere else: a terminal
    // whose own facts pass needs no mark.
    const failed = (reason: string): Verdict =>
      marks.kind === "failed" && sighting !== undefined
        ? {
            ok: false,
            reason,
            more: [`the mark book could not be read: ${marks.reason}`],
          }
        : { ok: false, reason, ...(sighting !== undefined && { sighting }) };
    const terminal = facts.terminal;
    const called = terminalCalled(terminal);
    const mark =
      sighting === undefined || marks.kind === "failed"
        ? null
        : (marks.value[NERD_FONT_CHECK]?.[sighting.id] ?? null);
    switch (mark) {
      case "drawn":
        return { ok: true };
      case "boxes":
        return failed(
          `${called} draws ${codePoints(facts.glyphs)} as boxes — set a Nerd Font as its font`,
        );
      case null:
        break;
    }
    switch (terminal.kind) {
      case "unreported":
        return failed(
          "the client reported no terminal — re-run `cc-candybar install` to stage a current client",
        );
      case "unasked":
        return failed(
          `tmux could not be asked which terminal is attached: ${terminal.reason}`,
        );
      case "unknown":
      case "unnamed":
      case "unread":
        return failed(`the doctor cannot read ${called}'s font`);
      case "bundling": {
        const since = TERMINALS[terminal.name].glyphs.since;
        if (since === null) return { ok: true };
        const shipped =
          terminal.version === null
            ? null
            : releasedSince(terminal.version, since);
        if (shipped === true) return { ok: true };
        const label = terminalLabel(terminal.name);
        return failed(
          shipped === null
            ? `${label} ships Nerd Font symbols since ${since}, and did not say which release this is`
            : `${called} ships no Nerd Font symbols (they came in ${since}) — update ${label}, or set a Nerd Font as its font`,
        );
      }
      case "configured": {
        if (terminal.font.kind === "failed") {
          return failed(
            `the doctor cannot read ${called}'s font: ${terminal.font.reason}`,
          );
        }
        const { font, from, lacks } = terminal.font.value;
        if (lacks === null) {
          return failed(
            `${called} is set to ${font} (${from}), which is not installed — install it or set a Nerd Font`,
          );
        }
        if (lacks.length === 0) return { ok: true };
        return failed(
          `${called} draws with ${font} (${from}), which has no ${codePoints(lacks)} — set a Nerd Font as its font`,
        );
      }
    }
  },
};

// How the segments that need a source read in a reason, and how to stop
// counting it.
function named(segments: readonly string[]): string {
  return segments.join(", ");
}
function optOut(segments: readonly string[]): string {
  return `or set missingData: "ignore" on ${named(segments)}`;
}

function pullRequestProblems(need: SegmentDataFacts["pullRequests"]): string[] {
  if (need.kind === "unneeded") return [];
  const { segments, fact } = need;
  if (fact.kind === "failed") {
    return [
      `${named(segments)}: whether the forge CLI is ready could not be asked: ${fact.reason}`,
    ];
  }
  if (fact.value === null) return [];
  const { cli, host, status } = fact.value;
  if (status === "ready") return [];
  return status === "missing"
    ? [
        `${named(segments)}: ${cli} is not installed, so no pull request is ever shown — install it, ${optOut(segments)}`,
      ]
    : [
        `${named(segments)}: ${cli} is not logged in to ${host} (${status.loggedOut}) — run \`${cli} auth login --hostname ${host}\`, ${optOut(segments)}`,
      ];
}

function rateLimitProblems(
  need: SegmentDataFacts["rateLimits"],
  sighted: SightingScope,
): string[] {
  if (need.kind === "unneeded") return [];
  const { segments, fact } = need;
  if (fact.kind === "failed") return [`${named(segments)}: ${fact.reason}`];
  if (fact.value.length === 0) {
    return [
      sighted.kind !== "recent"
        ? `${named(segments)}: ${noRenderOf(sighted)}, so whether Claude Code sends rate_limits is unseen — run the doctor again once the bar has redrawn`
        : `${named(segments)}: no session of this Claude Code has drawn a bar for this daemon in the last ${RECENT_CLIENT_S / 60} minutes, so whether it sends rate_limits is unseen — run the doctor again once the bar has redrawn`,
    ];
  }
  // The windows are the account's a session bills, which its environment
  // can change (an API key, another endpoint): one session of another
  // account says nothing of whether this Claude Code sends them, so only a
  // response no render carried them after is a finding — for a click, its
  // own session's.
  return fact.value.includes("missing") && !fact.value.includes("carried")
    ? [
        `${named(segments)}: Claude Code sent no rate_limits — it sends them only to Claude.ai subscription sessions; on any other account, set missingData: "ignore" on ${named(segments)}`,
      ]
    : [];
}

// "Segments have their data" (brandon-doctor-v62x.onf): every placed segment
// whose `missingData` is "fail" gets the outside data it reads. No fix:
// installing a CLI, logging in, or a subscription is the user's to do.
const segmentData: Check = {
  name: "segmentData",
  label: "segment data",
  takesMark: false,
  probe: ({ data, sighted }) =>
    problemsVerdict([
      ...pullRequestProblems(data.pullRequests),
      ...rateLimitProblems(data.rateLimits, sighted),
    ]),
};

function transcriptProblems({
  path,
  answered,
  read,
}: TranscriptRead): string[] {
  switch (read.kind) {
    case "absent":
      return answered
        ? [
            `the transcript ${path} does not exist, though Claude Code has answered in its session — the bar's session cost, metrics and activity read nothing`,
          ]
        : [];
    case "failed":
      return [`the transcript ${path} cannot be read: ${read.reason}`];
    case "ok": {
      const { lines, unparsed, whole } = read.value;
      return unparsed === 0
        ? []
        : [
            `${unparsed} of the ${lines} lines ${whole ? "in" : `in the last ${TRANSCRIPT_WINDOW_BYTES / 1024 / 1024} MiB of`} the transcript ${path} are not JSON objects — the bar skips them, so what it counts from them is missing`,
          ];
    }
  }
}

// "Session data is readable" (brandon-doctor-v62x.p4l): the transcript each
// recent render named exists once Claude Code has answered, opens, and reads
// as the JSON lines the bar folds its session cost, metrics and activity
// from. No fix: the file is Claude Code's.
const sessionData: Check = {
  name: "sessionData",
  label: "session data",
  takesMark: false,
  probe: ({ transcripts, sighted }) => {
    if (transcripts.kind === "failed") {
      return { ok: false, reason: transcripts.reason };
    }
    if (transcripts.value.length === 0) {
      return {
        ok: false,
        reason:
          sighted.kind !== "recent"
            ? `${noRenderOf(sighted)}, so which transcript it reads is unknown — run the doctor again once the bar has redrawn`
            : `no session has drawn a bar for this daemon in the last ${RECENT_CLIENT_S / 60} minutes, so no transcript was named — run the doctor again once the bar has redrawn`,
      };
    }
    return problemsVerdict(transcripts.value.flatMap(transcriptProblems));
  },
};

export const CHECKS: readonly Check[] = [
  config,
  install,
  daemon,
  urlHandler,
  links,
  tmuxTruecolor,
  utf8,
  termWidth,
  effectRefresh,
  nerdFont,
  segmentData,
  sessionData,
];

// The checks that take the user's mark — the only ones a mark may name.
export const MARKED_CHECKS: readonly Check[] = CHECKS.filter(
  (c) => c.takesMark,
);

// [LAW:single-enforcer] THE fold. The bar's 🩺 click and `cc-candybar doctor`
// both call this over facts their own edge gathered, so the two surfaces
// cannot disagree about what a healthy setup is.
export function runDoctor(facts: DoctorFacts): readonly CheckReport[] {
  return CHECKS.map((check) => ({ check, verdict: check.probe(facts) }));
}

// [LAW:parse-dont-validate] A wire-supplied check name becomes a `Check` or
// nothing — the `[fix]` verb and the action loader both gate through this, so
// a name the list does not carry is refused at load (an authored action) or at
// click (a stale URL), never looked up twice.
export function checkByName(name: string): Check | undefined {
  return CHECKS.find((c) => c.name === name);
}

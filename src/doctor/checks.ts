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
import type { ClientKind } from "../client-hint.js";
import { DEFAULT_TERMINAL_WIDTH } from "../render/strip.js";
import type { LoopName } from "@promptctl/rich-js";
import { EFFECT_FLOOR, type EffectSelection } from "../themes/policy.js";
import type { Outcome } from "../utils/outcome.js";
import type { DeclKind, UnusedDecl } from "../config/unused.js";
import {
  approachingLimit,
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

// [LAW:types-are-the-program] The `statusLine` entry of the settings file.
// Absent is its own arm, not an empty object: a fix may only add a key beside
// a command that is already there, because a `statusLine` holding nothing but
// a refresh interval is one Claude Code cannot run. `refreshInterval` is raw —
// whatever the file holds; a probe decides what it means. A `statusLine` that
// is not an object is a fact too, read by the one check it concerns, never a
// throw that would take every other verdict with it.
export type StatusLineFacts =
  | { readonly kind: "absent" }
  | { readonly kind: "not-an-object"; readonly value: unknown }
  | { readonly kind: "present"; readonly refreshInterval: unknown };

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

// The daemon row's facts (brandon-doctor-v62x.5mq): the daemon that serves
// this bar, as it reports itself (src/daemon/limits.ts `serving`); every
// daemon process running; and the newest post-mortem the user filed as read
// (src/doctor/post-mortems-read.ts).
export interface DaemonFacts {
  readonly serving: Asked<ServingDaemon>;
  readonly processes: Asked<readonly DaemonProcess[]>;
  readonly read: Asked<string | null>;
}

export interface PlacementEffectFact {
  readonly placement: string;
  readonly effect: LoopName;
}

export interface DoctorFacts {
  readonly tmux: TmuxFacts;
  // The columns the terminal was measured at (COLUMNS, else the terminal's
  // own geometry), or null: none was, so the daemon laid the bar out for
  // DEFAULT_TERMINAL_WIDTH.
  readonly termCols: number | null;
  readonly terminal: TerminalIdentity;
  // What asked for this run: a click on the bar's 🩺 doctor — a link the
  // terminal drew and the user clicked — or the `cc-candybar doctor` command.
  readonly askedBy: "click" | "command";
  readonly config: ConfigFacts;
  readonly urlHandler: UrlHandlerFacts;
  // The clients that drew the bar and the install the daemon runs from: the
  // click's own render, or — for the CLI — every session's latest render this
  // daemon process served (src/daemon/client-sightings.ts).
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
  // The effect the session's bar wears, resolved as its render resolves it
  // (session pick over config default over the floor). A rule stays a rule:
  // only the render can say what it names.
  readonly effect: EffectSelection;
  // Each placement of the session's preset that wears a moving effect of its
  // own (brandon-effects-2gka.bm1) — saved, or the session's unsaved pick —
  // which moves whatever the bar's effect is.
  readonly placementEffects: readonly PlacementEffectFact[];
  // Whether placements fade in and dissolve out (brandon-effects-2gka.631,
  // .3vt), resolved as the render resolves it: a fade moves over 20 s, a
  // dissolve over 30 s.
  readonly transitions: boolean;
  // The session's Claude Code settings file and the entries read from it — a
  // second, daemon-observable fact beside the client-observed env, so a
  // verdict can say the truthful thing after a fix has landed but Claude Code
  // has not restarted, naming the file it landed in.
  readonly claudeSettings: {
    readonly path: string;
    readonly env: Readonly<Record<string, unknown>>;
    readonly statusLine: StatusLineFacts;
  };
}

// [LAW:types-are-the-program] A fix is a DESCRIPTION of an edit the edge
// performs, discriminated by kind so a second repair shape is one more arm
// here and one more case at the edge, never a callback smuggled in a verdict.
// `claude-settings` sets one value at one key path in the session's Claude
// Code settings file; `post-mortems-read` files every post-mortem up to
// `through` as read (src/doctor/post-mortems-read.ts).
export type Fix =
  | {
      readonly kind: "claude-settings";
      readonly path: readonly [string, ...string[]];
      readonly value: string | number;
    }
  | { readonly kind: "post-mortems-read"; readonly through: string };

// The fix as the doctor's event names it.
export function describeFix(fix: Fix): string {
  switch (fix.kind) {
    case "claude-settings":
      return `${fix.kind} ${fix.path.join(".")}=${JSON.stringify(fix.value)}`;
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
  | { readonly ok: true }
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
  probe: ({ tmux, claudeSettings }) =>
    ofTmuxClient(tmux, (client, hint) => {
      // Not applicable is not a failure: without RGB there is nothing for
      // Claude Code to be told about.
      if (!client.features.includes("RGB")) return { ok: true };
      if (hint.truecolor !== null) return { ok: true };
      // [LAW:one-source-of-truth] The same truthiness Claude Code applies to
      // its env: a non-empty string. Anything else in settings.json — absent,
      // empty, a non-string — is "not told", and the fix overwrites it.
      const staged = claudeSettings.env[TMUX_TRUECOLOR_VAR];
      if (typeof staged === "string" && staged !== "") {
        return {
          ok: false,
          reason: `${TMUX_TRUECOLOR_VAR} is set in ${claudeSettings.path} — restart Claude Code to apply`,
        };
      }
      return {
        ok: false,
        reason: "Claude Code renders the bar in 256 colours inside tmux",
        fix: {
          kind: "claude-settings",
          path: ["env", TMUX_TRUECOLOR_VAR],
          value: "1",
        },
      };
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
  probe: ({ termCols }) =>
    termCols !== null
      ? { ok: true }
      : {
          ok: false,
          reason: `no terminal width was measured (no COLUMNS, and no terminal to ask — or the daemon refused the width sent, which the bar's red strip names), so the bar is laid out as if the terminal were ${DEFAULT_TERMINAL_WIDTH} columns wide`,
        },
};

const UNUSED: Readonly<Record<DeclKind, string>> = {
  variable: "is never read",
  action: "is never clicked",
  helper: "is never called",
  segment: "is in no preset",
};

// "The config is correct" (brandon-doctor-v62x.e91): it loads, the load earned
// no advisory (a duplicate key, a `.json`/`.json5` collision, a location the
// search could not check, a variable that failed to declare), and everything
// the files declare is used. A threshold whose knobs do not ascend is a load error, so it is the first of
// those.
const config: Check = {
  name: "config",
  label: "config",
  takesMark: false,
  probe: ({ config }) => {
    switch (config.kind) {
      case "failed": {
        // [LAW:no-silent-failure] A load that failed is never ok, even when
        // the error it threw carries no text.
        const [reason = "the config failed to load", ...more] = [
          ...config.error
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line !== ""),
          ...config.warnings,
        ];
        return { ok: false, reason, more };
      }
      case "loaded":
        return problemsVerdict([
          ...config.warnings,
          ...config.unused.map(
            ({ kind, name }) => `${kind} "${name}" ${UNUSED[kind]}`,
          ),
        ]);
    }
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
  if (client === "frames") return `run \`node ${daemon.bundle} frames\``;
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
const install: Check = {
  name: "install",
  label: "install",
  takesMark: false,
  probe: ({ install, askedBy }) => {
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
          askedBy === "click"
            ? "the daemon restarted since this bar was drawn, so which client draws it is unknown — run the doctor again once the bar has redrawn"
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
  read: Asked<string | null>,
): readonly PostMortem[] {
  return postMortems.kind === "ok" && read.kind === "ok"
    ? postMortems.value.filter(
        (m) => read.value === null || m.identity > read.value,
      )
    : [];
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
    if (serving.kind === "failed") {
      const running =
        processes.kind === "ok" && processes.value.length > 0
          ? ` — daemon ${processes.value.map((p) => p.pid).join(", ")} running`
          : "";
      return {
        ok: false,
        reason: `no daemon answered: ${serving.reason}${running}`,
      };
    }
    const { pid, rss, rssLimit, postMortems } = serving.value;
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
      ...(read.kind === "failed"
        ? [`which post-mortems were read could not be read: ${read.reason}`]
        : []),
      ...(processes.kind === "failed"
        ? [`the process table could not be read: ${processes.reason}`]
        : processes.value
            .filter((p) => p.pid !== pid)
            .map(
              (p) =>
                `daemon ${p.pid} (started ${p.started}, ${mb(p.rss)} MB${p.ppid === 1 ? "" : `, child of ${p.ppid}`}) runs beside the one serving the bar (${pid}) — \`kill ${p.pid}\``,
            )),
      ...(approachingLimit(rss, rssLimit)
        ? [
            `the daemon holds ${mb(rss)} MB of its ${mb(rssLimit)} MB limit — at the limit it records a post-mortem and restarts`,
          ]
        : []),
    ]);
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
// what tmux and the terminal say about themselves, reads it.
const links: Check = {
  name: "links",
  label: "links",
  takesMark: false,
  probe: ({ askedBy, terminal, clicked }) => {
    if (askedBy === "click") return { ok: true };
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

// "A bar that moves is redrawn every second" (brandon-effects-2gka.21e).
// Without `refreshInterval` Claude Code runs the statusline only on events, so
// an effect's frames land seconds apart and an idle session stops moving.
// `cc-candybar install` does not write it — a render a second costs every
// session whether or not anything animates — so the doctor asks for it exactly
// when anything on the bar moves: the bar's effect, a placement's own, or a
// placement fading in as it appears. A rule counts: it can turn one on at any
// render.
const effectRefresh: Check = {
  name: "effectRefresh",
  label: "effect refresh",
  takesMark: false,
  probe: ({ effect, placementEffects, transitions, claudeSettings }) => {
    const moving = [
      ...(effect.kind !== "decided"
        ? ["a globals.effect rule can give the bar an effect"]
        : effect.value === EFFECT_FLOOR
          ? []
          : [`the bar wears the ${effect.name} effect`]),
      ...placementEffects.map(
        ({ placement, effect }) => `${placement} wears the ${effect} effect`,
      ),
      ...(transitions
        ? ["placements fade in and dissolve out as they come and go"]
        : []),
    ];
    if (moving.length === 0) return { ok: true };
    const wearing = moving.join(" and ");
    const { path, statusLine } = claudeSettings;
    switch (statusLine.kind) {
      case "absent":
        return {
          ok: false,
          reason: `${wearing}, and ${path} sets no statusLine — set "refreshInterval": ${EFFECT_REFRESH_INTERVAL} beside the statusLine command that runs the bar`,
        };
      case "not-an-object":
        return {
          ok: false,
          reason: `${wearing}, and ${path} sets statusLine to ${JSON.stringify(statusLine.value)}, not a statusLine object — re-run \`cc-candybar install\` to write one`,
        };
      case "present":
        break;
    }
    // [LAW:one-source-of-truth] Claude Code's own reading: a number of
    // seconds, no fewer than the minimum, so the minimum itself is the one
    // value that redraws every second. Unset runs on events only; anything
    // under the minimum or not a number is a value the docs give no meaning,
    // so the reason names it rather than guess, and the fix overwrites it.
    const interval = statusLine.refreshInterval;
    if (interval === EFFECT_REFRESH_INTERVAL) return { ok: true };
    return {
      ok: false,
      reason:
        interval === undefined
          ? `${wearing}, but Claude Code redraws it only on events`
          : typeof interval === "number" && interval > EFFECT_REFRESH_INTERVAL
            ? `${wearing}, but Claude Code redraws it only every ${interval} s`
            : `${wearing}, but statusLine.refreshInterval is ${JSON.stringify(interval)}, not a number of seconds Claude Code accepts (its minimum is ${EFFECT_REFRESH_INTERVAL})`,
      fix: {
        kind: "claude-settings",
        path: ["statusLine", "refreshInterval"],
        value: EFFECT_REFRESH_INTERVAL,
      },
    };
  },
};

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
    if (marks.kind === "failed") {
      return {
        ok: false,
        reason: `the mark book could not be read: ${marks.reason}`,
      };
    }
    const sighting = glyphSighting(facts);
    const failed = (reason: string): Verdict => ({
      ok: false,
      reason,
      ...(sighting !== undefined && { sighting }),
    });
    const terminal = facts.terminal;
    const called = terminalCalled(terminal);
    const mark =
      sighting === undefined
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

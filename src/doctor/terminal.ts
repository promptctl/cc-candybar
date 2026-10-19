// Which terminal emulator draws the session's bar, read from what the
// session's client and its tmux server say about it.
//
// [LAW:effects-at-boundaries] Pure: the client's `terminalEnv` hint and tmux's
// answer about its attached client arrive as values (src/doctor/edge.ts
// gathers them); this module only reads them.

import type { TerminalEnvHint } from "../terminal-hint.js";

// [LAW:types-are-the-program] How Nerd Font symbols reach the screen in a
// terminal: a `bundled` terminal draws them from a copy of Symbols Nerd Font
// it ships, as a fallback behind whatever font is set, so its font setting
// cannot take them away (`since`: the release it first shipped the copy in,
// null when every release did); a `configured` terminal draws them only from
// the font it is set to use, which the doctor reads; an `unread` terminal
// draws them from its font too, but the doctor has no reader for its font.
type GlyphSource =
  | { readonly kind: "bundled"; readonly since: string | null }
  | { readonly kind: "configured" }
  | { readonly kind: "unread" };

// [LAW:one-source-of-truth] Everything the doctor knows about one terminal:
// how a sentence names it; how it names itself in the three places it does —
// its XTVERSION reply (a prefix, the version after it), TERM_PROGRAM (and
// whether TERM_PROGRAM_VERSION beside it is this terminal's own release), and
// TERM, `null` where it does not; whether it draws OSC 8 links (`since`: the
// release it first did, null when every release did; `null`: it draws none);
// and how it draws Nerd Font symbols.
interface TerminalRow {
  readonly label: string;
  readonly xtversion: string | null;
  readonly program: string | null;
  readonly programVersion: boolean;
  readonly term: string | null;
  readonly links: { readonly since: string | null } | null;
  readonly glyphs: GlyphSource;
}

// Bundled symbols: kitty's changelog, 0.36.0 "Add NERD fonts builtin";
// WezTerm's, 20230712 — its copy moved to Nerd Fonts 3.0, the first with the
// nf-md icons at U+F0001+ the bundled bar's effort gauge draws (the copy it
// bundled from 20220319 is v2, which has none; wezterm.org's
// `wezterm.nerdfonts` page dates the move); Ghostty embeds
// Symbols Nerd Font in its binary, and its first public release did.
//
// Links: OSC 8 adoption in terminal emulators,
// github.com/Alhadis/OSC8-Adoption — kitty 0.19, Alacritty 0.11, VS Code
// 1.72, iTerm2 3.1; WezTerm since early 2018, Ghostty before its first public
// release. Apple's Terminal is in no release of that list, and its users
// report it ignores OSC 8 (apple.stackexchange.com/questions/460189).
//
// VS Code's forks (Cursor, Windsurf) set TERM_PROGRAM=vscode too, each with
// its own release in TERM_PROGRAM_VERSION, so that release says nothing about
// the VS Code it was built from.
export const TERMINALS = {
  kitty: {
    label: "kitty",
    xtversion: "kitty",
    program: null,
    programVersion: true,
    term: "xterm-kitty",
    links: { since: "0.19.0" },
    glyphs: { kind: "bundled", since: "0.36.0" },
  },
  wezterm: {
    label: "WezTerm",
    xtversion: "WezTerm",
    program: "WezTerm",
    programVersion: true,
    term: "wezterm",
    links: { since: null },
    glyphs: { kind: "bundled", since: "20230712" },
  },
  ghostty: {
    label: "Ghostty",
    xtversion: "ghostty",
    program: "ghostty",
    programVersion: true,
    term: "xterm-ghostty",
    links: { since: null },
    glyphs: { kind: "bundled", since: null },
  },
  iterm2: {
    label: "iTerm2",
    xtversion: "iTerm2",
    program: "iTerm.app",
    programVersion: true,
    term: null,
    links: { since: "3.1" },
    glyphs: { kind: "configured" },
  },
  alacritty: {
    label: "Alacritty",
    xtversion: "alacritty",
    program: null,
    programVersion: true,
    term: "alacritty",
    links: { since: "0.11.0" },
    glyphs: { kind: "configured" },
  },
  "apple-terminal": {
    label: "Terminal",
    xtversion: null,
    program: "Apple_Terminal",
    programVersion: true,
    term: null,
    links: null,
    glyphs: { kind: "unread" },
  },
  vscode: {
    label: "VS Code",
    xtversion: null,
    program: "vscode",
    programVersion: false,
    term: null,
    links: { since: "1.72" },
    glyphs: { kind: "unread" },
  },
} as const satisfies Record<string, TerminalRow>;

export type TerminalName = keyof typeof TERMINALS;
type DrawingGlyphs<K extends GlyphSource["kind"]> = {
  [N in TerminalName]: (typeof TERMINALS)[N]["glyphs"]["kind"] extends K
    ? N
    : never;
}[TerminalName];
export type BundlingTerminal = DrawingGlyphs<"bundled">;
export type ConfiguredTerminal = DrawingGlyphs<"configured">;
export type UnreadTerminal = DrawingGlyphs<"unread">;

const row = (name: TerminalName): TerminalRow => TERMINALS[name];

export function isBundling(name: TerminalName): name is BundlingTerminal {
  return row(name).glyphs.kind === "bundled";
}

export function isConfigured(name: TerminalName): name is ConfiguredTerminal {
  return row(name).glyphs.kind === "configured";
}

export const terminalLabel = (name: TerminalName): string => row(name).label;

// The private-use glyphs iTerm2 draws itself, whatever the font, when a
// profile's "Use built-in Powerline glyphs" (`Draw Powerline Glyphs`) is on,
// and the release that first drew each run — iTerm2's source,
// sources/Drawing/iTermBoxDrawingBezierCurveFactory.m
// (`boxDrawingCharactersWithBezierPathsIncludingPowerline`,
// `powerlineExtendedSymbols`). The extended set came in 3.5.0 and U+E0D6–E0D7
// in 3.5.6; no release before 3.5.0 is verified, so none is counted. The set
// assumes iTerm2's advanced settings at their defaults
// (`supportPowerlineExtendedSymbols` on, `disableCustomBoxDrawing` off); a
// user who changed them settles it with a mark.
const ITERM_POWERLINE: ReadonlyArray<{
  readonly since: string;
  readonly from: number;
  readonly to: number;
}> = [
  { since: "3.5.0", from: 0xe0a0, to: 0xe0a3 },
  { since: "3.5.0", from: 0xe0b0, to: 0xe0d2 },
  { since: "3.5.0", from: 0xe0d4, to: 0xe0d4 },
  { since: "3.5.6", from: 0xe0d6, to: 0xe0d7 },
];

// Whether iTerm2 at `version` draws `glyph` itself under its built-in
// Powerline glyphs; an unsaid release draws none the doctor can count on.
export function itermDrawsItself(
  version: string | null,
  glyph: string,
): boolean {
  const point = glyph.codePointAt(0)!;
  return ITERM_POWERLINE.some(
    ({ since, from, to }) =>
      from <= point &&
      point <= to &&
      version !== null &&
      releasedSince(version, since) === true,
  );
}

// A terminal named, and the release it reported, or null when nothing said.
export interface Terminal {
  readonly name: TerminalName;
  readonly version: string | null;
}

// What tmux says about the client attached to the session's pane: its
// XTVERSION reply (`#{client_termtype}`, e.g. `iTerm2 3.7.2`,
// `kitty(0.45.0)`, `ghostty 1.3.1`; empty from a terminal that does not
// answer) and the TERM it was started under (`#{client_termname}`).
export interface TmuxClientTerm {
  readonly termtype: string;
  readonly termname: string;
}

const NAMES = Object.keys(TERMINALS) as TerminalName[];

// The leading release number of a version string — `0.45.0`, or `20240203`
// of WezTerm's `20240203-110809-5046fc22` — as numbers to compare.
function release(version: string): readonly number[] | null {
  const lead = /^\d+(?:\.\d+)*/.exec(version);
  return lead === null ? null : lead[0].split(".").map(Number);
}

// Whether `version` is `since` or later; null when `version` carries no
// release number to compare.
export function releasedSince(version: string, since: string): boolean | null {
  const have = release(version);
  const need = release(since)!;
  if (have === null) return null;
  for (let i = 0; i < Math.max(have.length, need.length); i++) {
    const a = have[i] ?? 0;
    const b = need[i] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}

// The terminal an XTVERSION reply names: its name a prefix, case aside, and
// what follows it — past a space or an opening parenthesis — its version.
function fromXtversion(termtype: string): Terminal | null {
  for (const name of NAMES) {
    const prefix = row(name).xtversion;
    if (
      prefix !== null &&
      termtype.toLowerCase().startsWith(prefix.toLowerCase())
    ) {
      const rest = termtype.slice(prefix.length).replace(/^[\s(]+/, "");
      const version = /^[^\s)]+/.exec(rest)?.[0] ?? null;
      return { name, version };
    }
  }
  return null;
}

function fromTerm(term: string | undefined): Terminal | null {
  const name = NAMES.find((n) => row(n).term === term);
  return name === undefined ? null : { name, version: null };
}

// [LAW:types-are-the-program] What identifying the terminal found: one the
// doctor knows; one it does not, by the name it gave itself (its XTVERSION
// reply, or TERM_PROGRAM); or one that gave none, so only the TERM it runs
// under is said of it (empty when unset) — a value many terminals share.
export type Identified =
  | { readonly kind: "known"; readonly terminal: Terminal }
  | { readonly kind: "unknown"; readonly called: string }
  | { readonly kind: "unnamed"; readonly term: string };

// Inside tmux the attached client is the terminal: tmux's word on it beats
// the session's environment, which tmux passes on from whichever terminal
// started the server.
export function identifyInTmux(client: TmuxClientTerm): Identified {
  const terminal = fromXtversion(client.termtype) ?? fromTerm(client.termname);
  if (terminal !== null) return { kind: "known", terminal };
  // An XTVERSION reply is a name and the release after it (`foot(1.16.2)`):
  // the name alone is the terminal, so an update keeps what it was called.
  const called = /^[^\s(]*/.exec(client.termtype)![0];
  return called === ""
    ? { kind: "unnamed", term: client.termname }
    : { kind: "unknown", called };
}

export function identifyFromEnv(env: TerminalEnvHint): Identified {
  const program = env.TERM_PROGRAM;
  const byProgram = NAMES.find((n) => row(n).program === program);
  const terminal =
    byProgram === undefined
      ? fromTerm(env.TERM)
      : {
          name: byProgram,
          version: row(byProgram).programVersion
            ? (env.TERM_PROGRAM_VERSION ?? null)
            : null,
        };
  if (terminal !== null) return { kind: "known", terminal };
  // tmux sets TERM_PROGRAM in its panes to its own name, which every
  // terminal behind it shares: no name of a terminal.
  return program === undefined || program === "tmux"
    ? { kind: "unnamed", term: env.TERM ?? "" }
    : { kind: "unknown", called: program };
}

// What a remembered answer about the terminal is filed under — a doctor
// click that came back from it, a mark on its glyphs: the name a sentence
// calls it, never its release (an update draws what it drew); for one nothing
// names, the TERM it runs under, which this machine's terminals under that
// TERM share, so an answer for one is an answer for each (the better failure
// than a check no answer can settle); null where not even a TERM was said,
// since an answer there would hold for whichever terminal next said nothing.
export function sightingOf(identified: Identified): string | null {
  switch (identified.kind) {
    case "known":
      return terminalLabel(identified.terminal.name);
    case "unknown":
      return identified.called;
    case "unnamed":
      return identified.term || null;
  }
}

// The identified terminal as a sentence names it.
export function identifiedAs(identified: Identified): string {
  switch (identified.kind) {
    case "known":
      return terminalLabel(identified.terminal.name);
    case "unknown":
      return identified.called;
    case "unnamed":
      return identified.term || "this terminal";
  }
}

// Whether a known terminal draws OSC 8 links: it does, it draws none, or its
// release decides and either went unsaid or is too old.
export type LinkSupport =
  | { readonly kind: "draws" }
  | { readonly kind: "none" }
  | { readonly kind: "unsaid"; readonly since: string }
  | {
      readonly kind: "older";
      readonly since: string;
      readonly version: string;
    };

export function linkSupport({ name, version }: Terminal): LinkSupport {
  const links = row(name).links;
  if (links === null) return { kind: "none" };
  if (links.since === null) return { kind: "draws" };
  if (version === null) return { kind: "unsaid", since: links.since };
  const drawn = releasedSince(version, links.since);
  return drawn === null
    ? { kind: "unsaid", since: links.since }
    : drawn
      ? { kind: "draws" }
      : { kind: "older", since: links.since, version };
}

// The terminals that draw links, as a sentence lists them.
export const LINK_TERMINALS = NAMES.filter((n) => row(n).links !== null)
  .map(terminalLabel)
  .join(", ");

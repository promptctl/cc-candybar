// Which terminal emulator draws the session's bar, read from what the
// session's client and its tmux server say about it.
//
// [LAW:effects-at-boundaries] Pure: the client's `terminalEnv` hint and tmux's
// answer about its attached client arrive as values (src/doctor/edge.ts
// gathers them); this module only reads them.

import type { TerminalEnvHint } from "../terminal-hint.js";

// [LAW:types-are-the-program] The terminals the doctor knows how glyphs reach
// the screen in, split by HOW: a bundling terminal draws Nerd Font symbols from
// a copy of Symbols Nerd Font it ships, as a fallback behind whatever font is
// set, so its font setting cannot take them away; a configured terminal draws
// them only from the font it is set to use, which the doctor has to read.
//
// The release each bundling terminal first shipped its copy in (`null`: every
// release did) — kitty's changelog, 0.36.0 "Add NERD fonts builtin"; WezTerm's,
// 20220319 "Symbols Nerd Font Mono is now bundled"; Ghostty embeds Symbols Nerd
// Font in its binary, and its first public release did.
export const BUNDLED_SINCE = {
  kitty: "0.36.0",
  wezterm: "20220319",
  ghostty: null,
} as const satisfies Record<string, string | null>;

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

export type BundlingTerminal = keyof typeof BUNDLED_SINCE;
const CONFIGURED = ["iterm2", "alacritty"] as const;
export type ConfiguredTerminal = (typeof CONFIGURED)[number];
// Terminals the doctor knows by name but reads no font for.
export type UnreadTerminal = "apple-terminal" | "vscode";
export type TerminalName =
  | BundlingTerminal
  | ConfiguredTerminal
  | UnreadTerminal;

export function isConfigured(name: TerminalName): name is ConfiguredTerminal {
  return (CONFIGURED as readonly TerminalName[]).includes(name);
}

// [LAW:one-source-of-truth] Whether each terminal draws OSC 8 links, and the
// release it first did (`since: null`: every release did); `null` is a
// terminal that draws none. From OSC 8 adoption in terminal emulators,
// github.com/Alhadis/OSC8-Adoption: kitty 0.19, Alacritty 0.11, VS Code 1.72,
// iTerm2 3.1; WezTerm since early 2018, Ghostty before its first public
// release. Apple's Terminal is in no release of that list, and its users
// report it ignores OSC 8 (apple.stackexchange.com/questions/460189).
export const LINKS_SINCE: Readonly<
  Record<TerminalName, { readonly since: string | null } | null>
> = {
  kitty: { since: "0.19.0" },
  wezterm: { since: null },
  ghostty: { since: null },
  iterm2: { since: "3.1" },
  alacritty: { since: "0.11.0" },
  vscode: { since: "1.72" },
  "apple-terminal": null,
};

// A terminal named, and the release it reported, or null when nothing said.
export interface Terminal {
  readonly name: TerminalName;
  readonly version: string | null;
}

// How the doctor names each terminal in a sentence.
export const TERMINAL_LABEL: Readonly<Record<TerminalName, string>> = {
  kitty: "kitty",
  wezterm: "WezTerm",
  ghostty: "Ghostty",
  iterm2: "iTerm2",
  alacritty: "Alacritty",
  "apple-terminal": "Terminal",
  vscode: "VS Code",
};

export function isBundling(name: TerminalName): name is BundlingTerminal {
  return Object.hasOwn(BUNDLED_SINCE, name);
}

// What tmux says about the client attached to the session's pane: its
// XTVERSION reply (`#{client_termtype}`, e.g. `iTerm2 3.7.2`,
// `kitty(0.45.0)`, `ghostty 1.3.1`; empty from a terminal that does not
// answer) and the TERM it was started under (`#{client_termname}`).
export interface TmuxClientTerm {
  readonly termtype: string;
  readonly termname: string;
}

// [LAW:one-source-of-truth] Every spelling a terminal names itself with, in
// the three places it does: its XTVERSION reply (a prefix, the version after
// it), TERM_PROGRAM, and TERM. One table, read by every route below; `null`
// is a place the terminal does not name itself.
const SPELLINGS: Readonly<
  Record<
    TerminalName,
    {
      readonly xtversion: string | null;
      readonly program: string | null;
      readonly term: string | null;
    }
  >
> = {
  kitty: { xtversion: "kitty", program: null, term: "xterm-kitty" },
  wezterm: { xtversion: "WezTerm", program: "WezTerm", term: "wezterm" },
  ghostty: { xtversion: "ghostty", program: "ghostty", term: "xterm-ghostty" },
  iterm2: { xtversion: "iTerm2", program: "iTerm.app", term: null },
  alacritty: { xtversion: "alacritty", program: null, term: "alacritty" },
  "apple-terminal": { xtversion: null, program: "Apple_Terminal", term: null },
  vscode: { xtversion: null, program: "vscode", term: null },
};

const NAMES = Object.keys(SPELLINGS) as TerminalName[];

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
    const prefix = SPELLINGS[name].xtversion;
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
  const name = NAMES.find((n) => SPELLINGS[n].term === term);
  return name === undefined ? null : { name, version: null };
}

// What identifying the terminal found: one the doctor knows, or the name the
// terminal goes by (an empty string when nothing named it).
export type Identified =
  | { readonly kind: "known"; readonly terminal: Terminal }
  | { readonly kind: "unknown"; readonly called: string };

// Inside tmux the attached client is the terminal: tmux's word on it beats
// the session's environment, which tmux passes on from whichever terminal
// started the server.
export function identifyInTmux(client: TmuxClientTerm): Identified {
  const terminal = fromXtversion(client.termtype) ?? fromTerm(client.termname);
  return terminal === null
    ? { kind: "unknown", called: client.termtype || client.termname }
    : { kind: "known", terminal };
}

export function identifyFromEnv(env: TerminalEnvHint): Identified {
  const program = env.TERM_PROGRAM;
  const byProgram = NAMES.find((n) => SPELLINGS[n].program === program);
  const terminal =
    byProgram === undefined
      ? fromTerm(env.TERM)
      : { name: byProgram, version: env.TERM_PROGRAM_VERSION ?? null };
  return terminal === null
    ? { kind: "unknown", called: program ?? env.TERM ?? "" }
    : { kind: "known", terminal };
}

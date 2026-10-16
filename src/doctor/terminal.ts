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

export type BundlingTerminal = keyof typeof BUNDLED_SINCE;
export type ConfiguredTerminal = "iterm2" | "alacritty";
export type TerminalName = BundlingTerminal | ConfiguredTerminal;

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
// it), TERM_PROGRAM, and TERM. One table, read by every route below.
const SPELLINGS: Readonly<
  Record<
    TerminalName,
    {
      readonly xtversion: string;
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
    if (termtype.toLowerCase().startsWith(prefix.toLowerCase())) {
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

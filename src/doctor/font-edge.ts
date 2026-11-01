// Which font a configured terminal draws the bar's private-use glyphs with,
// and which of them that font lacks.
//
// [LAW:effects-at-boundaries] The doctor's font effects: iTerm2's preferences,
// Alacritty's config files, and the platform's own answer about a font's
// glyphs — CoreText through `osascript` on macOS, fontconfig's `fc-match`
// elsewhere. A verdict never sees any of it: the reads land in a `FontInUse`
// (src/doctor/checks.ts), and the functions that read the answers
// (`alacrittyFile`, `fcMatchCoverage`, `itermFontInUse`) are pure and tested
// over fixtures (test/doctor-nerd-font.test.ts).
//
// [LAW:one-source-of-truth] A terminal cannot be asked its font, so the font
// is read where the terminal itself reads it, and whether it HAS a glyph is
// the platform's word, never a guess from the font's name.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import type { Launcher } from "../proc/launch.js";
import type { Asked, FontInUse } from "./checks.js";
import { itermDrawsItself, type ConfiguredTerminal } from "./terminal.js";
import { DoctorBusy } from "./busy.js";
import type { TerminalEnvHint } from "../terminal-hint.js";

// [LAW:types-are-the-program] How a font is named where a terminal stores it:
// iTerm2 keeps a PostScript name (`JetBrainsMonoNF-Regular`), Alacritty a
// family (`JetBrainsMono Nerd Font`), and the platform looks each up its own
// way.
export type FontRef =
  | { readonly kind: "postscript"; readonly name: string }
  | { readonly kind: "family"; readonly name: string };

const hex = (glyph: string): string =>
  glyph.codePointAt(0)!.toString(16).toUpperCase();

// ─── macOS: CoreText through JXA ────────────────────────────────────────────

// [LAW:single-enforcer] One script answers every macOS question, so a doctor
// run spawns once. A glyph a font LACKS is one CoreText draws with LastResort
// — the box — when asked which font draws it (`CTFontCreateForString`): the
// font itself, or whatever it falls back to, is the platform's own word on
// what reaches the screen. Modes: `font <kind> <name> <codepoints>` resolves
// a font and lists the code points it lacks (`{ lacks }`, null when no
// installed font has that name); `iterm <profile> <codepoints>` reads the named iTerm2
// profile, or every profile for an empty name (`{ profiles }`), each as it
// stands — its name, the font that draws non-ASCII (its non-ASCII font when
// "Use a different font for non-ASCII text" is on, its own font otherwise; null
// when it names none), whether that is the non-ASCII font, whether its
// built-in Powerline glyphs are on, and what the font lacks. What a reading
// MEANS is decided in TypeScript (`itermFontInUse`). Errors answer `{ error }`.
const JXA = String.raw`
ObjC.import("AppKit");
ObjC.import("CoreText");
function lacksOf(font, points) {
  if (font.isNil()) return null;
  return points.filter((p) => {
    const text = $.NSString.stringWithString(String.fromCodePoint(parseInt(p, 16)));
    const drawn = $.CTFontCreateForString(font, text, $.CFRangeMake(0, text.length));
    return ObjC.castRefToObject($.CTFontCopyPostScriptName(drawn)).js === "LastResort";
  });
}
function resolve(kind, name) {
  return kind === "postscript"
    ? $.NSFont.fontWithNameSize(name, 12)
    : $.NSFontManager.sharedFontManager.fontWithFamilyTraitsWeightSize(name, 0, 5, 12);
}
function iterm(name, points) {
  const prefs = $.NSUserDefaults.alloc.initWithSuiteName("com.googlecode.iterm2");
  const books = prefs.arrayForKey("New Bookmarks");
  if (books.isNil()) return { error: "iTerm2 has no profiles in its preferences" };
  const profiles = [];
  for (let i = 0; i < books.count; i++) {
    const b = books.objectAtIndex(i);
    const get = (k) => ObjC.deepUnwrap(b.objectForKey(k));
    if (name !== "" && get("Name") !== name) continue;
    const nonAscii = get("Use Non-ASCII Font") === true;
    const setting = get(nonAscii ? "Non Ascii Font" : "Normal Font");
    const font = typeof setting === "string" ? setting.replace(/ [0-9.]+$/, "") : null;
    profiles.push({
      name: String(get("Name")),
      font,
      nonAscii,
      powerline: get("Draw Powerline Glyphs") === true,
      lacks: font === null ? null : lacksOf(resolve("postscript", font), points),
    });
  }
  return { profiles };
}
function run(argv) {
  const last = argv[argv.length - 1];
  const points = last === "" ? [] : last.split(",");
  return JSON.stringify(
    argv[0] === "font"
      ? { lacks: lacksOf(resolve(argv[1], argv[2]), points) }
      : iterm(argv[1], points),
  );
}
`;

async function jxa<T>(
  launcher: Launcher,
  args: readonly string[],
): Promise<Asked<T>> {
  const run = await launcher.launch({
    bin: "osascript",
    args: ["-l", "JavaScript", "-e", JXA, ...args],
    timeoutMs: 3000,
    category: "doctor.font",
  });
  if (!run.ok) {
    if (run.reason === "rate-limited") throw new DoctorBusy("the font");
    const detail = run.error ?? `${run.reason}: ${run.stderr.trim()}`;
    return { kind: "failed", reason: `osascript failed (${detail})` };
  }
  let answer: { readonly error: string } | T;
  try {
    answer = JSON.parse(run.stdout) as { readonly error: string } | T;
  } catch {
    return {
      kind: "failed",
      reason: `osascript answered ${JSON.stringify(run.stdout.trim())}, not JSON`,
    };
  }
  return typeof answer === "object" && answer !== null && "error" in answer
    ? { kind: "failed", reason: answer.error }
    : { kind: "ok", value: answer };
}

// The code points the script reads back (hex), as the glyphs they are.
const glyphsOf = (points: readonly string[]): string[] =>
  points.map((p) => String.fromCodePoint(parseInt(p, 16)));

const pointsArg = (glyphs: string): string => [...glyphs].map(hex).join(",");

// What a font is, as the platform draws it: the font it resolves to, and the
// glyphs that font lacks — null when no installed font has the name.
interface Coverage {
  readonly font: string;
  readonly lacks: readonly string[] | null;
}

async function macCoverage(
  launcher: Launcher,
  ref: FontRef,
  glyphs: string,
): Promise<Asked<Coverage>> {
  const answer = await jxa<{ readonly lacks: readonly string[] | null }>(
    launcher,
    ["font", ref.kind, ref.name, pointsArg(glyphs)],
  );
  if (answer.kind === "failed") return answer;
  const { lacks } = answer.value;
  return {
    kind: "ok",
    value: { font: ref.name, lacks: lacks === null ? null : glyphsOf(lacks) },
  };
}

// ─── iTerm2 ─────────────────────────────────────────────────────────────────

// One iTerm2 profile as the script read it, its lacks as glyphs.
export interface ItermProfile {
  readonly name: string;
  readonly font: string | null;
  readonly nonAscii: boolean;
  readonly powerline: boolean;
  readonly lacks: readonly string[] | null;
}

// What one profile draws the bar's glyphs with: its font, less the glyphs
// iTerm2 draws itself when the profile's built-in Powerline glyphs are on.
function profileReading(
  p: ItermProfile,
  version: string | null,
): Asked<FontInUse> {
  if (p.font === null) {
    return {
      kind: "failed",
      reason: `iTerm2 profile ${JSON.stringify(p.name)} names no font`,
    };
  }
  const from =
    `iTerm2 profile ${JSON.stringify(p.name)}` +
    (p.nonAscii ? ", its non-ASCII font" : "") +
    (p.powerline ? ", built-in Powerline glyphs on" : "");
  const lacks =
    p.lacks === null || !p.powerline
      ? p.lacks
      : p.lacks.filter((g) => !itermDrawsItself(version, g));
  return { kind: "ok", value: { font: p.font, from, lacks } };
}

const drawsEvery = (r: Asked<FontInUse>): boolean =>
  r.kind === "ok" && r.value.lacks !== null && r.value.lacks.length === 0;

// [LAW:effects-at-boundaries] Pure over the profiles the script read. A named
// profile is the one the session's window was opened with. With no name —
// inside tmux, where the session's environment names the window that started
// the server, not the attached one — every profile is read: the bar draws in
// whichever it is, so the first that cannot draw it is the answer, and only
// when none of them falls short is the answer that they all draw it.
export function itermFontInUse(
  profiles: readonly ItermProfile[],
  wanted: string | null,
  version: string | null,
): Asked<FontInUse> {
  if (profiles.length === 0) {
    return {
      kind: "failed",
      reason:
        wanted === null
          ? "iTerm2 has no profiles in its preferences"
          : `iTerm2 has no profile named ${JSON.stringify(wanted)}`,
    };
  }
  const readings = profiles.map((p) => profileReading(p, version));
  if (wanted !== null) return readings[0]!;
  const short = readings.find((r) => !drawsEvery(r));
  if (short !== undefined) {
    return short.kind === "failed"
      ? short
      : {
          kind: "ok",
          value: {
            ...short.value,
            from: `${short.value.from}, one of its profiles, and the session does not say which draws the bar`,
          },
        };
  }
  const fonts = [
    ...new Set(
      readings.flatMap((r) => (r.kind === "ok" ? [r.value.font] : [])),
    ),
  ];
  return {
    kind: "ok",
    value: {
      font: fonts.join(", "),
      from: "every iTerm2 profile, since the session does not say which draws the bar",
      lacks: [],
    },
  };
}

async function itermFont(
  launcher: Launcher,
  version: string | null,
  env: TerminalEnvHint,
  glyphs: string,
): Promise<Asked<FontInUse>> {
  if (process.platform !== "darwin") {
    return { kind: "failed", reason: "iTerm2 runs only on macOS" };
  }
  const wanted = env.ITERM_PROFILE ?? null;
  const answer = await jxa<{
    readonly profiles: ReadonlyArray<
      Omit<ItermProfile, "lacks"> & { readonly lacks: string[] | null }
    >;
  }>(launcher, ["iterm", wanted ?? "", pointsArg(glyphs)]);
  if (answer.kind === "failed") return answer;
  const profiles = answer.value.profiles.map((p) => ({
    ...p,
    lacks: p.lacks === null ? null : glyphsOf(p.lacks),
  }));
  return itermFontInUse(profiles, wanted, version);
}

// ─── fontconfig ─────────────────────────────────────────────────────────────

// [LAW:effects-at-boundaries] Pure over `fc-match --sort`'s answer: the
// fonts fontconfig draws a family with, best first — the font it resolves the
// name to (an alias like `monospace`, or a family no installed font has,
// resolves to whatever it substitutes), then the fonts a fontconfig terminal
// falls back to for a glyph that one lacks — one per line, a family, a tab,
// and its code points as hex ranges (`20-7e a0-17f e0b0-e0b3`). The font is
// the first; a glyph is lacking when no font in the list covers it.
export function fcMatchCoverage(
  output: string,
  glyphs: string,
): Asked<Coverage> {
  const lines = output.split("\n").filter((l) => l !== "");
  const fonts = lines.map((line) => {
    const tab = line.indexOf("\t");
    return tab <= 0
      ? null
      : {
          family: line.slice(0, tab),
          ranges: line
            .slice(tab + 1)
            .split(/\s+/)
            .filter((r) => r !== "")
            .map((range) => {
              const [lo, hi = lo] = range
                .split("-")
                .map((h) => parseInt(h, 16));
              return [lo!, hi!] as const;
            }),
        };
  });
  if (fonts.length === 0 || fonts.some((f) => f === null)) {
    return {
      kind: "failed",
      reason: `fc-match answered ${JSON.stringify(output.slice(0, 200))}, not families and their charsets`,
    };
  }
  const drawable = fonts.flatMap((f) => f!.ranges);
  const lacks = [...glyphs].filter((g) => {
    const p = g.codePointAt(0)!;
    return !drawable.some(([lo, hi]) => lo <= p && p <= hi);
  });
  return { kind: "ok", value: { font: fonts[0]!.family, lacks } };
}

// fontconfig's pattern syntax escapes these in a value.
const fcEscape = (value: string): string => value.replace(/[\\:,=-]/g, "\\$&");

// What fontconfig draws a family with — the font a fontconfig terminal ends
// up using, alias or not, and the fonts it falls back to.
async function fcCoverage(
  launcher: Launcher,
  family: string,
  glyphs: string,
): Promise<Asked<Coverage>> {
  const run = await launcher.launch({
    bin: "fc-match",
    args: [
      "--sort",
      "--format",
      "%{family[0]}\t%{charset}\n",
      `:family=${fcEscape(family)}`,
    ],
    timeoutMs: 3000,
    category: "doctor.font",
  });
  if (!run.ok) {
    if (run.reason === "rate-limited") throw new DoctorBusy("the font");
    const detail = run.error ?? `${run.reason}: ${run.stderr.trim()}`;
    return { kind: "failed", reason: `fc-match failed (${detail})` };
  }
  return fcMatchCoverage(run.stdout, glyphs);
}

function coverage(
  launcher: Launcher,
  ref: FontRef,
  glyphs: string,
): Promise<Asked<Coverage>> {
  return process.platform === "darwin"
    ? macCoverage(launcher, ref, glyphs)
    : fcCoverage(launcher, ref.name, glyphs);
}

// ─── Alacritty ──────────────────────────────────────────────────────────────

// Where Alacritty looks for its config, first found wins (its docs, "Location").
export function alacrittyConfigPaths(
  home: string,
  xdgConfigHome: string | undefined,
): readonly string[] {
  const xdg = xdgConfigHome || path.join(home, ".config");
  return [
    path.join(xdg, "alacritty", "alacritty.toml"),
    path.join(xdg, "alacritty.toml"),
    path.join(home, ".config", "alacritty", "alacritty.toml"),
    path.join(home, ".alacritty.toml"),
  ];
}

// The family Alacritty draws with when its config names none (its docs,
// `font.normal`).
export function alacrittyDefaultFamily(platform: NodeJS.Platform): string {
  return platform === "darwin" ? "Menlo" : "monospace";
}

const isTable = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

// What one parsed config file says: the family it sets, and the files it
// imports (`general.import`, or the older top-level `import`).
export function alacrittyFile(doc: Record<string, unknown>): {
  readonly family: string | null;
  readonly imports: readonly string[];
} {
  const font = isTable(doc.font) ? doc.font : {};
  const normal = isTable(font.normal) ? font.normal : {};
  const general = isTable(doc.general) ? doc.general : {};
  const imports = general.import ?? doc.import ?? [];
  return {
    family: typeof normal.family === "string" ? normal.family : null,
    imports: Array.isArray(imports)
      ? imports.filter((i): i is string => typeof i === "string")
      : [],
  };
}

// Alacritty's own merge: each import loads first, in order, and the file that
// imports it overrides them; imports nest at most five deep (its docs,
// `general.import`).
function alacrittyFamilyIn(
  file: string,
  home: string,
  depth: number,
): Asked<{ family: string; from: string } | null> {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    return {
      kind: "failed",
      reason: `cannot read ${file}: ${(e as Error).message}`,
    };
  }
  let doc: Record<string, unknown>;
  try {
    doc = parseToml(text);
  } catch (e) {
    return {
      kind: "failed",
      reason: `cannot parse ${file}: ${(e as Error).message}`,
    };
  }
  const own = alacrittyFile(doc);
  if (own.family !== null)
    return { kind: "ok", value: { family: own.family, from: file } };
  if (depth === 5) return { kind: "ok", value: null };
  let found: { family: string; from: string } | null = null;
  for (const imported of own.imports) {
    const target = imported.startsWith("~/")
      ? path.join(home, imported.slice(2))
      : path.resolve(path.dirname(file), imported);
    // Alacritty skips an import that is not there.
    if (!fs.existsSync(target)) continue;
    const inner = alacrittyFamilyIn(target, home, depth + 1);
    if (inner.kind === "failed") return inner;
    found = inner.value ?? found;
  }
  return { kind: "ok", value: found };
}

// The config is found under the SESSION's XDG_CONFIG_HOME (the client's
// hint), never the detached daemon's own.
async function alacrittyFont(
  launcher: Launcher,
  env: TerminalEnvHint,
  glyphs: string,
): Promise<Asked<FontInUse>> {
  const home = os.homedir();
  const config = alacrittyConfigPaths(home, env.XDG_CONFIG_HOME).find((p) =>
    fs.existsSync(p),
  );
  const named =
    config === undefined
      ? ({ kind: "ok", value: null } as const)
      : alacrittyFamilyIn(config, home, 0);
  if (named.kind === "failed") return named;
  const family =
    named.value?.family ?? alacrittyDefaultFamily(process.platform);
  const from =
    named.value?.from ??
    (config === undefined
      ? "Alacritty's default, no config file"
      : `Alacritty's default, ${config} sets none`);
  const drawn = await coverage(
    launcher,
    { kind: "family", name: family },
    glyphs,
  );
  if (drawn.kind === "failed") return drawn;
  const { font, lacks } = drawn.value;
  return {
    kind: "ok",
    value: {
      font,
      from:
        font === family ? from : `${from}; ${family} as fontconfig matches it`,
      lacks,
    },
  };
}

// [LAW:dataflow-not-control-flow] A total lookup: each configured terminal has
// its reader, so a new one is a compile error until it has one.
const READERS: Readonly<
  Record<
    ConfiguredTerminal,
    (
      launcher: Launcher,
      version: string | null,
      env: TerminalEnvHint,
      glyphs: string,
    ) => Promise<Asked<FontInUse>>
  >
> = {
  iterm2: itermFont,
  alacritty: (launcher, _version, env, glyphs) =>
    alacrittyFont(launcher, env, glyphs),
};

export function fontInUse(
  launcher: Launcher,
  terminal: {
    readonly name: ConfiguredTerminal;
    readonly version: string | null;
  },
  env: TerminalEnvHint,
  glyphs: string,
): Promise<Asked<FontInUse>> {
  return READERS[terminal.name](launcher, terminal.version, env, glyphs);
}

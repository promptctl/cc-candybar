// Which font a configured terminal draws the bar's private-use glyphs with,
// and which of them that font lacks.
//
// [LAW:effects-at-boundaries] The doctor's font effects: iTerm2's preferences,
// Alacritty's config files, and the platform's own answer about a font's
// glyphs — CoreText through `osascript` on macOS, fontconfig's `fc-list`
// elsewhere. A verdict never sees any of it: the reads land in a `FontInUse`
// (src/doctor/checks.ts), and the functions that read the answers
// (`alacrittyFile`, `fcLacks`) are pure and tested over fixtures
// (test/doctor-nerd-font.test.ts).
//
// [LAW:one-source-of-truth] A terminal cannot be asked its font, so the font
// is read where the terminal itself reads it, and whether it HAS a glyph is
// the platform's word, never a guess from the font's name.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { launchSync } from "../proc/launch.js";
import type { Asked, FontInUse } from "./checks.js";
import type { ConfiguredTerminal } from "./terminal.js";
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
// run spawns once. Modes: `font <kind> <name> <codepoints>` resolves a font
// and lists the code points it lacks; `iterm <profile> <codepoints>` first
// reads the iTerm2 profile's font (the session's profile, else the default
// one) — the font that draws non-ASCII when "Use a different font for
// non-ASCII text" is on, the profile's own font otherwise. Answers one JSON
// line: `{ font, from, lacks }` (`lacks` null when no installed font has
// that name), or `{ error }`.
const JXA = String.raw`
ObjC.import("AppKit");
function lacksOf(font, points) {
  if (font.isNil()) return null;
  const set = font.coveredCharacterSet;
  return points.filter((p) => !set.longCharacterIsMember(parseInt(p, 16)));
}
function resolve(kind, name) {
  return kind === "postscript"
    ? $.NSFont.fontWithNameSize(name, 12)
    : $.NSFontManager.sharedFontManager.fontWithFamilyTraitsWeightSize(name, 0, 5, 12);
}
function iterm(profile) {
  const prefs = $.NSUserDefaults.alloc.initWithSuiteName("com.googlecode.iterm2");
  const books = prefs.arrayForKey("New Bookmarks");
  if (books.isNil()) return { error: "iTerm2 has no profiles in its preferences" };
  const guid = ObjC.unwrap(prefs.stringForKey("Default Bookmark Guid"));
  for (let i = 0; i < books.count; i++) {
    const b = books.objectAtIndex(i);
    const get = (k) => ObjC.deepUnwrap(b.objectForKey(k));
    if (profile === "" ? get("Guid") !== guid : get("Name") !== profile) continue;
    const nonAscii = get("Use Non-ASCII Font") === true;
    const setting = get(nonAscii ? "Non Ascii Font" : "Normal Font");
    if (typeof setting !== "string") return { error: "iTerm2 profile " + JSON.stringify(get("Name")) + " names no font" };
    return {
      font: setting.replace(/ [0-9.]+$/, ""),
      from: "iTerm2 profile " + JSON.stringify(get("Name")) + (nonAscii ? ", its non-ASCII font" : ""),
    };
  }
  return { error: profile === "" ? "iTerm2's default profile is not among its profiles" : "iTerm2 has no profile named " + JSON.stringify(profile) };
}
function run(argv) {
  const last = argv[argv.length - 1];
  const points = last === "" ? [] : last.split(",");
  if (argv[0] === "font") {
    return JSON.stringify({ lacks: lacksOf(resolve(argv[1], argv[2]), points) });
  }
  const found = iterm(argv[1]);
  if (found.error !== undefined) return JSON.stringify(found);
  return JSON.stringify({ ...found, lacks: lacksOf(resolve("postscript", found.font), points) });
}
`;

type JxaAnswer =
  | { readonly error: string }
  | {
      readonly font?: string;
      readonly from?: string;
      readonly lacks: readonly string[] | null;
    };

function jxa(args: readonly string[]): Asked<JxaAnswer> {
  const run = launchSync({
    bin: "osascript",
    args: ["-l", "JavaScript", "-e", JXA, ...args],
    timeoutMs: 3000,
    category: "doctor.font",
  });
  if (!run.ok) {
    const detail = run.error ?? `${run.reason}: ${run.stderr.trim()}`;
    return { kind: "failed", reason: `osascript failed (${detail})` };
  }
  try {
    return { kind: "ok", value: JSON.parse(run.stdout) as JxaAnswer };
  } catch {
    return {
      kind: "failed",
      reason: `osascript answered ${JSON.stringify(run.stdout.trim())}, not JSON`,
    };
  }
}

// The code points the script reads back (hex), as the glyphs they are.
const glyphsOf = (points: readonly string[]): string[] =>
  points.map((p) => String.fromCodePoint(parseInt(p, 16)));

function macCoverage(
  ref: FontRef,
  glyphs: string,
): Asked<readonly string[] | null> {
  const answer = jxa([
    "font",
    ref.kind,
    ref.name,
    [...glyphs].map(hex).join(","),
  ]);
  if (answer.kind === "failed") return answer;
  const v = answer.value;
  if ("error" in v) return { kind: "failed", reason: v.error };
  return { kind: "ok", value: v.lacks === null ? null : glyphsOf(v.lacks) };
}

function itermFont(env: TerminalEnvHint, glyphs: string): Asked<FontInUse> {
  if (process.platform !== "darwin") {
    return { kind: "failed", reason: "iTerm2 runs only on macOS" };
  }
  const answer = jxa([
    "iterm",
    env.ITERM_PROFILE ?? "",
    [...glyphs].map(hex).join(","),
  ]);
  if (answer.kind === "failed") return answer;
  const v = answer.value;
  if ("error" in v) return { kind: "failed", reason: v.error };
  return {
    kind: "ok",
    value: {
      font: v.font!,
      from: v.from!,
      lacks: v.lacks === null ? null : glyphsOf(v.lacks),
    },
  };
}

// ─── fontconfig ─────────────────────────────────────────────────────────────

// [LAW:effects-at-boundaries] Pure over fc-list's output: one line of hex
// ranges (`20-7e a0-17f e0b0-e0b3`) per face of the family, none when no
// installed font has it. A glyph is lacking when no face covers it.
export function fcLacks(
  output: string,
  glyphs: string,
): readonly string[] | null {
  const faces = output.split("\n").filter((line) => line.trim() !== "");
  if (faces.length === 0) return null;
  const ranges = faces.flatMap((line) =>
    line
      .trim()
      .split(/\s+/)
      .map((range) => {
        const [lo, hi = lo] = range.split("-").map((h) => parseInt(h, 16));
        return [lo!, hi!] as const;
      }),
  );
  return [...glyphs].filter((g) => {
    const p = g.codePointAt(0)!;
    return !ranges.some(([lo, hi]) => lo <= p && p <= hi);
  });
}

// fontconfig's pattern syntax escapes these in a value.
const fcEscape = (value: string): string => value.replace(/[\\:,=-]/g, "\\$&");

function fcCoverage(
  family: string,
  glyphs: string,
): Asked<readonly string[] | null> {
  const run = launchSync({
    bin: "fc-list",
    args: ["--format", "%{charset}\n", `:family=${fcEscape(family)}`],
    timeoutMs: 3000,
    category: "doctor.font",
  });
  if (!run.ok) {
    const detail = run.error ?? `${run.reason}: ${run.stderr.trim()}`;
    return { kind: "failed", reason: `fc-list failed (${detail})` };
  }
  return { kind: "ok", value: fcLacks(run.stdout, glyphs) };
}

function coverage(
  ref: FontRef,
  glyphs: string,
): Asked<readonly string[] | null> {
  return process.platform === "darwin"
    ? macCoverage(ref, glyphs)
    : fcCoverage(ref.name, glyphs);
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

function alacrittyFont(glyphs: string): Asked<FontInUse> {
  const home = os.homedir();
  const config = alacrittyConfigPaths(home, process.env.XDG_CONFIG_HOME).find(
    (p) => fs.existsSync(p),
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
  const lacks = coverage({ kind: "family", name: family }, glyphs);
  if (lacks.kind === "failed") return lacks;
  return { kind: "ok", value: { font: family, from, lacks: lacks.value } };
}

// [LAW:dataflow-not-control-flow] A total lookup: each configured terminal has
// its reader, so a new one is a compile error until it has one.
const READERS: Readonly<
  Record<
    ConfiguredTerminal,
    (env: TerminalEnvHint, glyphs: string) => Asked<FontInUse>
  >
> = {
  iterm2: itermFont,
  alacritty: (_env, glyphs) => alacrittyFont(glyphs),
};

export function fontInUse(
  terminal: ConfiguredTerminal,
  env: TerminalEnvHint,
  glyphs: string,
): Asked<FontInUse> {
  return READERS[terminal](env, glyphs);
}

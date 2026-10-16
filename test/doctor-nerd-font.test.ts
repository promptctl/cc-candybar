// [LAW:verifiable-goals] brandon-doctor-v62x.2ww: "Nerd Font is set up and in
// use" — the probe over fixture facts, each arm a terminal the bar can be
// drawn in, pure; the glyphs it asks about measured through the joiner; and
// the pure readers the font edge parses with.

import {
  checkByName,
  glyphSighting,
  type DoctorFacts,
  type NerdFontFacts,
  type TerminalFacts,
  type Verdict,
} from "../src/doctor/checks";
import { stripPrivateGlyphs } from "../src/render/strip";
import {
  alacrittyConfigPaths,
  alacrittyDefaultFamily,
  alacrittyFile,
  fcLacks,
} from "../src/doctor/font-edge";
import { gatherFacts, parseTmuxClient, type DoctorEdge } from "../src/doctor/edge";
import {
  doctorMarkKey,
  markValue,
  nerdFontFields,
  parseMark,
} from "../src/doctor/report";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import type { DslConfig } from "../src/config/dsl-types";
import type { ClientHints } from "../src/daemon/protocol";

const GLYPHS = "";
const probe = checkByName("nerdFont")!.probe;

const facts = (nerdFont: NerdFontFacts): DoctorFacts => ({
  tmux: { kind: "outside" },
  config: { kind: "loaded", layers: [], warnings: [], unused: [] },
  effect: { kind: "decided", name: "none", value: "none" },
  placementEffects: [],
  transitions: false,
  urlHandler: { kind: "unsupported" },
  nerdFont,
  claudeSettings: { path: "/s.json", env: {}, statusLine: { kind: "absent" } },
});

const verdictIn = (
  terminal: TerminalFacts,
  mark: NerdFontFacts["mark"] = null,
  glyphs = GLYPHS,
): Verdict => probe(facts({ glyphs, terminal, mark }));

const ITERM = (font: Extract<TerminalFacts, { kind: "configured" }>["font"]): TerminalFacts => ({
  kind: "configured",
  name: "iterm2",
  version: "3.7.2",
  font,
});
const MENLO: TerminalFacts = ITERM({
  kind: "ok",
  value: { font: "Menlo-Regular", from: 'iTerm2 profile "Default"', lacks: [...GLYPHS] },
});

// Every failed verdict shows the glyphs to mark, under its sighting.
function expectFailedWithSighting(v: Verdict, terminal: TerminalFacts): string {
  expect(v.ok).toBe(false);
  if (v.ok) throw new Error("unreachable");
  expect(v.sighting).toEqual(glyphSighting({ glyphs: GLYPHS, terminal }));
  expect(v.sighting!.glyphs).toBe(GLYPHS);
  return v.reason;
}

describe("nerdFont probe", () => {
  test("a bar that draws no private-use glyph needs no Nerd Font, whatever the terminal", () => {
    expect(verdictIn({ kind: "unreported" }, null, "")).toEqual({ ok: true });
    expect(verdictIn(MENLO, null, "")).toEqual({ ok: true });
  });

  test("a bundling terminal at or past the release that ships its symbols is ok", () => {
    expect(verdictIn({ kind: "bundling", name: "ghostty", version: null })).toEqual({ ok: true });
    expect(verdictIn({ kind: "bundling", name: "kitty", version: "0.45.0" })).toEqual({ ok: true });
    expect(
      verdictIn({ kind: "bundling", name: "wezterm", version: "20240203-110809-5046fc22" }),
    ).toEqual({ ok: true });
  });

  test("an older bundling terminal says the release its symbols came in", () => {
    const t: TerminalFacts = { kind: "bundling", name: "kitty", version: "0.35.2" };
    expect(expectFailedWithSighting(verdictIn(t), t)).toBe(
      'kitty 0.35.2 ships no Nerd Font symbols (they came in 0.36.0) — update kitty, or set a Nerd Font as its font, or set globals.charset to "ascii" to draw the bar without them',
    );
  });

  test("a bundling terminal that did not say its release asks the user to look", () => {
    const t: TerminalFacts = { kind: "bundling", name: "kitty", version: null };
    expect(expectFailedWithSighting(verdictIn(t), t)).toBe(
      "kitty ships Nerd Font symbols since 0.36.0, and did not say which release this is",
    );
  });

  test("a configured terminal whose font has every glyph is ok", () => {
    const covered = ITERM({
      kind: "ok",
      value: { font: "JetBrainsMonoNF-Regular", from: 'iTerm2 profile "Default"', lacks: [] },
    });
    expect(verdictIn(covered)).toEqual({ ok: true });
  });

  test("a configured terminal whose font lacks glyphs names the font, where it was read, and what it lacks", () => {
    expect(expectFailedWithSighting(verdictIn(MENLO), MENLO)).toBe(
      'iTerm2 3.7.2 draws with Menlo-Regular (iTerm2 profile "Default"), which has no U+E0B0 U+E0B1 — set a Nerd Font as its font, or set globals.charset to "ascii" to draw the bar without them',
    );
  });

  test("a font no installed font goes by is named as not installed", () => {
    const t: TerminalFacts = {
      kind: "configured",
      name: "alacritty",
      version: null,
      font: {
        kind: "ok",
        value: { font: "Hack Nerd Font", from: "/h/.config/alacritty/alacritty.toml", lacks: null },
      },
    };
    expect(expectFailedWithSighting(verdictIn(t), t)).toBe(
      'Alacritty is set to Hack Nerd Font (/h/.config/alacritty/alacritty.toml), which is not installed — install it or set a Nerd Font, or set globals.charset to "ascii" to draw the bar without them',
    );
  });

  test("a font that could not be read is the reason, and the user is asked to look", () => {
    const t = ITERM({ kind: "failed", reason: 'iTerm2 has no profile named "Nope"' });
    expect(expectFailedWithSighting(verdictIn(t), t)).toBe(
      `the doctor cannot read iTerm2 3.7.2's font: iTerm2 has no profile named "Nope"`,
    );
  });

  test("a terminal the doctor cannot name, or could not ask about, asks the user to look", () => {
    const cases: Array<[TerminalFacts, string]> = [
      [{ kind: "unknown", called: "Apple_Terminal" }, "the doctor cannot read Apple_Terminal's font"],
      [{ kind: "unknown", called: "" }, "the doctor cannot read this terminal's font"],
      [
        { kind: "unasked", reason: "tmux display failed (no server)" },
        "tmux could not be asked which terminal is attached: tmux display failed (no server)",
      ],
      [
        { kind: "unreported" },
        "the client reported no terminal — re-run `cc-candybar install` to stage a current client",
      ],
    ];
    for (const [t, reason] of cases) {
      expect(expectFailedWithSighting(verdictIn(t), t)).toBe(reason);
    }
  });

  test("the user's mark settles it — but only on the sighting it was made on", () => {
    const sighting = glyphSighting({ glyphs: GLYPHS, terminal: MENLO }).id;
    expect(verdictIn(MENLO, { mark: "drawn", sighting })).toEqual({ ok: true });
    expect(expectFailedWithSighting(verdictIn(MENLO, { mark: "boxes", sighting }), MENLO)).toBe(
      'iTerm2 3.7.2 draws U+E0B0 U+E0B1 as boxes — set a Nerd Font as its font, or set globals.charset to "ascii" to draw the bar without them',
    );
    // Made in another terminal, or on another joiner's glyphs: no mark here.
    const elsewhere = glyphSighting({
      glyphs: GLYPHS,
      terminal: { kind: "unknown", called: "Apple_Terminal" },
    }).id;
    expect(verdictIn(MENLO, { mark: "drawn", sighting: elsewhere })).toEqual(verdictIn(MENLO));
    const otherGlyphs = glyphSighting({ glyphs: "", terminal: MENLO }).id;
    expect(verdictIn(MENLO, { mark: "drawn", sighting: otherGlyphs })).toEqual(verdictIn(MENLO));
  });
});

describe("the glyphs the bar draws", () => {
  test("are measured through the joiner, divider included, in the charset in force", () => {
    expect(stripPrivateGlyphs({ endcaps: "powerline", charset: "unicode" })).toBe("");
    expect(stripPrivateGlyphs({ endcaps: "capsule", charset: "unicode" })).toBe("");
    expect(stripPrivateGlyphs({ endcaps: "powerline", charset: "ascii" })).toBe("");
    expect(stripPrivateGlyphs({ endcaps: "stitch", charset: "unicode" })).toBe("");
  });

  test("include a private-use separator the author chose for plain", () => {
    expect(
      stripPrivateGlyphs({ endcaps: "plain", charset: "unicode", separator: "" }),
    ).toBe("");
    expect(stripPrivateGlyphs({ endcaps: "plain", charset: "unicode", separator: "|" })).toBe("");
  });
});

describe("the marks a doctor verb records", () => {
  test("read back as they were written", () => {
    const mark = { mark: "boxes" as const, sighting: "iTerm2 3.7.2|U+E0B0 U+E0B1" };
    expect(parseMark(markValue(mark))).toEqual(mark);
  });

  test("a value that does not read is a fault, never a missing mark", () => {
    expect(() => parseMark("maybe:x")).toThrow(/a recorded mark reads "maybe:x"/);
    expect(() => parseMark("drawn")).toThrow(/a recorded mark reads "drawn"/);
  });
});

describe("the doctor event's Nerd Font fields", () => {
  test("say the glyphs, the terminal, the font and the mark", () => {
    expect(nerdFontFields({ glyphs: GLYPHS, terminal: MENLO, mark: null })).toBe(
      'glyphs=e0b0,e0b1 terminal=iterm2@3.7.2 font="Menlo-Regular":lacks2 mark=-',
    );
    expect(
      nerdFontFields({
        glyphs: "",
        terminal: { kind: "unknown", called: "Apple Terminal" },
        mark: { mark: "drawn", sighting: "x" },
      }),
    ).toBe('glyphs=- terminal=unknown:"Apple Terminal" font=- mark=drawn');
  });
});

describe("parseTmuxClient", () => {
  test("reads the three fields asked for", () => {
    expect(parseTmuxClient("osc7,RGB\tiTerm2 3.7.2\txterm-256color\n")).toEqual({
      kind: "ok",
      value: { features: ["osc7", "RGB"], termtype: "iTerm2 3.7.2", termname: "xterm-256color" },
    });
    expect(parseTmuxClient("\t\t\n")).toEqual({
      kind: "ok",
      value: { features: [], termtype: "", termname: "" },
    });
  });

  test("anything else is a failure naming what came back", () => {
    expect(parseTmuxClient("osc7,RGB\n")).toEqual({
      kind: "failed",
      reason: 'tmux answered "osc7,RGB\\n", not the three fields asked for',
    });
  });
});

describe("the font edge's readers", () => {
  test("fcLacks: a glyph no face's ranges cover is lacking; no faces is not installed", () => {
    expect(fcLacks("20-7e a0-17f e0b0-e0b3\n", GLYPHS)).toEqual([]);
    expect(fcLacks("20-7e e0b0\n", GLYPHS)).toEqual([""]);
    expect(fcLacks("20-7e\ne0b0-e0b1\n", GLYPHS)).toEqual([]);
    expect(fcLacks("", GLYPHS)).toBeNull();
  });

  test("alacrittyFile reads font.normal.family and both import spellings", () => {
    expect(alacrittyFile({ font: { normal: { family: "Hack Nerd Font" } } })).toEqual({
      family: "Hack Nerd Font",
      imports: [],
    });
    expect(alacrittyFile({ general: { import: ["~/a.toml"] } })).toEqual({
      family: null,
      imports: ["~/a.toml"],
    });
    expect(alacrittyFile({ import: ["b.toml", 3] })).toEqual({ family: null, imports: ["b.toml"] });
  });

  test("Alacritty's config locations and default family", () => {
    expect(alacrittyConfigPaths("/h", undefined)).toEqual([
      "/h/.config/alacritty/alacritty.toml",
      "/h/.config/alacritty.toml",
      "/h/.config/alacritty/alacritty.toml",
      "/h/.alacritty.toml",
    ]);
    expect(alacrittyConfigPaths("/h", "/x")[0]).toBe("/x/alacritty/alacritty.toml");
    expect(alacrittyDefaultFamily("darwin")).toBe("Menlo");
    expect(alacrittyDefaultFamily("linux")).toBe("monospace");
  });
});

describe("gatherFacts: where the Nerd Font facts come from", () => {
  const HINT = { socket: "/s", pane: "%1", truecolor: null };
  const ORIGIN = { projectDir: "/tmp/proj", cwd: "/tmp/proj", configFile: null };
  const COVERED = {
    kind: "ok" as const,
    value: { font: "JetBrainsMonoNF-Regular", from: 'iTerm2 profile "Default"', lacks: [] },
  };
  let conf: string;
  beforeEach(() => {
    conf = fs.mkdtempSync(path.join(os.tmpdir(), "cc-candybar-nerd-font-"));
  });
  afterEach(() => {
    fs.rmSync(conf, { recursive: true, force: true });
  });

  const edge = (
    client: DoctorEdge["probeTmux"],
    config: DslConfig = DEFAULT_DSL_CONFIG,
  ) => {
    const asked: unknown[][] = [];
    const e: DoctorEdge = {
      probeTmux: client,
      fontInUse: (...args) => {
        asked.push(args);
        return COVERED;
      },
      loadConfig: () => ({ layers: [], error: null, warning: null, unused: [], config }),
    };
    return { e, asked };
  };
  const tmuxSays = (termtype: string): DoctorEdge["probeTmux"] => () => ({
    kind: "ok",
    value: { features: [], termtype, termname: "xterm-256color" },
  });
  const gather = (
    e: DoctorEdge,
    hints: Partial<Pick<ClientHints, "tmux" | "terminalEnv">>,
    pick: (key: string) => string | null = () => null,
  ) => gatherFacts(e, { claudeConfigDir: conf, ...hints }, ORIGIN, pick).nerdFont;

  test("inside tmux, tmux's attached client names the terminal over the session's env", () => {
    const { e, asked } = edge(tmuxSays("iTerm2 3.7.2"));
    const env = { TERM_PROGRAM: "tmux", ITERM_PROFILE: "Work" };
    expect(gather(e, { tmux: HINT, terminalEnv: env })).toEqual({
      glyphs: GLYPHS,
      terminal: { kind: "configured", name: "iterm2", version: "3.7.2", font: COVERED },
      mark: null,
    });
    // The font is read with the session's env — its iTerm2 profile.
    expect(asked).toEqual([["iterm2", env, GLYPHS]]);
  });

  test("a bundling terminal reads no font", () => {
    const { e, asked } = edge(tmuxSays("kitty(0.45.0)"));
    expect(gather(e, { tmux: HINT, terminalEnv: {} }).terminal).toEqual({
      kind: "bundling",
      name: "kitty",
      version: "0.45.0",
    });
    expect(asked).toEqual([]);
  });

  test("a tmux that could not be asked is unasked; a client too old to report is unreported", () => {
    const { e, asked } = edge(() => ({ kind: "failed", reason: "no server" }));
    expect(gather(e, { tmux: HINT, terminalEnv: {} }).terminal).toEqual({
      kind: "unasked",
      reason: "no server",
    });
    expect(gather(e, { tmux: null }).terminal).toEqual({ kind: "unreported" });
    expect(gather(e, {}).terminal).toEqual({ kind: "unreported" });
    expect(asked).toEqual([]);
  });

  test("outside tmux, the session's env names the terminal", () => {
    const { e } = edge(() => {
      throw new Error("tmux must not be asked outside it");
    });
    expect(gather(e, { tmux: null, terminalEnv: { TERM: "xterm-kitty" } }).terminal).toEqual({
      kind: "bundling",
      name: "kitty",
      version: null,
    });
  });

  test("the glyphs are the ones the session's bar draws, under its charset", () => {
    const ascii: DslConfig = {
      ...DEFAULT_DSL_CONFIG,
      globals: { ...DEFAULT_DSL_CONFIG.globals, charset: "ascii" },
    };
    const { e } = edge(tmuxSays("ghostty 1.3.1"), ascii);
    expect(gather(e, { tmux: HINT, terminalEnv: {} }).glyphs).toBe("");
  });

  test("the session's recorded mark is read; one that does not read stops the run loudly", () => {
    const { e } = edge(tmuxSays("ghostty 1.3.1"));
    const mark = { mark: "drawn" as const, sighting: "Ghostty 1.3.1|U+E0B0 U+E0B1" };
    const key = doctorMarkKey("nerdFont");
    expect(
      gather(e, { tmux: HINT }, (k) => (k === key ? markValue(mark) : null)).mark,
    ).toEqual(mark);
    expect(() => gather(e, { tmux: HINT }, (k) => (k === key ? "junk" : null))).toThrow(
      /a recorded mark reads "junk"/,
    );
  });
});

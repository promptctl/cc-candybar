// [LAW:verifiable-goals] brandon-doctor-v62x.2ww: "Nerd Font is set up and in
// use" — the probe over fixture facts, each arm a terminal the bar can be
// drawn in, pure; the glyphs it asks about measured through the joiner; and
// the pure readers the font edge parses with.

import type { RenderOrigin } from "../src/config-hint";
import { BUNDLED_GLYPHS } from "./helpers/bundled-glyphs";
import {
  checkByName,
  glyphSighting,
  type DoctorFacts,
  type NerdFontFacts,
  type GlyphMark,
  type TerminalFacts,
  type Verdict,
} from "../src/doctor/checks";
import { stripPrivateGlyphs } from "../src/render/strip";
import {
  alacrittyConfigPaths,
  alacrittyDefaultFamily,
  alacrittyFile,
  fcMatchCoverage,
  itermFontInUse,
  type ItermProfile,
} from "../src/doctor/font-edge";
import { itermDrawsItself } from "../src/doctor/terminal";
import {
  descendsFromRemoteLogin,
  gatherFacts,
  parseTmuxClient,
  type DoctorEdge,
  type StoresRead,
} from "../src/doctor/edge";
import type { Asked } from "../src/doctor/checks";
import {
  nerdFontFields,
} from "../src/doctor/report";
import { parseMarkBook, withMark } from "../src/doctor/mark-book";
import { EMPTY_STORES, HEALTHY_FACTS, healthyDaemonEdge, healthyDataEdge, noManagedSettings, HEALTHY_SERVING, HEALTHY_INSTALL_EDGE, CARRIED, NAMED, STILL, sightedIn } from "./helpers/doctor-facts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import type { DslConfig } from "../src/config/dsl-types";
import type { ClientHints } from "../src/daemon/protocol";

// Two private-use glyphs a bar draws: the powerline arrow and the wrapper's
// lead.
const GLYPHS = "\u{E0B0}\u{E0B2}";
const probe = checkByName("nerdFont")!.probe;

// A mark made on one sighting, as the verb files it in the book.
interface Made {
  readonly mark: GlyphMark;
  readonly sighting: string;
}

const facts = (
  nerdFont: NerdFontFacts,
  mark: Made | null = null,
  marks: DoctorFacts["marks"] = {
    kind: "ok",
    value: mark === null ? {} : withMark({}, "nerdFont", mark.sighting, mark.mark),
  },
): DoctorFacts => ({ ...HEALTHY_FACTS, nerdFont, marks });

const verdictIn = (terminal: TerminalFacts, mark: Made | null = null): Verdict =>
  probe(facts({ kind: "glyphs", glyphs: GLYPHS, terminal }, mark));

// The id a mark on these glyphs in this terminal is filed under.
const idIn = (terminal: TerminalFacts, glyphs = GLYPHS): string =>
  glyphSighting({ glyphs, terminal })!.id;

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
  test("a bar that draws no private-use glyph needs no Nerd Font", () => {
    expect(probe(facts({ kind: "none" }))).toEqual({ ok: true });
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
      'kitty 0.35.2 ships no Nerd Font symbols (they came in 0.36.0) — update kitty, or set a Nerd Font as its font',
    );
  });

  test("a WezTerm bundling Nerd Fonts v2, without the gauge's nf-md icons, is not ok", () => {
    const t: TerminalFacts = { kind: "bundling", name: "wezterm", version: "20230408-112425-69ae8472" };
    expect(expectFailedWithSighting(verdictIn(t), t)).toContain("(they came in 20230712)");
    expect(
      verdictIn({ kind: "bundling", name: "wezterm", version: "20230712-072601-f4abf8fd" }),
    ).toEqual({ ok: true });
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
      'iTerm2 3.7.2 draws with Menlo-Regular (iTerm2 profile "Default"), which has no U+E0B0 U+E0B2 — set a Nerd Font as its font',
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
      'Alacritty is set to Hack Nerd Font (/h/.config/alacritty/alacritty.toml), which is not installed — install it or set a Nerd Font',
    );
  });

  test("a font that could not be read is the reason, and the user is asked to look", () => {
    const t = ITERM({ kind: "failed", reason: 'iTerm2 has no profile named "Nope"' });
    expect(expectFailedWithSighting(verdictIn(t), t)).toBe(
      `the doctor cannot read iTerm2 3.7.2's font: iTerm2 has no profile named "Nope"`,
    );
  });

  test("a terminal the doctor does not know, but a name, asks the user to look", () => {
    const t: TerminalFacts = { kind: "unknown", called: "Hyper" };
    expect(expectFailedWithSighting(verdictIn(t), t)).toBe("the doctor cannot read Hyper's font");
  });

  // Known by name, its font unread: the sighting is the name a sentence calls
  // it, never its release, as for every terminal the doctor knows.
  test("a terminal the doctor knows but reads no font for asks the user to look, under its label", () => {
    const t: TerminalFacts = { kind: "unread", name: "apple-terminal", version: "455.1" };
    expect(expectFailedWithSighting(verdictIn(t), t)).toBe("the doctor cannot read Terminal 455.1's font");
    expect(idIn(t)).toMatch(/^Terminal\|/);
  });

  // Apple's Terminal inside tmux answers no XTVERSION: its TERM is all that is
  // said of it, shared only by this machine's terminals under that TERM.
  test("a terminal nothing names but its TERM asks the user to look, under that TERM", () => {
    const t: TerminalFacts = { kind: "unnamed", term: "xterm-256color" };
    expect(expectFailedWithSighting(verdictIn(t), t)).toBe("the doctor cannot read xterm-256color's font");
    expect(idIn(t)).toMatch(/^xterm-256color\|/);
  });

  // A mark there would answer for whichever terminal next goes unnamed.
  test("where nothing names the terminal, there is nothing to mark", () => {
    const cases: Array<[TerminalFacts, string]> = [
      [{ kind: "unnamed", term: "" }, "the doctor cannot read this terminal's font"],
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
      expect(verdictIn(t)).toEqual({ ok: false, reason });
      expect(glyphSighting({ glyphs: GLYPHS, terminal: t })).toBeUndefined();
    }
  });

  test("a sighting names the terminal, never its release, and what its font reading was", () => {
    const kitty = (version: string | null): TerminalFacts => ({ kind: "bundling", name: "kitty", version });
    expect(idIn(kitty("0.45.0"))).toBe(idIn(kitty(null)));
    expect(idIn(kitty(null))).toBe("kitty|U+E0B0 U+E0B2");
    expect(idIn(MENLO)).toBe('iTerm2 with Menlo-Regular (iTerm2 profile "Default")|U+E0B0 U+E0B2');
    // Turning the built-in glyphs on is a different reading, so a different sighting.
    const builtIn = ITERM({
      kind: "ok",
      value: { font: "Menlo-Regular", from: 'iTerm2 profile "Default", built-in Powerline glyphs on', lacks: [] },
    });
    expect(idIn(builtIn)).not.toBe(idIn(MENLO));
  });

  test("a mark book that cannot be read is told beside a failure a mark could settle, which offers no mark; a pass needs no book", () => {
    const broken: DoctorFacts["marks"] = { kind: "failed", reason: "/s/doctor-marks.json is not JSON" };
    const f = facts({ kind: "glyphs", glyphs: GLYPHS, terminal: MENLO }, null, broken);
    expect(probe(f)).toEqual({
      ok: false,
      reason: 'iTerm2 3.7.2 draws with Menlo-Regular (iTerm2 profile "Default"), which has no U+E0B0 U+E0B2 — set a Nerd Font as its font',
      more: ["the mark book could not be read: /s/doctor-marks.json is not JSON"],
    });
    // Nothing names the terminal, so no mark could settle it, and no book is told.
    expect(probe(facts({ kind: "glyphs", glyphs: GLYPHS, terminal: { kind: "unreported" } }, null, broken))).toEqual({
      ok: false,
      reason: "the client reported no terminal — re-run `cc-candybar install` to stage a current client",
    });
    const ghostty: TerminalFacts = { kind: "bundling", name: "ghostty", version: null };
    expect(probe(facts({ kind: "glyphs", glyphs: GLYPHS, terminal: ghostty }, null, broken))).toEqual({ ok: true });
    expect(checkByName("config")!.probe(f).ok).toBe(true);
    // A bar with no private-use glyph needs no mark, so no book.
    expect(probe(facts({ kind: "none" }, null, broken))).toEqual({ ok: true });
  });

  test("the user's mark settles it — but only on the sighting it was made on", () => {
    const sighting = idIn(MENLO);
    expect(verdictIn(MENLO, { mark: "drawn", sighting })).toEqual({ ok: true });
    expect(expectFailedWithSighting(verdictIn(MENLO, { mark: "boxes", sighting }), MENLO)).toBe(
      'iTerm2 3.7.2 draws U+E0B0 U+E0B2 as boxes — set a Nerd Font as its font',
    );
    // Made in another terminal, or on another joiner's glyphs: no mark here.
    const elsewhere = idIn({ kind: "unknown", called: "Apple_Terminal" });
    expect(verdictIn(MENLO, { mark: "drawn", sighting: elsewhere })).toEqual(verdictIn(MENLO));
    const otherGlyphs = idIn(MENLO, "");
    expect(verdictIn(MENLO, { mark: "drawn", sighting: otherGlyphs })).toEqual(verdictIn(MENLO));
  });

  test("a mark made under one font answers nothing once the terminal draws with another", () => {
    const boxes = { mark: "boxes" as const, sighting: idIn(MENLO) };
    const nerd = ITERM({
      kind: "ok",
      value: { font: "JetBrainsMonoNF-Regular", from: 'iTerm2 profile "Default"', lacks: [] },
    });
    // The fix the ✗ recommended is the reading that counts now.
    expect(verdictIn(nerd, boxes)).toEqual({ ok: true });
    // And a ✓ made on the Nerd Font does not carry back to a font without the glyphs.
    const drawn = { mark: "drawn" as const, sighting: idIn(nerd) };
    expect(verdictIn(MENLO, drawn)).toEqual(verdictIn(MENLO));
  });
});

describe("the glyphs the bar draws", () => {
  test("are measured through the joiner", () => {
    expect(stripPrivateGlyphs({ endcaps: "powerline" })).toBe("");
    expect(stripPrivateGlyphs({ endcaps: "capsule" })).toBe("");
    expect(stripPrivateGlyphs({ endcaps: "stitch" })).toBe("");
  });

  test("include a private-use separator the author chose for plain", () => {
    expect(
      stripPrivateGlyphs({ endcaps: "plain", separator: "" }),
    ).toBe("");
    expect(stripPrivateGlyphs({ endcaps: "plain", separator: "|" })).toBe("");
  });
});

describe("the mark book", () => {
  const ID = "iTerm2 3.7.2 with Menlo-Regular|U+E0B0 U+E0B2";

  test("files each mark under its check and sighting; the latest mark on a sighting answers", () => {
    const once = withMark({}, "nerdFont", ID, "boxes");
    expect(once).toEqual({ nerdFont: { [ID]: "boxes" } });
    expect(withMark(once, "nerdFont", "other", "drawn")).toEqual({
      nerdFont: { [ID]: "boxes", other: "drawn" },
    });
    expect(withMark(once, "nerdFont", ID, "drawn")).toEqual({ nerdFont: { [ID]: "drawn" } });
  });

  test("a document that is not a mark book fails saying how", () => {
    expect(parseMarkBook({ nerdFont: { [ID]: "drawn" } })).toEqual({
      kind: "ok",
      value: { nerdFont: { [ID]: "drawn" } },
    });
    const reason = (doc: unknown) => {
      const r = parseMarkBook(doc);
      return r.kind === "failed" ? r.reason : "read";
    };
    expect(reason([])).toBe("is not an object");
    expect(reason({ nerdFont: 3 })).toBe('holds "nerdFont" as something other than its sightings');
    expect(reason({ nerdFont: { x: "maybe" } })).toBe('marks "x" "maybe", not drawn or boxes');
  });

});

describe("the doctor event's Nerd Font fields", () => {
  test("say the glyphs, the terminal, the font and the mark honoured", () => {
    const menlo = { kind: "glyphs" as const, glyphs: GLYPHS, terminal: MENLO };
    expect(nerdFontFields(menlo, { kind: "ok", value: {} })).toBe(
      'glyphs=e0b0,e0b2 terminal=iterm2@3.7.2 font="Menlo-Regular":lacks2 mark=-',
    );
    // The mark on the sighting shown is the one honoured; one on another is not.
    const book: DoctorFacts["marks"] = {
      kind: "ok",
      value: withMark(withMark({}, "nerdFont", idIn(MENLO), "boxes"), "nerdFont", "elsewhere", "drawn"),
    };
    expect(nerdFontFields(menlo, book)).toMatch(/ mark=boxes$/);
    expect(
      nerdFontFields(
        { kind: "glyphs", glyphs: GLYPHS, terminal: { kind: "unknown", called: "Apple Terminal" } },
        book,
      ),
    ).toBe('glyphs=e0b0,e0b2 terminal=unknown:"Apple Terminal" font=- mark=-');
    expect(nerdFontFields({ kind: "none" }, book)).toBe("glyphs=- terminal=- font=- mark=-");
    expect(nerdFontFields(menlo, { kind: "failed", reason: "x" })).toMatch(/ mark=unread$/);
  });
});

describe("parseTmuxClient", () => {
  test("reads the five fields asked for", () => {
    expect(parseTmuxClient("osc7,RGB\tiTerm2 3.7.2\txterm-256color\t84566\t1\n")).toEqual({
      kind: "ok",
      value: {
        features: ["osc7", "RGB"],
        termtype: "iTerm2 3.7.2",
        termname: "xterm-256color",
        pid: 84566,
        utf8: true,
      },
    });
    expect(parseTmuxClient("osc7\t\txterm\t7\t0\n")).toEqual({
      kind: "ok",
      value: { features: ["osc7"], termtype: "", termname: "xterm", pid: 7, utf8: false },
    });
    // No client attached to the pane's session: every field empty, an answer.
    expect(parseTmuxClient("\t\t\t\t\n")).toEqual({ kind: "ok", value: null });
  });

  test("anything else is a failure naming what came back", () => {
    for (const out of [
      "osc7,RGB\n",
      "osc7\tiTerm2\txterm\tx1\t1\n",
      "osc7\tiTerm2\txterm\t0\t1\n",
      // The four fields an older format asked for.
      "osc7\tiTerm2\txterm\t84566\n",
      "osc7\tiTerm2\txterm\t84566\tyes\n",
      "\t\t\t\n",
    ]) {
      expect(parseTmuxClient(out)).toEqual({
        kind: "failed",
        reason: `tmux answered ${JSON.stringify(out)}, not the five fields asked for`,
      });
    }
  });
});

describe("descendsFromRemoteLogin", () => {
  // `ps -A -o pid=,ppid=,comm=` on macOS, as measured: a tmux client attached
  // from a local iTerm2 window, and one attached over ssh.
  const TABLE = [
    "    1     0 /sbin/launchd",
    "65557     1 /Applications/iTerm.app/Contents/MacOS/iTerm2",
    "65560 65557 /Users/bmf/Library/Application Support/iTerm2/iTermServer-3.7.2",
    "65625 65560 /usr/bin/login",
    "65708 65625 -zsh",
    "84566 65708 tmux",
    "44818     1 sshd-session: bmf [priv]",
    "44821 44818 sshd-session: bmf@ttys000",
    "44822 44821 -zsh",
    "45022 44822 tmux",
    // mosh-server detaches from the sshd that started it.
    "50002     1 /usr/bin/mosh-server",
    "50003 50002 tmux",
  ].join("\n");

  test("a client under sshd, sshd-session or mosh-server came over a remote login", () => {
    expect(descendsFromRemoteLogin(TABLE, 45022)).toEqual({ kind: "ok", value: true });
    expect(descendsFromRemoteLogin(TABLE, 50003)).toEqual({ kind: "ok", value: true });
  });

  test("a client under a local terminal did not", () => {
    expect(descendsFromRemoteLogin(TABLE, 84566)).toEqual({ kind: "ok", value: false });
  });

  test("a pid the table does not hold is a failure, never local", () => {
    expect(descendsFromRemoteLogin(TABLE, 999)).toEqual({
      kind: "failed",
      reason: "process 999 is not running",
    });
  });
});

describe("the font edge's readers", () => {
  test("fcMatchCoverage: the family fontconfig matched, and the glyphs its ranges miss", () => {
    expect(fcMatchCoverage("Hack Nerd Font\t20-7e a0-17f e0b0-e0b3\n", GLYPHS)).toEqual({
      kind: "ok",
      value: { font: "Hack Nerd Font", lacks: [] },
    });
    expect(fcMatchCoverage("DejaVu Sans Mono\t20-7e e0b0\n", GLYPHS)).toEqual({
      kind: "ok",
      value: { font: "DejaVu Sans Mono", lacks: [[...GLYPHS][1]] },
    });
  });

  test("fcMatchCoverage: a glyph a fallback font covers is drawn, the font is still the first", () => {
    expect(
      fcMatchCoverage("DejaVu Sans Mono\t20-7e\nSymbols Nerd Font Mono\te0a0-e0d4\n", GLYPHS),
    ).toEqual({ kind: "ok", value: { font: "DejaVu Sans Mono", lacks: [] } });
  });

  test("fcMatchCoverage: anything but families and their charsets is a failure naming it", () => {
    for (const out of ["", "no tab here\n", "\t20-7e\n", "A\t20-7e\nno tab\n"]) {
      expect(fcMatchCoverage(out, GLYPHS)).toEqual({
        kind: "failed",
        reason: `fc-match answered ${JSON.stringify(out)}, not families and their charsets`,
      });
    }
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
  const ORIGIN: RenderOrigin = {
    projectDir: "/tmp/proj",
    cwd: "/tmp/proj",
    target: { source: "search" },
  };
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

  const LOCAL: Asked<boolean> = { kind: "ok", value: false };
  const edge = (
    client: DoctorEdge["probeTmux"],
    config: DslConfig = DEFAULT_DSL_CONFIG,
    remote: Asked<boolean> = LOCAL,
  ) => {
    const asked: unknown[][] = [];
    const pids: number[] = [];
    const e: DoctorEdge = {
      install: HEALTHY_INSTALL_EDGE,
      ...healthyDaemonEdge(),
      ...healthyDataEdge(),
      ...noManagedSettings(),
      probeTmux: client,
      remoteLogin: (pid) => {
        pids.push(pid);
        return remote;
      },
      fontInUse: (...args) => {
        asked.push(args);
        return COVERED;
      },
      loadConfig: () => ({ layers: [], error: null, warning: null, unused: [], config }),
    };
    return { e, asked, pids };
  };
  const tmuxSays = (termtype: string): DoctorEdge["probeTmux"] => () => ({
    kind: "ok",
    value: { features: [], termtype, termname: "xterm-256color", pid: 4242, utf8: true },
  });
  const gathered = (
    e: DoctorEdge,
    hints: Partial<Pick<ClientHints, "tmux" | "terminalEnv" | "ssh">>,
    pick: (key: string) => string | null = () => null,
    stores: StoresRead = EMPTY_STORES,
  ) =>
    gatherFacts(
      e,
      { claudeConfigDir: conf, ...hints },
      ORIGIN,
      pick,
      { kind: "ok", value: HEALTHY_SERVING },
      CARRIED,
      NAMED,
      { kind: "recent" },
      sightedIn(ORIGIN.projectDir, conf, STILL),
      HEALTHY_FACTS.width,
      stores,
    );
  const drawn = (
    e: DoctorEdge,
    hints: Partial<Pick<ClientHints, "tmux" | "terminalEnv" | "ssh">>,
  ) => {
    const f = gathered(e, hints).nerdFont;
    if (f.kind !== "glyphs") throw new Error(`the bar drew no glyphs: ${JSON.stringify(f)}`);
    return f;
  };

  test("inside tmux, tmux's attached client names the terminal over the session's env", () => {
    const { e, asked, pids } = edge(tmuxSays("iTerm2 3.7.2"));
    const env = { TERM_PROGRAM: "tmux", ITERM_PROFILE: "Work", XDG_CONFIG_HOME: "/x" };
    // The session's ssh hint is the server's first window's, as stale as its
    // profile: the attached client's own process answers instead.
    expect(drawn(e, { tmux: HINT, ssh: true, terminalEnv: env })).toEqual({
      kind: "glyphs",
      glyphs: BUNDLED_GLYPHS,
      terminal: { kind: "configured", name: "iterm2", version: "3.7.2", font: COVERED },
    });
    // Inside tmux the session's ITERM_PROFILE names the window that started
    // the server, not the attached one, so the reader is handed none.
    expect(asked).toEqual([
      [{ name: "iterm2", version: "3.7.2" }, { TERM_PROGRAM: "tmux", XDG_CONFIG_HOME: "/x" }, BUNDLED_GLYPHS],
    ]);
    expect(pids).toEqual([4242]);
  });

  test("inside tmux, a client attached over a remote login reads no font on this machine", () => {
    const FAR =
      "the terminal is on the far side of a remote login, so its font is on the machine it runs on";
    const remote = edge(tmuxSays("iTerm2 3.7.4"), DEFAULT_DSL_CONFIG, { kind: "ok", value: true });
    expect(drawn(remote.e, { tmux: HINT, terminalEnv: {} }).terminal).toEqual({
      kind: "configured",
      name: "iterm2",
      version: "3.7.4",
      font: { kind: "failed", reason: FAR },
    });
    expect(remote.asked).toEqual([]);
    const unknowable = edge(tmuxSays("iTerm2 3.7.4"), DEFAULT_DSL_CONFIG, {
      kind: "failed",
      reason: "ps failed (rate-limited)",
    });
    expect(drawn(unknowable.e, { tmux: HINT, terminalEnv: {} }).terminal).toMatchObject({
      font: {
        kind: "failed",
        reason: "whether the terminal is remote could not be asked: ps failed (rate-limited)",
      },
    });
    expect(unknowable.asked).toEqual([]);
  });

  test("outside tmux, the font is read with the session's env as it is", () => {
    const { e, asked } = edge(() => {
      throw new Error("tmux must not be asked outside it");
    });
    const env = { TERM_PROGRAM: "iTerm.app", TERM_PROGRAM_VERSION: "3.7.2", ITERM_PROFILE: "Work" };
    drawn(e, { tmux: null, terminalEnv: env });
    expect(asked).toEqual([[{ name: "iterm2", version: "3.7.2" }, env, BUNDLED_GLYPHS]]);
  });

  test("outside tmux over ssh, no font on this machine is read: the terminal is on the other one", () => {
    const { e, asked, pids } = edge(() => {
      throw new Error("tmux must not be asked outside it");
    });
    expect(drawn(e, { tmux: null, ssh: true, terminalEnv: { TERM: "alacritty" } }).terminal).toEqual({
      kind: "configured",
      name: "alacritty",
      version: null,
      font: {
        kind: "failed",
        reason:
          "the terminal is on the far side of a remote login, so its font is on the machine it runs on",
      },
    });
    expect(asked).toEqual([]);
    expect(pids).toEqual([]);
  });

  test("a bundling terminal reads no font", () => {
    const { e, asked } = edge(tmuxSays("kitty(0.45.0)"));
    expect(drawn(e, { tmux: HINT, terminalEnv: {} }).terminal).toEqual({
      kind: "bundling",
      name: "kitty",
      version: "0.45.0",
    });
    expect(asked).toEqual([]);
  });

  test("a tmux that could not be asked is unasked; a client too old to report is unreported", () => {
    const { e, asked } = edge(() => ({ kind: "failed", reason: "no server" }));
    expect(drawn(e, { tmux: HINT, terminalEnv: {} }).terminal).toEqual({
      kind: "unasked",
      reason: "no server",
    });
    expect(drawn(e, { tmux: null }).terminal).toEqual({ kind: "unreported" });
    expect(drawn(e, {}).terminal).toEqual({ kind: "unreported" });
    expect(asked).toEqual([]);
  });

  test("outside tmux, the session's env names the terminal", () => {
    const { e } = edge(() => {
      throw new Error("tmux must not be asked outside it");
    });
    expect(drawn(e, { tmux: null, terminalEnv: { TERM: "xterm-kitty" } }).terminal).toEqual({
      kind: "bundling",
      name: "kitty",
      version: null,
    });
  });

  test("the glyphs are the ones the session's bar draws", () => {
    const { e } = edge(tmuxSays("ghostty 1.3.1"));
    expect(drawn(e, { tmux: HINT, terminalEnv: {} }).glyphs).toBe(BUNDLED_GLYPHS);
  });

  test("a private-use glyph the config writes is drawn as surely as a cap", () => {
    const icon: DslConfig = {
      ...DEFAULT_DSL_CONFIG,
      segments: {
        ...DEFAULT_DSL_CONFIG.segments,
        branchIcon: { template: "\uf418 {{ .git.branch }}" },
      },
    };
    const { e } = edge(tmuxSays("ghostty 1.3.1"), icon);
    expect(new Set(drawn(e, { tmux: HINT, terminalEnv: {} }).glyphs)).toEqual(
      new Set(`${BUNDLED_GLYPHS}\uf418`),
    );
  });

  test("a pane whose session no client is attached to names no terminal", () => {
    const { e, asked, pids } = edge(() => ({ kind: "ok", value: null }));
    expect(drawn(e, { tmux: HINT, terminalEnv: {} }).terminal).toEqual({
      kind: "unasked",
      reason: "tmux has no client attached to the pane's session",
    });
    expect([asked, pids]).toEqual([[], []]);
  });

  test("a bar that draws none asks nothing of tmux's terminal or its font", () => {
    // plain joiners with an ASCII separator, and the effort gauge written
    // without its Nerd icons: its ladder and the helper that draws max's
    // bubble caps.
    const ascii: DslConfig = {
      ...DEFAULT_DSL_CONFIG,
      globals: { ...DEFAULT_DSL_CONFIG.globals, endcaps: "plain", default_separator: " | " },
      variables: {
        ...DEFAULT_DSL_CONFIG.variables,
        "effort.glyphs": { kind: "literal", value: "? ^ ^ ^^ ^^^" },
      },
      helpers: {
        ...DEFAULT_DSL_CONFIG.helpers,
        effortGauge: "{{ .effort.level }}",
      },
    };
    const { e, asked } = edge(tmuxSays("iTerm2 3.7.2"), ascii);
    expect(gathered(e, { tmux: HINT, terminalEnv: {} }).nerdFont).toEqual({ kind: "none" });
    expect(asked).toEqual([]);
  });

  test("the marks are the mark book's, whichever session made them", () => {
    const book = withMark({}, "nerdFont", "Ghostty 1.3.1|U+E0B0 U+E0B2", "drawn");
    const { e } = edge(tmuxSays("ghostty 1.3.1"));
    const marks = { kind: "ok", value: book } as const;
    expect(gathered(e, { tmux: HINT }, undefined, { ...EMPTY_STORES, marks }).marks).toEqual(marks);
  });
});

describe("iTerm2's profiles, as the doctor reads them", () => {
  const profile = (over: Partial<ItermProfile> = {}): ItermProfile => ({
    name: "Default",
    font: "Menlo-Regular",
    nonAscii: false,
    powerline: false,
    lacks: [...GLYPHS],
    ...over,
  });

  test("a named profile is the one read, its non-ASCII font named as such", () => {
    expect(itermFontInUse([profile({ nonAscii: true, lacks: [] })], "Default", "3.7.2")).toEqual({
      kind: "ok",
      value: { font: "Menlo-Regular", from: 'iTerm2 profile "Default", its non-ASCII font', lacks: [] },
    });
  });

  test("built-in Powerline glyphs take what iTerm2 draws itself off what the font lacks", () => {
    expect(itermFontInUse([profile({ powerline: true })], "Default", "3.7.2")).toEqual({
      kind: "ok",
      value: {
        font: "Menlo-Regular",
        from: 'iTerm2 profile "Default", built-in Powerline glyphs on',
        lacks: [],
      },
    });
    // A release before the verified set, or an unsaid one, counts on none.
    for (const version of ["3.4.20", null]) {
      expect(itermFontInUse([profile({ powerline: true })], "Default", version)).toEqual({
        kind: "ok",
        value: {
          font: "Menlo-Regular",
          from: 'iTerm2 profile "Default", built-in Powerline glyphs on',
          lacks: [...GLYPHS],
        },
      });
    }
  });

  test("with no profile named, the first that falls short is the answer", () => {
    const covered = profile({ name: "Nerd", font: "JetBrainsMonoNF-Regular", lacks: [] });
    expect(itermFontInUse([covered, profile({ name: "Plain" })], null, "3.7.2")).toEqual({
      kind: "ok",
      value: {
        font: "Menlo-Regular",
        from: 'iTerm2 profile "Plain", one of its profiles, and the session does not say which draws the bar',
        lacks: [...GLYPHS],
      },
    });
  });

  test("with no profile named, every profile drawing the glyphs is the answer", () => {
    const a = profile({ name: "A", font: "JetBrainsMonoNF-Regular", lacks: [] });
    const b = profile({ name: "B", font: "JetBrainsMonoNF-Regular", lacks: [] });
    const c = profile({ name: "C", powerline: true });
    expect(itermFontInUse([a, b, c], null, "3.7.2")).toEqual({
      kind: "ok",
      value: {
        font: "JetBrainsMonoNF-Regular, Menlo-Regular",
        from: "every iTerm2 profile, since the session does not say which draws the bar",
        lacks: [],
      },
    });
  });

  test("a profile that is not there, or names no font, is a failure saying so", () => {
    expect(itermFontInUse([], "Nope", "3.7.2")).toEqual({
      kind: "failed",
      reason: 'iTerm2 has no profile named "Nope"',
    });
    expect(itermFontInUse([], null, "3.7.2")).toEqual({
      kind: "failed",
      reason: "iTerm2 has no profiles in its preferences",
    });
    expect(itermFontInUse([profile({ font: null, lacks: null })], null, "3.7.2")).toEqual({
      kind: "failed",
      reason: 'iTerm2 profile "Default" names no font',
    });
  });

  test("the glyphs iTerm2 draws itself, by release", () => {
    const at = (point: number) => String.fromCodePoint(point);
    expect(itermDrawsItself("3.5.0", at(0xe0b0))).toBe(true);
    expect(itermDrawsItself("3.5.0", at(0xe0d2))).toBe(true);
    expect(itermDrawsItself("3.5.0", at(0xe0d3))).toBe(false);
    expect(itermDrawsItself("3.5.0", at(0xe0d6))).toBe(false);
    expect(itermDrawsItself("3.5.6", at(0xe0d6))).toBe(true);
    expect(itermDrawsItself("3.6.0", at(0xe0d5))).toBe(false);
    expect(itermDrawsItself("3.4.20", at(0xe0b0))).toBe(false);
    expect(itermDrawsItself(null, at(0xe0b0))).toBe(false);
  });
});

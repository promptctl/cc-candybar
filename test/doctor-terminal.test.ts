// brandon-doctor-v62x.2ww: which terminal draws the bar, read from tmux's word
// on its attached client or from the session's own environment.

import {
  identifyFromEnv,
  identifyInTmux,
  releasedSince,
} from "../src/doctor/terminal";

describe("identifyInTmux", () => {
  // The XTVERSION replies as each terminal gives them (iTerm2 and Ghostty
  // read off this machine; kitty's parenthesised form is its own).
  test.each([
    ["iTerm2 3.7.2", "xterm-256color", "iterm2", "3.7.2"],
    ["kitty(0.45.0)", "xterm-kitty", "kitty", "0.45.0"],
    ["ghostty 1.3.1", "xterm-ghostty", "ghostty", "1.3.1"],
    ["WezTerm 20240203-110809-5046fc22", "xterm-256color", "wezterm", "20240203-110809-5046fc22"],
  ])("%s names %s", (termtype, termname, name, version) => {
    expect(identifyInTmux({ termtype, termname })).toEqual({
      kind: "known",
      terminal: { name, version },
    });
  });

  test("a terminal that does not answer XTVERSION is named by its TERM, release unsaid", () => {
    expect(identifyInTmux({ termtype: "", termname: "xterm-kitty" })).toEqual({
      kind: "known",
      terminal: { name: "kitty", version: null },
    });
    expect(identifyInTmux({ termtype: "", termname: "alacritty" })).toEqual({
      kind: "known",
      terminal: { name: "alacritty", version: null },
    });
  });

  test("a terminal the doctor has no reading for keeps the name it went by", () => {
    expect(
      identifyInTmux({ termtype: "Apple_Terminal 455", termname: "xterm-256color" }),
    ).toEqual({ kind: "unknown", called: "Apple_Terminal 455" });
    expect(identifyInTmux({ termtype: "", termname: "xterm-256color" })).toEqual({
      kind: "unknown",
      called: "xterm-256color",
    });
  });
});

describe("identifyFromEnv", () => {
  test("TERM_PROGRAM names the terminal, TERM_PROGRAM_VERSION its release", () => {
    expect(
      identifyFromEnv({ TERM_PROGRAM: "iTerm.app", TERM_PROGRAM_VERSION: "3.7.2" }),
    ).toEqual({ kind: "known", terminal: { name: "iterm2", version: "3.7.2" } });
    expect(identifyFromEnv({ TERM_PROGRAM: "WezTerm" })).toEqual({
      kind: "known",
      terminal: { name: "wezterm", version: null },
    });
  });

  test("a terminal that sets no TERM_PROGRAM is named by its TERM", () => {
    expect(identifyFromEnv({ TERM: "xterm-kitty" })).toEqual({
      kind: "known",
      terminal: { name: "kitty", version: null },
    });
  });

  test("Apple's Terminal and VS Code are named by TERM_PROGRAM alone", () => {
    expect(
      identifyFromEnv({ TERM_PROGRAM: "Apple_Terminal", TERM_PROGRAM_VERSION: "455.1", TERM: "xterm-256color" }),
    ).toEqual({ kind: "known", terminal: { name: "apple-terminal", version: "455.1" } });
  });

  // Cursor and Windsurf set TERM_PROGRAM=vscode with their own release beside
  // it, so the release says nothing about VS Code's.
  test("VS Code is named by TERM_PROGRAM, and its release is never read from TERM_PROGRAM_VERSION", () => {
    expect(
      identifyFromEnv({ TERM_PROGRAM: "vscode", TERM_PROGRAM_VERSION: "0.45.11" }),
    ).toEqual({ kind: "known", terminal: { name: "vscode", version: null } });
  });

  test("anything else is unknown, under the name it went by", () => {
    expect(identifyFromEnv({ TERM_PROGRAM: "Hyper", TERM: "xterm-256color" })).toEqual({
      kind: "unknown",
      called: "Hyper",
    });
    expect(identifyFromEnv({})).toEqual({ kind: "unknown", called: "" });
  });
});

describe("releasedSince", () => {
  test.each([
    ["0.45.0", "0.36.0", true],
    ["0.36.0", "0.36.0", true],
    ["0.35.2", "0.36.0", false],
    ["0.36", "0.36.0", true],
    ["20240203-110809-5046fc22", "20220319", true],
    ["20220101-000000-abc", "20220319", false],
    ["nightly", "0.36.0", null],
  ])("%s since %s → %p", (version, since, expected) => {
    expect(releasedSince(version, since)).toBe(expected);
  });
});

// [LAW:verifiable-goals] brandon-doctor-v62x.ryu: "links are available and
// clickable" — the terminal drawing the bar draws OSC 8 links, and inside
// tmux, tmux passes them through. Pure over fixture facts.

import {
  checkByName,
  type TerminalIdentity,
  type TmuxClient,
} from "../src/doctor/checks";
import type { Identified, TerminalName } from "../src/doctor/terminal";
import { linkFields } from "../src/doctor/report";
import { HEALTHY_FACTS } from "./helpers/doctor-facts";

const probe = checkByName("links")!.probe;

const known = (name: TerminalName, version: string | null): Identified => ({
  kind: "known",
  terminal: { name, version },
});

const client = (features: readonly string[]): TmuxClient => ({
  features,
  termtype: "",
  termname: "xterm-256color",
  pid: 4242,
});

const seen = (
  identified: Identified,
  tmuxClient: TmuxClient | null = null,
): TerminalIdentity => ({ kind: "seen", identified, tmuxClient });

const verdict = (
  terminal: TerminalIdentity,
  askedBy: "click" | "command" = "command",
) => probe({ ...HEALTHY_FACTS, terminal, askedBy });

const TMUX_LINE =
  'tmux does not pass links through to iTerm2 — add `set -as terminal-features ",xterm-256color:hyperlinks"` to tmux.conf, then detach and reattach (tmux 3.4 or later)';

describe("links probe", () => {
  // The bar's 🩺 doctor is itself a link: the click that ran it was drawn and
  // clicked, whatever the facts would have guessed.
  test("a run a click asked for is ok, even where the facts say no links", () => {
    const noLinks = seen(known("apple-terminal", "455.1"), client(["RGB"]));
    expect(verdict(noLinks, "click")).toEqual({ ok: true });
    expect(verdict(noLinks).ok).toBe(false);
  });

  test.each([
    ["ghostty", null],
    ["wezterm", "20240203-110809-5046fc22"],
    ["iterm2", "3.7.2"],
    ["kitty", "0.19.0"],
    ["alacritty", "0.13.2"],
    ["vscode", "1.95.3"],
  ] as const)("%s %s outside tmux → ok", (name, version) => {
    expect(verdict(seen(known(name, version)))).toEqual({ ok: true });
  });

  test("Apple's Terminal draws none, and the reason names terminals that do", () => {
    expect(verdict(seen(known("apple-terminal", "455.1")))).toEqual({
      ok: false,
      reason:
        "Terminal draws no links (OSC 8), so nothing on the bar can be clicked — run Claude Code in a terminal that draws them: kitty, WezTerm, Ghostty, iTerm2, Alacritty, VS Code",
      more: [],
    });
  });

  test("a release before links came in says to update", () => {
    expect(verdict(seen(known("kitty", "0.18.3")))).toEqual({
      ok: false,
      reason: "kitty 0.18.3 draws no links (OSC 8 came in 0.19.0) — update kitty",
      more: [],
    });
  });

  test("an unsaid release of a terminal that gained links fails, saying so", () => {
    expect(verdict(seen(known("iterm2", null)))).toEqual({
      ok: false,
      reason: "iTerm2 draws links (OSC 8) since 3.1, and did not say which release this is",
      more: [],
    });
  });

  test("an unknown terminal fails, pointing at the bar's doctor as the proof", () => {
    const v = verdict(seen({ kind: "unknown", called: "Hyper" }));
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.reason).toBe(
      "the doctor does not know whether Hyper draws links (OSC 8) — the 🩺 doctor in the bar's settings menu is one: if clicking it runs the doctor, they work",
    );
    const nameless = verdict(seen({ kind: "unknown", called: "" }));
    expect(!nameless.ok && nameless.reason).toMatch(/^the doctor does not know whether this terminal draws/);
  });

  test("inside tmux with hyperlinks → ok", () => {
    expect(verdict(seen(known("iterm2", "3.7.2"), client(["RGB", "hyperlinks"])))).toEqual({ ok: true });
  });

  test("inside tmux without hyperlinks: the reason is the terminal-features line to add", () => {
    expect(verdict(seen(known("iterm2", "3.7.2"), client(["RGB"])))).toEqual({
      ok: false,
      reason: TMUX_LINE,
      more: [],
    });
  });

  test("both halves broken: tmux first, then the terminal", () => {
    expect(verdict(seen(known("iterm2", "3.0.15"), client([])))).toEqual({
      ok: false,
      reason: TMUX_LINE,
      more: ["iTerm2 3.0.15 draws no links (OSC 8 came in 3.1) — update iTerm2"],
    });
  });

  test("the doctor event's tmuxLinks says whether tmux writes OSC 8 to the client, `-` where there is none", () => {
    expect(linkFields(seen(known("iterm2", "3.7.2"), client(["hyperlinks"])))).toBe("tmuxLinks=yes");
    expect(linkFields(seen(known("iterm2", "3.7.2"), client(["RGB"])))).toBe("tmuxLinks=no");
    expect(linkFields(seen(known("iterm2", "3.7.2")))).toBe("tmuxLinks=-");
    expect(linkFields({ kind: "unasked", reason: "x" })).toBe("tmuxLinks=-");
  });

  test("no terminal reported, or tmux could not be asked: fails naming why", () => {
    expect(verdict({ kind: "unreported" })).toEqual({
      ok: false,
      reason: "the client reported no terminal — re-run `cc-candybar install` to stage a current client",
    });
    expect(verdict({ kind: "unasked", reason: "no server running on /s" })).toEqual({
      ok: false,
      reason: "tmux could not be asked which terminal is attached: no server running on /s",
    });
  });
});

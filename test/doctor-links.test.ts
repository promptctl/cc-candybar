// [LAW:verifiable-goals] brandon-doctor-v62x.ryu: "links are available and
// clickable" — the terminal drawing the bar draws OSC 8 links, and inside
// tmux, tmux passes them through. Pure over fixture facts.

import {
  checkByName,
  type Asked,
  type MarkBook,
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

const NO_MARKS: Asked<MarkBook> = { kind: "ok", value: {} };
const clickedIn = (...sightings: string[]): Asked<MarkBook> => ({
  kind: "ok",
  value: { links: Object.fromEntries(sightings.map((s) => [s, "clicked"])) },
});

const verdict = (
  terminal: TerminalIdentity,
  askedBy: "click" | "command" = "command",
  marks: Asked<MarkBook> = NO_MARKS,
) => probe({ ...HEALTHY_FACTS, terminal, askedBy, marks });

const PROVE =
  "click 🩺 doctor in the bar's settings menu: if it runs, links work, and the doctor remembers it for this terminal";
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

  // kitty and Alacritty name themselves only in TERM, which carries no release.
  test("an unsaid release fails, pointing at the bar's doctor as the proof", () => {
    expect(verdict(seen(known("kitty", null)))).toEqual({
      ok: false,
      reason: `kitty draws links (OSC 8) since 0.19.0, and did not say which release this is — ${PROVE}`,
      more: [],
    });
  });

  test("an unknown terminal fails, pointing at the bar's doctor as the proof", () => {
    expect(verdict(seen({ kind: "unknown", called: "Hyper" }))).toEqual({
      ok: false,
      reason: `the doctor does not know whether Hyper draws links (OSC 8) — ${PROVE}`,
      more: [],
    });
    const nameless = verdict(seen({ kind: "unknown", called: "" }));
    expect(!nameless.ok && nameless.reason).toMatch(/^the doctor does not know whether this terminal draws/);
  });

  // A doctor click that came back from a terminal is a link it drew and the
  // user clicked: the command reads that from the mark book.
  test("a click remembered for the terminal settles what its facts cannot", () => {
    expect(verdict(seen(known("kitty", null)), "command", clickedIn("kitty"))).toEqual({ ok: true });
    expect(verdict(seen({ kind: "unknown", called: "Hyper" }), "command", clickedIn("Hyper"))).toEqual({
      ok: true,
    });
    // Remembered for one terminal, it answers for no other.
    expect(verdict(seen(known("kitty", null)), "command", clickedIn("Alacritty")).ok).toBe(false);
  });

  test("a remembered click does not speak for tmux, which says for itself", () => {
    expect(verdict(seen(known("iterm2", null), client(["RGB"])), "command", clickedIn("iTerm2"))).toEqual({
      ok: false,
      reason: TMUX_LINE,
      more: [],
    });
  });

  test("a mark book that cannot be read is named where a click would have settled it", () => {
    const unread: Asked<MarkBook> = { kind: "failed", reason: "/m.json is not JSON" };
    expect(verdict(seen(known("kitty", null)), "command", unread)).toEqual({
      ok: false,
      reason: `kitty draws links (OSC 8) since 0.19.0, and did not say which release this is — ${PROVE}`,
      more: ["the mark book could not be read: /m.json is not JSON"],
    });
    expect(verdict(seen(known("iterm2", "3.7.2")), "command", unread)).toEqual({ ok: true });
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

  test("both halves broken: the terminal first, then tmux", () => {
    expect(verdict(seen(known("iterm2", "3.0.15"), client([])))).toEqual({
      ok: false,
      reason: "iTerm2 3.0.15 draws no links (OSC 8 came in 3.1) — update iTerm2",
      more: [TMUX_LINE],
    });
  });

  // tmux passing links through helps only a terminal that draws them.
  test("a terminal that draws none gets no tmux line", () => {
    expect(verdict(seen(known("apple-terminal", "455.1"), client(["RGB"])))).toEqual({
      ok: false,
      reason:
        "Terminal draws no links (OSC 8), so nothing on the bar can be clicked — run Claude Code in a terminal that draws them: kitty, WezTerm, Ghostty, iTerm2, Alacritty, VS Code",
      more: [],
    });
  });

  test("the doctor event says whether tmux writes OSC 8 to the client, and the links mark on the terminal", () => {
    expect(linkFields(seen(known("iterm2", "3.7.2"), client(["hyperlinks"])), NO_MARKS)).toBe(
      "tmuxLinks=yes linkMark=-",
    );
    expect(linkFields(seen(known("iterm2", "3.7.2"), client(["RGB"])), clickedIn("iTerm2"))).toBe(
      "tmuxLinks=no linkMark=clicked",
    );
    expect(linkFields(seen(known("iterm2", "3.7.2")), { kind: "failed", reason: "x" })).toBe(
      "tmuxLinks=- linkMark=unread",
    );
    expect(linkFields(seen({ kind: "unknown", called: "" }), clickedIn(""))).toBe("tmuxLinks=- linkMark=-");
    expect(linkFields({ kind: "unasked", reason: "x" }, NO_MARKS)).toBe("tmuxLinks=- linkMark=-");
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

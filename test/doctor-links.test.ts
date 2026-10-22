// [LAW:verifiable-goals] brandon-doctor-v62x.ryu: "links are available and
// clickable" — the terminal drawing the bar draws OSC 8 links, and inside
// tmux, tmux passes them through. Pure over fixture facts.

import {
  checkByName,
  type Asked,
  type TerminalIdentity,
  type TmuxClient,
} from "../src/doctor/checks";
import type { Identified, TerminalName } from "../src/doctor/terminal";
import { linkFields } from "../src/doctor/report";
import { parseClickedTerminals, withClicked } from "../src/doctor/clicked-terminals";
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
      utf8: true,
});

const seen = (
  identified: Identified,
  tmuxClient: TmuxClient | null = null,
): TerminalIdentity => ({ kind: "seen", identified, tmuxClient });

const clickedIn = (...sightings: string[]): Asked<readonly string[]> => ({ kind: "ok", value: sightings });
const UNREAD: Asked<readonly string[]> = { kind: "failed", reason: "/c.json is not JSON" };

const verdict = (
  terminal: TerminalIdentity,
  askedBy: "click" | "command" = "command",
  clicked: Asked<readonly string[]> = clickedIn(),
) =>
  probe({
    ...HEALTHY_FACTS,
    terminal,
    sighted:
      askedBy === "click"
        ? { kind: "clicked", sessionId: "s1", via: "link" }
        : { kind: "recent" },
    clicked,
  });

const PROVE =
  "click 🩺 doctor in the bar's settings menu: if it runs, links work, and the doctor remembers it for this terminal";
const NO_LINKS =
  "Terminal draws no links (OSC 8), so nothing on the bar can be clicked — run Claude Code in a terminal that draws them: kitty, WezTerm, Ghostty, iTerm2, Alacritty, VS Code";
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
  ] as const)("%s %s outside tmux → ok", (name, version) => {
    expect(verdict(seen(known(name, version)))).toEqual({ ok: true });
  });

  test("Apple's Terminal draws none, and the reason names terminals that do", () => {
    expect(verdict(seen(known("apple-terminal", "455.1")))).toEqual({ ok: false, reason: NO_LINKS, more: [] });
  });

  test("a release before links came in says to update", () => {
    expect(verdict(seen(known("kitty", "0.18.3")))).toEqual({
      ok: false,
      reason: "kitty 0.18.3 draws no links (OSC 8 came in 0.19.0) — update kitty",
      more: [],
    });
  });

  // kitty and Alacritty name themselves only in TERM, and VS Code's release is
  // never read: none of them says which release it is.
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
  });

  // A doctor click that came back from a terminal is a link it drew and the
  // user clicked: the command reads that from the terminals clicked from.
  test("a click remembered for the terminal settles what its facts cannot", () => {
    expect(verdict(seen(known("kitty", null)), "command", clickedIn("kitty"))).toEqual({ ok: true });
    expect(verdict(seen({ kind: "unknown", called: "Hyper" }), "command", clickedIn("Hyper"))).toEqual({
      ok: true,
    });
    // Remembered for one terminal, it answers for no other.
    expect(verdict(seen(known("kitty", null)), "command", clickedIn("Alacritty")).ok).toBe(false);
  });

  // Apple's Terminal inside tmux answers no XTVERSION: its TERM is all that is
  // said of it, and a click is remembered under that TERM.
  test("a terminal nothing names but its TERM is settled by a click remembered under it", () => {
    const xterm = seen({ kind: "unnamed", term: "xterm-256color" });
    expect(verdict(xterm)).toEqual({
      ok: false,
      reason: `the doctor does not know whether xterm-256color draws links (OSC 8) — ${PROVE}`,
      more: [],
    });
    expect(verdict(xterm, "command", clickedIn("xterm-256color"))).toEqual({ ok: true });
  });

  test("a terminal nothing names at all promises no remembering", () => {
    expect(verdict(seen({ kind: "unnamed", term: "" }))).toEqual({
      ok: false,
      reason:
        "the doctor does not know whether this terminal draws links (OSC 8) — click 🩺 doctor in the bar's settings menu: if it runs, links work",
      more: [],
    });
  });

  test("a remembered click does not speak for tmux, which says for itself", () => {
    expect(verdict(seen(known("iterm2", null), client(["RGB"])), "command", clickedIn("iTerm2"))).toEqual({
      ok: false,
      reason: TMUX_LINE,
      more: [],
    });
  });

  // A remembered click overturns any verdict but ok.
  test("a clicked-terminals list that cannot be read is named beside every failing verdict", () => {
    const unread = "the terminals a doctor click came back from could not be read: /c.json is not JSON";
    expect(verdict(seen(known("kitty", null)), "command", UNREAD)).toEqual({
      ok: false,
      reason: `kitty draws links (OSC 8) since 0.19.0, and did not say which release this is — ${PROVE}`,
      more: [unread],
    });
    expect(verdict(seen(known("apple-terminal", "455.1")), "command", UNREAD)).toEqual({
      ok: false,
      reason: NO_LINKS,
      more: [unread],
    });
    expect(verdict(seen(known("iterm2", "3.7.2")), "command", UNREAD)).toEqual({ ok: true });
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
      reason: NO_LINKS,
      more: [],
    });
  });

  test("the doctor event says whether tmux writes OSC 8 to the client, and whether a click came back from the terminal", () => {
    expect(linkFields(seen(known("iterm2", "3.7.2"), client(["hyperlinks"])), clickedIn())).toBe(
      "tmuxLinks=yes clicked=no",
    );
    expect(linkFields(seen(known("iterm2", "3.7.2"), client(["RGB"])), clickedIn("iTerm2"))).toBe(
      "tmuxLinks=no clicked=yes",
    );
    expect(linkFields(seen(known("iterm2", "3.7.2")), UNREAD)).toBe("tmuxLinks=- clicked=unread");
    expect(linkFields(seen({ kind: "unnamed", term: "" }), clickedIn(""))).toBe("tmuxLinks=- clicked=-");
    expect(linkFields({ kind: "unasked", reason: "x" }, clickedIn())).toBe("tmuxLinks=- clicked=-");
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

describe("the terminals a doctor click came back from", () => {
  test("the document reads as a list of terminals, or fails saying so", () => {
    expect(parseClickedTerminals(["kitty", "Hyper"])).toEqual({ kind: "ok", value: ["kitty", "Hyper"] });
    expect(parseClickedTerminals({ kitty: 1 })).toEqual({ kind: "failed", reason: "is not a list of terminals" });
    expect(parseClickedTerminals([1])).toEqual({ kind: "failed", reason: "is not a list of terminals" });
  });

  test("a terminal is filed once: filing one already filed is the same list, so nothing is written", () => {
    const clicked = withClicked([], "kitty");
    expect(clicked).toEqual(["kitty"]);
    expect(withClicked(clicked, "kitty")).toBe(clicked);
    expect(withClicked(clicked, "Hyper")).toEqual(["kitty", "Hyper"]);
  });
});

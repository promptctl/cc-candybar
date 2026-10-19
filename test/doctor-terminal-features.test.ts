// brandon-doctor-v62x.1ku: the doctor's UTF-8 and terminal-width rows, read
// off the probes over fixture facts, and the event fields that carry what
// they reasoned over.

import {
  checkByName,
  type TerminalIdentity,
  type TmuxClient,
  type TmuxFacts,
} from "../src/doctor/checks";
import { terminalFeatureFields } from "../src/doctor/report";
import { DEFAULT_TERMINAL_WIDTH } from "../src/render/strip";
import { HEALTHY_FACTS } from "./helpers/doctor-facts";

const HINT = { socket: "/tmp/tmux-501/default", pane: "%3", truecolor: null };

const client = (utf8: boolean): TmuxClient => ({
  features: ["RGB"],
  termtype: "",
  termname: "xterm-256color",
  pid: 4242,
  utf8,
});

const inside = (
  asked: Extract<TmuxFacts, { kind: "inside" }>["client"],
): TmuxFacts => ({
  kind: "inside",
  hint: HINT,
  client: asked,
});

describe("utf8 probe", () => {
  const probe = checkByName("utf8")!.probe;
  const run = (tmux: TmuxFacts) => probe({ ...HEALTHY_FACTS, tmux });

  test("a client tmux writes UTF-8 to is ok", () => {
    expect(run(inside({ kind: "ok", value: client(true) }))).toEqual({
      ok: true,
    });
  });

  test("a client tmux writes no UTF-8 to fails, naming the `_` and the way out", () => {
    expect(run(inside({ kind: "ok", value: client(false) }))).toEqual({
      ok: false,
      reason:
        "tmux draws this terminal without UTF-8, so every glyph on the bar arrives as `_` — attach with `tmux -u`, or set a UTF-8 LC_ALL/LC_CTYPE/LANG in the shell that runs tmux",
    });
  });

  // Nothing re-encodes the bar outside tmux, and with no client attached tmux
  // draws it nowhere.
  test("outside tmux, or with no client attached, is ok", () => {
    expect(run({ kind: "outside" })).toEqual({ ok: true });
    expect(run(inside({ kind: "ok", value: null }))).toEqual({ ok: true });
  });

  test("a tmux that could not be asked, or a client too old to say, fails", () => {
    expect(run(inside({ kind: "failed", reason: "no server" }))).toEqual({
      ok: false,
      reason: "tmux could not be asked: no server",
    });
    expect(run({ kind: "unreported" })).toMatchObject({ ok: false });
  });

  // [LAW:single-enforcer] The two tmux-client checks read the arms through
  // one helper, so they say the same thing about them.
  test("says what tmuxTruecolor says about every arm but the client's own", () => {
    const truecolor = checkByName("tmuxTruecolor")!.probe;
    for (const tmux of [
      { kind: "unreported" },
      { kind: "outside" },
      inside({ kind: "failed", reason: "x" }),
      inside({ kind: "ok", value: null }),
    ] as const) {
      expect(run(tmux)).toEqual(truecolor({ ...HEALTHY_FACTS, tmux }));
    }
  });
});

describe("termWidth probe", () => {
  const probe = checkByName("termWidth")!.probe;

  test("a client that measured its terminal is ok", () => {
    expect(probe({ ...HEALTHY_FACTS, termCols: 148 })).toEqual({ ok: true });
  });

  test("one that could not fails, naming the width the bar is laid out for", () => {
    expect(probe({ ...HEALTHY_FACTS, termCols: null })).toEqual({
      ok: false,
      reason: `no terminal width was measured (no COLUMNS, and no terminal to ask — or the daemon refused the width sent, which the bar's red strip names), so the bar is laid out as if the terminal were ${DEFAULT_TERMINAL_WIDTH} columns wide`,
    });
  });
});

describe("terminalFeatureFields", () => {
  const seen = (tmuxClient: TmuxClient | null): TerminalIdentity => ({
    kind: "seen",
    identified: { kind: "unnamed", term: "xterm-256color" },
    tmuxClient,
  });

  test("carries the measured columns and tmux's word on UTF-8", () => {
    expect(terminalFeatureFields(seen(client(true)), 148)).toBe(
      "cols=148 clientUtf8=yes",
    );
    expect(terminalFeatureFields(seen(client(false)), null)).toBe(
      "cols=- clientUtf8=no",
    );
  });

  test("`-` where no client was seen", () => {
    expect(terminalFeatureFields(seen(null), 80)).toBe("cols=80 clientUtf8=-");
    expect(terminalFeatureFields({ kind: "unasked", reason: "x" }, 80)).toBe(
      "cols=80 clientUtf8=-",
    );
    expect(terminalFeatureFields({ kind: "unreported" }, 80)).toBe(
      "cols=80 clientUtf8=-",
    );
  });
});

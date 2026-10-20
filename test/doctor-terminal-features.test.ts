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
import { parseWidthSightings } from "../src/doctor/daemon-answer";
import { widthOf } from "../src/doctor/cli";
import type { StatsSnapshot } from "../src/daemon/stats";
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

  test("a client that measured its terminal is ok, naming the width", () => {
    expect(
      probe({ ...HEALTHY_FACTS, termCols: { kind: "ok", value: 148 } }),
    ).toEqual({ ok: true, note: "148 columns" });
  });

  test("one that could not fails, naming the width the bar is laid out for", () => {
    expect(
      probe({ ...HEALTHY_FACTS, termCols: { kind: "ok", value: null } }),
    ).toEqual({
      ok: false,
      reason: `no terminal width was measured (no COLUMNS, and no terminal to ask — or the daemon refused the width sent, which the bar's red strip names), so the bar is laid out as if the terminal were ${DEFAULT_TERMINAL_WIDTH} columns wide`,
    });
  });

  // brandon-doctor-v62x.1z2: no render of the session says what its client
  // measured — the row says why rather than judging a width nobody reported.
  test("a width nobody reported fails with the reason it is unknown", () => {
    expect(
      probe({ ...HEALTHY_FACTS, termCols: { kind: "failed", reason: "why" } }),
    ).toEqual({ ok: false, reason: "why" });
  });
});

const cols = (value: number | null) => ({ kind: "ok", value }) as const;

describe("terminalFeatureFields", () => {
  const seen = (tmuxClient: TmuxClient | null): TerminalIdentity => ({
    kind: "seen",
    identified: { kind: "unnamed", term: "xterm-256color" },
    tmuxClient,
  });

  test("carries the measured columns and tmux's word on UTF-8", () => {
    expect(terminalFeatureFields(seen(client(true)), cols(148))).toBe(
      "cols=148 clientUtf8=yes",
    );
    expect(terminalFeatureFields(seen(client(false)), cols(null))).toBe(
      "cols=- clientUtf8=no",
    );
  });

  test("`failed` where no render of the session said a width", () => {
    expect(
      terminalFeatureFields(seen(null), { kind: "failed", reason: "x" }),
    ).toBe("cols=failed clientUtf8=-");
  });

  test("`-` where no client was seen", () => {
    expect(terminalFeatureFields(seen(null), cols(80))).toBe("cols=80 clientUtf8=-");
    expect(terminalFeatureFields({ kind: "unasked", reason: "x" }, cols(80))).toBe(
      "cols=80 clientUtf8=-",
    );
    expect(terminalFeatureFields({ kind: "unreported" }, cols(80))).toBe(
      "cols=80 clientUtf8=-",
    );
  });
});

// brandon-doctor-v62x.1z2: which width the command judges.
describe("widthOf", () => {
  const sightings = {
    kind: "ok",
    value: [
      { sessionId: "s1", role: "frames", termCols: 60 },
      { sessionId: "s1", role: "statusline", termCols: 148 },
      { sessionId: "s2", role: "statusline", termCols: null },
    ],
  } as const;

  test("outside a session, the command's own measurement", () => {
    expect(widthOf(undefined, sightings, 90)).toEqual({ kind: "ok", value: 90 });
    expect(widthOf("", sightings, null)).toEqual({ kind: "ok", value: null });
  });

  test("in a session, its statusline client's width, whatever the shell measured", () => {
    expect(widthOf("s1", sightings, 90)).toEqual({ kind: "ok", value: 148 });
    expect(widthOf("s2", sightings, 90)).toEqual({ kind: "ok", value: null });
  });

  test("in a session the daemon did not answer for, that failure", () => {
    expect(widthOf("s1", { kind: "failed", reason: "no daemon" }, 90)).toEqual({
      kind: "failed",
      reason: "no daemon",
    });
    expect(widthOf("s3", sightings, 90)).toMatchObject({ kind: "failed" });
  });
});

describe("parseWidthSightings", () => {
  const stats = (clients: unknown[]) =>
    ({ version: "9.9.9", clients }) as unknown as StatsSnapshot;

  test("reads whose each render was and the width it measured", () => {
    const value = [{ sessionId: "s1", role: "statusline", termCols: null }];
    expect(parseWidthSightings(stats(value))).toEqual({ kind: "ok", value });
  });

  test("a daemon from before widths are recorded fails, saying to restart it", () => {
    expect(
      parseWidthSightings(stats([{ role: "statusline", ago: 1 }])),
    ).toEqual({
      kind: "failed",
      reason: expect.stringMatching(
        /^the running daemon \(9\.9\.9\) reported its renders without whose they were or the width they measured — restart it on this build/,
      ),
    });
  });
});

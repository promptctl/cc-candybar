// [LAW:verifiable-goals] brandon-doctor-b6a acceptance 1: the tmux-truecolor
// probe over fixture facts yields each verdict the ticket names — pure, no
// mocks, because the probe is a function of a DoctorFacts record.

import {
  CHECKS,
  checkByName,
  runDoctor,
  TMUX_TRUECOLOR_VAR,
  type ConfigFacts,
  type DoctorFacts,
  type StatusLineFacts,
  type TmuxFacts,
} from "../src/doctor/checks";
import { detectTmuxHint } from "../src/tmux-hint";
import { HEALTHY_FACTS, drew } from "./helpers/doctor-facts";

const HINT = { socket: "/tmp/tmux-501/default", pane: "%3", truecolor: null };

const inside = (
  features: readonly string[],
  truecolor: string | null = null,
): TmuxFacts => ({
  kind: "inside",
  hint: { ...HINT, truecolor },
  client: { kind: "ok", value: { features, termtype: "", termname: "", pid: 4242, utf8: true } },
});

const LOADED: ConfigFacts = {
  kind: "loaded",
  layers: ["/p/.cc-candybar.json5"],
  warnings: [],
  unused: [],
};

const SETTINGS_PATH = "/home/u/.claude/settings.json";
const STILL = drew("still");

const facts = (
  tmux: TmuxFacts,
  env: Record<string, unknown> = {},
  config: ConfigFacts = LOADED,
  frames: DoctorFacts["frames"] = STILL,
  statusLine: StatusLineFacts = { kind: "present", refreshInterval: undefined },
): DoctorFacts => ({
  ...HEALTHY_FACTS,
  tmux,
  config,
  frames,
  claudeSettings: { path: SETTINGS_PATH, env, statusLine },
});

const probe = checkByName("tmuxTruecolor")!.probe;

describe("tmuxTruecolor probe", () => {
  test("not in tmux → ok", () => {
    expect(probe(facts({ kind: "outside" }))).toEqual({ ok: true });
  });

  test("tmux without RGB → ok (not applicable is not a failure)", () => {
    expect(probe(facts(inside(["256", "osc7"])))).toEqual({ ok: true });
  });

  test("tmux + RGB + var set in Claude Code's env → ok", () => {
    expect(probe(facts(inside(["RGB"], "1")))).toEqual({ ok: true });
  });

  test("tmux + RGB + unset + settings lacks it → failed WITH the fix", () => {
    const v = probe(facts(inside(["osc7", "RGB", "sixel"])));
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.fix).toEqual({
      kind: "claude-settings",
      path: ["env", TMUX_TRUECOLOR_VAR],
      value: "1",
    });
    expect(v.reason).toMatch(/256 colours/);
  });

  test("tmux + RGB + unset + settings has it → failed, restart, NO fix", () => {
    const v = probe(
      facts(inside(["RGB"]), { [TMUX_TRUECOLOR_VAR]: "1" }),
    );
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.fix).toBeUndefined();
    expect(v.reason).toMatch(/restart Claude Code/);
  });

  // The same truthiness Claude Code applies: an empty or non-string value in
  // settings.json is "not told", so the fix is still offered (and overwrites).
  test.each([[""], [0], [false], [null]])(
    "a settings value Claude Code would read as falsy (%p) still offers the fix",
    (staged) => {
      const v = probe(facts(inside(["RGB"]), { [TMUX_TRUECOLOR_VAR]: staged }));
      expect(v.ok).toBe(false);
      if (v.ok) return;
      expect(v.fix).toBeDefined();
    },
  );

  test("tmux query failed → failed with that reason, no fix", () => {
    const v = probe(
      facts({
        kind: "inside",
        hint: HINT,
        client: { kind: "failed", reason: "no server running" },
      }),
    );
    expect(v).toEqual({
      ok: false,
      reason: "tmux could not be asked: no server running",
    });
  });

  test("client reported no tmux facts → failed naming the stale client, no fix", () => {
    const v = probe(facts({ kind: "unreported" }));
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.fix).toBeUndefined();
    expect(v.reason).toMatch(/cc-candybar install/);
  });
});

describe("runDoctor", () => {
  test("is a fold over CHECKS, one report per check in list order", () => {
    const reports = runDoctor(facts({ kind: "outside" }));
    expect(reports.map((r) => r.check.name)).toEqual(CHECKS.map((c) => c.name));
    expect(reports.every((r) => r.verdict.ok)).toBe(true);
  });

  test("check names are identifiers (they splice into var and action names)", () => {
    for (const c of CHECKS) expect(c.name).toMatch(/^[A-Za-z][A-Za-z0-9]*$/);
  });

  test("checkByName refuses a name the list does not carry", () => {
    expect(checkByName("tmux-truecolor")).toBeUndefined();
  });
});

describe("detectTmuxHint (the client's tmux facts)", () => {
  test("in tmux iff TMUX and TMUX_PANE are both non-empty", () => {
    expect(detectTmuxHint({})).toBeNull();
    expect(detectTmuxHint({ TMUX: "/tmp/tmux-501/default,123,0" })).toBeNull();
    expect(detectTmuxHint({ TMUX_PANE: "%1" })).toBeNull();
    expect(detectTmuxHint({ TMUX: "", TMUX_PANE: "%1" })).toBeNull();
  });

  test("socket is TMUX up to its first comma; truecolor is the raw value or null", () => {
    expect(
      detectTmuxHint({ TMUX: "/tmp/tmux-501/default,123,0", TMUX_PANE: "%1" }),
    ).toEqual({ socket: "/tmp/tmux-501/default", pane: "%1", truecolor: null });
    expect(
      detectTmuxHint({
        TMUX: "/tmp/tmux-501/default,123,0",
        TMUX_PANE: "%1",
        CLAUDE_CODE_TMUX_TRUECOLOR: "1",
      }),
    ).toEqual({ socket: "/tmp/tmux-501/default", pane: "%1", truecolor: "1" });
  });

  test("an empty truecolor value is null — falsy to Claude Code's own test", () => {
    expect(
      detectTmuxHint({
        TMUX: "/s,1,0",
        TMUX_PANE: "%1",
        CLAUDE_CODE_TMUX_TRUECOLOR: "",
      })!.truecolor,
    ).toBeNull();
  });
});

// brandon-doctor-v62x.e91: "the config is correct" over fixture facts.
describe("config probe", () => {
  const config = (c: ConfigFacts) =>
    checkByName("config")!.probe(facts({ kind: "outside" }, {}, c));

  test("a config that loaded with nothing to say is ok — the bundled default included", () => {
    expect(config(LOADED)).toEqual({ ok: true });
    expect(config({ ...LOADED, layers: [] })).toEqual({ ok: true });
  });

  test("an advisory the load earned fails it, in the load's own words", () => {
    const warning = '/p/.cc-candybar.json5:3: duplicate key "x"';
    expect(config({ ...LOADED, warnings: [warning] })).toEqual({
      ok: false,
      reason: warning,
      more: [],
    });
  });

  test("every unused declaration is a problem, each kind in its own words", () => {
    expect(
      config({
        ...LOADED,
        unused: [
          { kind: "variable", name: "v" },
          { kind: "action", name: "a" },
          { kind: "helper", name: "h" },
          { kind: "segment", name: "s" },
        ],
      }),
    ).toEqual({
      ok: false,
      reason: 'variable "v" is never read',
      more: [
        'action "a" is never clicked',
        'helper "h" is never called',
        'segment "s" is in no preset',
      ],
    });
  });

  test("a config that did not load leads with the loader's headline, then its issues and advisories", () => {
    expect(
      config({
        kind: "failed",
        layers: ["/p/.cc-candybar.json5"],
        warnings: ["an advisory"],
        error:
          "Invalid config in /p/.cc-candybar.json5 (1 issue):\n  [line 2 • root] root references unknown segment",
      }),
    ).toEqual({
      ok: false,
      reason: "Invalid config in /p/.cc-candybar.json5 (1 issue):",
      more: ["[line 2 • root] root references unknown segment", "an advisory"],
    });
  });

  test("config is a CHECKS entry, so the menu and the CLI both run it", () => {
    expect(CHECKS.map((c) => c.name)).toContain("config");
    expect(
      runDoctor(facts({ kind: "outside" })).map((r) => [r.check.name, r.verdict.ok]),
    ).toEqual([
      ["config", true],
      ["install", true],
      ["daemon", true],
      ["urlHandler", true],
      ["links", true],
      ["tmuxTruecolor", true],
      ["utf8", true],
      ["termWidth", true],
      ["effectRefresh", true],
      ["nerdFont", true],
      ["segmentData", true],
      ["sessionData", true],
    ]);
  });
});

// brandon-effects-2gka.21e: a bar that moves needs Claude Code to redraw it
// every second — and whether it moves is what its drawn frames said
// (brandon-doctor-v62x.tgp), so a template's motion counts as an effect does.
describe("effectRefresh probe", () => {
  const MOVES = drew("moves");
  const MOVING = "the bar moves (an effect, a fade, or an animated segment)";
  const interval = (refreshInterval: unknown): StatusLineFacts => ({
    kind: "present",
    refreshInterval,
  });
  const effectRefresh = (
    frames: DoctorFacts["frames"],
    statusLine: StatusLineFacts,
    askedBy: DoctorFacts["askedBy"] = "command",
  ) =>
    checkByName("effectRefresh")!.probe({
      ...facts({ kind: "outside" }, {}, LOADED, frames, statusLine),
      askedBy,
    });
  const FIX = {
    kind: "claude-settings",
    path: ["statusLine", "refreshInterval"],
    value: 1,
  };

  test("a still bar with no interval → ok", () => {
    expect(effectRefresh(STILL, interval(undefined))).toEqual({ ok: true });
  });

  test("a moving bar with no interval → failed WITH the fix", () => {
    expect(effectRefresh(MOVES, interval(undefined))).toEqual({
      ok: false,
      reason: `${MOVING}, but Claude Code redraws it only on events`,
      fix: FIX,
    });
  });

  test("a moving bar with 1 → ok", () => {
    expect(effectRefresh(MOVES, interval(1))).toEqual({ ok: true });
  });

  test("a moving bar with 5 → failed WITH the fix, naming the interval", () => {
    expect(effectRefresh(MOVES, interval(5))).toEqual({
      ok: false,
      reason: `${MOVING}, but Claude Code redraws it only every 5 s`,
      fix: FIX,
    });
  });

  // Any bar seen moving needs the redraw, whatever the others drew.
  test("one moving bar among still ones → failed", () => {
    expect(
      effectRefresh(
        drew("still", "moves", "failed"),
        interval(undefined),
      ),
    ).toMatchObject({ ok: false, fix: FIX });
  });

  // Claude Code reads a number of seconds no fewer than 1: anything else is a
  // value its docs give no meaning, named as it stands and overwritten by the
  // fix — 0, a common spelling of "off", included.
  test.each([["1"], [0], [0.5], [-1]])(
    "%j is not an interval Claude Code accepts → failed naming it, WITH the fix",
    (value) => {
      expect(effectRefresh(MOVES, interval(value))).toEqual({
        ok: false,
        reason: `${MOVING}, but statusLine.refreshInterval is ${JSON.stringify(value)}, not a number of seconds Claude Code accepts (its minimum is 1)`,
        fix: FIX,
      });
    },
  );

  // A statusLine holding only a refresh interval is one Claude Code cannot
  // run, so with no statusLine in the file there is nothing to add it beside.
  test("no statusLine in the file → failed naming the file, NO fix", () => {
    expect(effectRefresh(MOVES, { kind: "absent" })).toEqual({
      ok: false,
      reason: `${MOVING}, and ${SETTINGS_PATH} sets no statusLine — set "refreshInterval": 1 beside the statusLine command that runs the bar`,
    });
  });

  // There is no statusLine object to add the interval beside; install writes
  // one.
  test("a statusLine that is not an object → failed naming it, NO fix", () => {
    expect(
      effectRefresh(MOVES, { kind: "not-an-object", value: "cc-candybar" }),
    ).toEqual({
      ok: false,
      reason: `${MOVING}, and ${SETTINGS_PATH} sets statusLine to "cc-candybar", not a statusLine object — re-run \`cc-candybar install\` to write one`,
    });
  });

  test("a still bar needs no statusLine here at all", () => {
    expect(effectRefresh(STILL, { kind: "absent" })).toEqual({ ok: true });
  });

  // No frame seen is no answer: the check says so rather than pass.
  test("no render seen → failed, unknown", () => {
    expect(effectRefresh({ kind: "ok", value: [] }, interval(undefined))).toEqual({
      ok: false,
      reason:
        "no session of this Claude Code has drawn a statusline for this daemon in the last 5 minutes, so whether it moves is unknown — run the doctor again once the bar has redrawn",
    });
    expect(
      effectRefresh({ kind: "ok", value: [] }, interval(undefined), "click"),
    ).toMatchObject({ ok: false, reason: expect.stringContaining("holds no render of this bar") });
  });

  test("only failed renders → failed, unknown", () => {
    expect(
      effectRefresh(drew("failed"), interval(undefined)),
    ).toEqual({
      ok: false,
      reason:
        "the bar's recent renders failed, so whether it moves is unknown — run the doctor again once the bar has redrawn",
    });
  });

  // A still bar whose config can start motion with no click — an effect
  // rule, fade transitions — needs the redraw before it moves.
  test("a bar that can start moving with no interval → failed WITH the fix", () => {
    expect(effectRefresh(drew("can-move"), interval(undefined))).toEqual({
      ok: false,
      reason:
        "the bar can start moving with no click (a globals.effect rule, or placements that fade in and out), but Claude Code redraws it only on events",
      fix: FIX,
    });
  });

  // A `cc-candybar frames` display moves by the daemon's pushes, not by
  // Claude Code's refresh.
  test("a moving frames display says nothing about the statusline", () => {
    expect(
      effectRefresh(
        { kind: "ok", value: [{ role: "frames", frame: "moves" }, { role: "statusline", frame: "still" }] },
        interval(undefined),
      ),
    ).toEqual({ ok: true });
  });

  // Once the file redraws every second, nothing a bar draws needs more —
  // whatever the daemon could say about its frames.
  test.each<[string, DoctorFacts["frames"]]>([
    ["no render seen", drew()],
    ["only failed renders", drew("failed")],
    ["a daemon that could not say", { kind: "failed", reason: "no daemon" }],
  ])("%s, with an interval of 1 → ok", (_, frames) => {
    expect(effectRefresh(frames, interval(1))).toEqual({ ok: true });
  });

  test("a render still drawing → failed, unknown", () => {
    expect(effectRefresh(drew("drawing"), interval(undefined))).toEqual({
      ok: false,
      reason:
        "the bar's latest render has not finished, so whether it moves is unknown — run the doctor again once the bar has redrawn",
    });
  });

  test("a daemon that could not say → failed with its reason", () => {
    expect(
      effectRefresh({ kind: "failed", reason: "daemon down" }, interval(undefined)),
    ).toEqual({ ok: false, reason: "daemon down" });
  });
});

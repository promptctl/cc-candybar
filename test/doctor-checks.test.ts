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
  type PlacementEffectFact,
  type StatusLineFacts,
  type TmuxFacts,
} from "../src/doctor/checks";
import { detectTmuxHint } from "../src/tmux-hint";
import type { EffectSelection } from "../src/themes/policy";

const HINT = { socket: "/tmp/tmux-501/default", pane: "%3", truecolor: null };

const inside = (
  features: readonly string[],
  truecolor: string | null = null,
): TmuxFacts => ({
  kind: "inside",
  hint: { ...HINT, truecolor },
  client: { kind: "ok", value: { features, termtype: "", termname: "" } },
});

const LOADED: ConfigFacts = {
  kind: "loaded",
  layers: ["/p/.cc-candybar.json5"],
  warnings: [],
  unused: [],
};

const SETTINGS_PATH = "/home/u/.claude/settings.json";
const STILL: EffectSelection = { kind: "decided", name: "none", value: "none" };

const facts = (
  tmux: TmuxFacts,
  env: Record<string, unknown> = {},
  config: ConfigFacts = LOADED,
  effect: EffectSelection = STILL,
  statusLine: StatusLineFacts = { kind: "present", refreshInterval: undefined },
  placementEffects: readonly PlacementEffectFact[] = [],
  transitions = false,
): DoctorFacts => ({
  tmux,
  config,
  effect,
  placementEffects,
  transitions,
  urlHandler: { kind: "unsupported" },
  nerdFont: { glyphs: "", terminal: { kind: "unreported" }, mark: null },
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
      ["urlHandler", true],
      ["tmuxTruecolor", true],
      ["effectRefresh", true],
      ["nerdFont", true],
    ]);
  });
});

// brandon-effects-2gka.21e: a bar that moves needs Claude Code to redraw it
// every second.
describe("effectRefresh probe", () => {
  const SHIMMER: EffectSelection = {
    kind: "decided",
    name: "shimmer",
    value: "shimmer",
  };
  const RULE: EffectSelection = {
    kind: "expression",
    source: '{{ if .busy }}shimmer{{ else }}none{{ end }}',
  };
  const interval = (refreshInterval: unknown): StatusLineFacts => ({
    kind: "present",
    refreshInterval,
  });
  const effectRefresh = (effect: EffectSelection, statusLine: StatusLineFacts) =>
    checkByName("effectRefresh")!.probe(
      facts({ kind: "outside" }, {}, LOADED, effect, statusLine),
    );
  const FIX = {
    kind: "claude-settings",
    path: ["statusLine", "refreshInterval"],
    value: 1,
  };

  test("none with no interval → ok", () => {
    expect(effectRefresh(STILL, interval(undefined))).toEqual({ ok: true });
  });

  test("shimmer with no interval → failed WITH the fix", () => {
    expect(effectRefresh(SHIMMER, interval(undefined))).toEqual({
      ok: false,
      reason:
        "the bar wears the shimmer effect, but Claude Code redraws it only on events",
      fix: FIX,
    });
  });

  test("shimmer with 1 → ok", () => {
    expect(effectRefresh(SHIMMER, interval(1))).toEqual({ ok: true });
  });

  test("shimmer with 5 → failed WITH the fix, naming the interval", () => {
    expect(effectRefresh(SHIMMER, interval(5))).toEqual({
      ok: false,
      reason:
        "the bar wears the shimmer effect, but Claude Code redraws it only every 5 s",
      fix: FIX,
    });
  });

  test("a rule with no interval → failed WITH the fix: it can turn an effect on at any render", () => {
    expect(effectRefresh(RULE, interval(undefined))).toEqual({
      ok: false,
      reason:
        "a globals.effect rule can give the bar an effect, but Claude Code redraws it only on events",
      fix: FIX,
    });
  });

  // Claude Code reads a number of seconds no fewer than 1: anything else is a
  // value its docs give no meaning, named as it stands and overwritten by the
  // fix — 0, a common spelling of "off", included.
  test.each([["1"], [0], [0.5], [-1]])(
    "%j is not an interval Claude Code accepts → failed naming it, WITH the fix",
    (value) => {
      expect(effectRefresh(SHIMMER, interval(value))).toEqual({
        ok: false,
        reason: `the bar wears the shimmer effect, but statusLine.refreshInterval is ${JSON.stringify(value)}, not a number of seconds Claude Code accepts (its minimum is 1)`,
        fix: FIX,
      });
    },
  );

  // A statusLine holding only a refresh interval is one Claude Code cannot
  // run, so with no statusLine in the file there is nothing to add it beside.
  test("no statusLine in the file → failed naming the file, NO fix", () => {
    expect(effectRefresh(SHIMMER, { kind: "absent" })).toEqual({
      ok: false,
      reason: `the bar wears the shimmer effect, and ${SETTINGS_PATH} sets no statusLine — set "refreshInterval": 1 beside the statusLine command that runs the bar`,
    });
  });

  // There is no statusLine object to add the interval beside; install writes
  // one.
  test("a statusLine that is not an object → failed naming it, NO fix", () => {
    expect(
      effectRefresh(SHIMMER, { kind: "not-an-object", value: "cc-candybar" }),
    ).toEqual({
      ok: false,
      reason: `the bar wears the shimmer effect, and ${SETTINGS_PATH} sets statusLine to "cc-candybar", not a statusLine object — re-run \`cc-candybar install\` to write one`,
    });
  });

  test("a still bar needs no statusLine here at all", () => {
    expect(effectRefresh(STILL, { kind: "absent" })).toEqual({ ok: true });
  });

  // A placement wearing its own effect moves on a still bar
  // (brandon-effects-2gka.bm1), so it needs the redraw the bar's would.
  const withPlacements = (
    effect: EffectSelection,
    placementEffects: readonly PlacementEffectFact[],
  ) =>
    checkByName("effectRefresh")!.probe(
      facts(
        { kind: "outside" },
        {},
        LOADED,
        effect,
        interval(undefined),
        placementEffects,
      ),
    );

  test("a still bar with a placement wearing pulse → failed naming it, WITH the fix", () => {
    expect(
      withPlacements(STILL, [{ placement: "context", effect: "pulse" }]),
    ).toEqual({
      ok: false,
      reason:
        "context wears the pulse effect, but Claude Code redraws it only on events",
      fix: FIX,
    });
  });

  test("the bar's effect and a placement's are both named", () => {
    expect(
      withPlacements(SHIMMER, [{ placement: "context", effect: "pulse" }]),
    ).toMatchObject({
      ok: false,
      reason:
        "the bar wears the shimmer effect and context wears the pulse effect, but Claude Code redraws it only on events",
    });
  });

  // A placement fading in moves for 20 s on a still bar
  // (brandon-effects-2gka.631), so transitions need the redraw too.
  test("a still bar with transitions on → failed naming them, WITH the fix", () => {
    expect(
      checkByName("effectRefresh")!.probe(
        facts(
          { kind: "outside" },
          {},
          LOADED,
          STILL,
          interval(undefined),
          [],
          true,
        ),
      ),
    ).toEqual({
      ok: false,
      reason:
        "placements fade in and dissolve out as they come and go, but Claude Code redraws it only on events",
      fix: FIX,
    });
  });
});

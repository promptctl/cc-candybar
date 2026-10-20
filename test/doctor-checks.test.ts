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
  type Asked,
  type TmuxFacts,
} from "../src/doctor/checks";
import { detectTmuxHint } from "../src/tmux-hint";
import type { SettingsSource } from "../src/claude-settings";
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

// One settings file of the chain, as `readSettingsChain` returns it.
const source = (
  scope: SettingsSource["scope"],
  path: string,
  settings: Record<string, unknown>,
): SettingsSource => ({
  scope,
  path,
  settings,
  env: (settings.env ?? {}) as Record<string, unknown>,
});

// The user settings file alone, holding `settings`.
const userFile = (settings: Record<string, unknown>): SettingsSource[] => [
  source("user", SETTINGS_PATH, settings),
];

const facts = (
  tmux: TmuxFacts,
  env: Record<string, unknown> = {},
  config: ConfigFacts = LOADED,
  frames: DoctorFacts["frames"] = STILL,
  sources: Asked<readonly SettingsSource[]> = {
    kind: "ok",
    value: userFile({ env, statusLine: { command: "cc-candybar" } }),
  },
): DoctorFacts => ({
  ...HEALTHY_FACTS,
  tmux,
  config,
  frames,
  claudeSettings: {
    at: { managedDir: "/managed", projectDir: "/p", userFile: SETTINGS_PATH },
    sources,
  },
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
      file: SETTINGS_PATH,
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
  const ok = (value: readonly SettingsSource[]) => ({ kind: "ok", value }) as const;
  // The user file's statusLine, with `refreshInterval` when one is given.
  const interval = (...refreshInterval: [] | [unknown]) =>
    ok(
      userFile({
        statusLine: {
          command: "cc-candybar",
          ...(refreshInterval.length === 0 ? {} : { refreshInterval: refreshInterval[0] }),
        },
      }),
    );
  const effectRefresh = (
    frames: DoctorFacts["frames"],
    sources: Asked<readonly SettingsSource[]>,
    askedBy: DoctorFacts["askedBy"] = "command",
  ) =>
    checkByName("effectRefresh")!.probe({
      ...facts({ kind: "outside" }, {}, LOADED, frames, sources),
      askedBy,
    });
  const FROM = ` (statusLine from ${SETTINGS_PATH})`;
  const FIX = {
    kind: "claude-settings",
    file: SETTINGS_PATH,
    path: ["statusLine", "refreshInterval"],
    value: 1,
  };

  test("a still bar with no interval → ok", () => {
    expect(effectRefresh(STILL, interval())).toEqual({ ok: true });
  });

  test("a moving bar with no interval → failed WITH the fix", () => {
    expect(effectRefresh(MOVES, interval())).toEqual({
      ok: false,
      reason: `${MOVING}, but Claude Code redraws it only on events${FROM}`,
      fix: FIX,
    });
  });

  test("a moving bar with 1 → ok, naming the file it is set in", () => {
    expect(effectRefresh(MOVES, interval(1))).toEqual({
      ok: true,
      note: `statusLine.refreshInterval is 1 in ${SETTINGS_PATH}`,
    });
  });

  test("a moving bar with 5 → failed WITH the fix, naming the interval", () => {
    expect(effectRefresh(MOVES, interval(5))).toEqual({
      ok: false,
      reason: `${MOVING}, but Claude Code redraws it only every 5 s${FROM}`,
      fix: FIX,
    });
  });

  // Any bar seen moving needs the redraw, whatever the others drew.
  test("one moving bar among still ones → failed", () => {
    expect(
      effectRefresh(
        drew("still", "moves", "failed"),
        interval(),
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
        reason: `${MOVING}, but statusLine.refreshInterval is ${JSON.stringify(value)}, not a number of seconds Claude Code accepts (its minimum is 1)${FROM}`,
        fix: FIX,
      });
    },
  );

  // A statusLine holding only a refresh interval is one Claude Code cannot
  // run, so with no statusLine in any file there is nothing to add it beside —
  // and the bar is drawn, so its statusLine is in a scope no file holds.
  test("no statusLine in any file → failed naming the files read, NO fix", () => {
    expect(effectRefresh(MOVES, ok(userFile({})))).toEqual({
      ok: false,
      reason: `${MOVING}, and no settings file Claude Code reads here sets a statusLine (read: ${SETTINGS_PATH}) — the one that runs the bar comes from --settings, MDM or server-managed settings, which the doctor cannot read; set "refreshInterval": 1 beside its command there`,
    });
    expect(effectRefresh(MOVES, ok([]))).toMatchObject({
      reason: expect.stringContaining("(read: none)"),
    });
  });

  // There is no statusLine object to add the interval beside; install writes
  // one.
  test("a statusLine that is not an object → failed naming it, NO fix", () => {
    expect(
      effectRefresh(MOVES, ok(userFile({ statusLine: "cc-candybar" }))),
    ).toEqual({
      ok: false,
      reason: `${MOVING}, and ${SETTINGS_PATH} sets statusLine to "cc-candybar", not a statusLine object — re-run \`cc-candybar install\` to write one`,
    });
  });

  // The statusLine Claude Code runs is the highest scope's (brandon-doctor-
  // v62x.49w): a managed one outranks the user file, and is a policy the
  // doctor never writes — the reason says where the line goes instead.
  test("a managed statusLine wins over the user file, and gets NO fix", () => {
    const managed = "/managed/managed-settings.d/10-dotfiles.json";
    const chain = (managedLine: Record<string, unknown>) =>
      ok([
        source("managed", managed, { statusLine: managedLine }),
        source("user", SETTINGS_PATH, {
          statusLine: { command: "other", refreshInterval: 1 },
        }),
      ]);
    expect(
      effectRefresh(MOVES, chain({ command: "cc-candybar", refreshInterval: 1 })),
    ).toEqual({ ok: true, note: `statusLine.refreshInterval is 1 in ${managed}` });
    expect(effectRefresh(MOVES, chain({ command: "cc-candybar" }))).toEqual({
      ok: false,
      reason: `${MOVING}, but Claude Code redraws it only on events — its statusLine is in managed settings, ${managed}: set "refreshInterval": 1 there`,
    });
  });

  // Inside one scope, files merge key by key: the interval may come from a
  // lower managed file than the command — and that file is the one named.
  test("managed files merge: the interval's own file is the one named", () => {
    const high = "/managed/managed-settings.d/20-b.json";
    const low = "/managed/managed-settings.json";
    expect(
      effectRefresh(
        MOVES,
        ok([
          source("managed", high, { statusLine: { command: "cc-candybar" } }),
          source("managed", low, { statusLine: { refreshInterval: 1 } }),
        ]),
      ),
    ).toEqual({ ok: true, note: `statusLine.refreshInterval is 1 in ${low}` });
  });

  // A project-local statusLine outranks the user file, so the fix writes
  // there; the checked-in project file is somebody's repository, so it gets
  // the reason and no fix, as managed settings do.
  test("a project-local statusLine wins: the fix targets that file", () => {
    const local = "/p/.claude/settings.local.json";
    expect(
      effectRefresh(
        MOVES,
        ok([
          source("project-local", local, { statusLine: { command: "cc-candybar" } }),
          source("user", SETTINGS_PATH, {
            statusLine: { command: "cc-candybar", refreshInterval: 1 },
          }),
        ]),
      ),
    ).toEqual({
      ok: false,
      reason: `${MOVING}, but Claude Code redraws it only on events (statusLine from ${local})`,
      fix: { ...FIX, file: local },
    });
  });

  test("a checked-in project statusLine wins, and gets NO fix", () => {
    const project = "/p/.claude/settings.json";
    expect(
      effectRefresh(
        MOVES,
        ok([source("project", project, { statusLine: { command: "cc-candybar" } })]),
      ),
    ).toEqual({
      ok: false,
      reason: `${MOVING}, but Claude Code redraws it only on events — its statusLine is in the project's checked-in settings, ${project}: set "refreshInterval": 1 there`,
    });
  });

  // A chain that does not read fails the rows that read it, naming why.
  test("an unreadable chain → failed with its reason, NO fix", () => {
    expect(
      effectRefresh(MOVES, { kind: "failed", reason: "cannot read /p/.claude/settings.json: x" }),
    ).toEqual({
      ok: false,
      reason: `${MOVING}, and Claude Code's settings could not be read: cannot read /p/.claude/settings.json: x`,
    });
  });

  test("a still bar needs no statusLine here at all", () => {
    expect(effectRefresh(STILL, ok([]))).toEqual({ ok: true });
  });

  // No frame seen is no answer: the check says so rather than pass.
  test("no render seen → failed, unknown", () => {
    expect(effectRefresh({ kind: "ok", value: [] }, interval())).toEqual({
      ok: false,
      reason:
        "no session of this Claude Code has drawn a statusline for this daemon in the last 5 minutes, so whether it moves is unknown — run the doctor again once the bar has redrawn",
    });
    expect(
      effectRefresh({ kind: "ok", value: [] }, interval(), "click"),
    ).toMatchObject({ ok: false, reason: expect.stringContaining("holds no render of this bar") });
  });

  test("only failed renders → failed, unknown", () => {
    expect(
      effectRefresh(drew("failed"), interval()),
    ).toEqual({
      ok: false,
      reason:
        "the bar's recent renders failed, so whether it moves is unknown — run the doctor again once the bar has redrawn",
    });
  });

  // A still bar whose config can start motion with no click — an effect
  // rule, fade transitions — needs the redraw before it moves.
  test("a bar that can start moving with no interval → failed WITH the fix", () => {
    expect(effectRefresh(drew("can-move"), interval())).toEqual({
      ok: false,
      reason:
        `the bar can start moving (a globals.effect rule, placements that fade in and out, or a placement with an effect of its own that is not drawn now), but Claude Code redraws it only on events${FROM}`,
      fix: FIX,
    });
  });

  // A `cc-candybar frames` display moves by the daemon's pushes, not by
  // Claude Code's refresh.
  test("a moving frames display says nothing about the statusline", () => {
    expect(
      effectRefresh(
        { kind: "ok", value: [{ role: "frames", frame: "moves" }, { role: "statusline", frame: "still" }] },
        interval(),
      ),
    ).toEqual({ ok: true });
  });

  test("only a frames display seen → failed, unknown, naming it", () => {
    expect(
      effectRefresh(
        { kind: "ok", value: [{ role: "frames", frame: "still" }] },
        interval(),
        "click",
      ),
    ).toEqual({
      ok: false,
      reason:
        "only a `cc-candybar frames` display has drawn this bar, not Claude Code's statusline, so whether it moves is unknown — run the doctor again once the bar has redrawn",
    });
  });

  // Once the file redraws every second, nothing a bar draws needs more —
  // whatever the daemon could say about its frames.
  test.each<[string, DoctorFacts["frames"]]>([
    ["no render seen", drew()],
    ["only failed renders", drew("failed")],
    ["a daemon that could not say", { kind: "failed", reason: "no daemon" }],
  ])("%s, with an interval of 1 → ok", (_, frames) => {
    expect(effectRefresh(frames, interval(1))).toEqual({
      ok: true,
      note: `statusLine.refreshInterval is 1 in ${SETTINGS_PATH}`,
    });
  });

  test("a render still drawing → failed, unknown", () => {
    expect(effectRefresh(drew("drawing"), interval())).toEqual({
      ok: false,
      reason:
        "the bar's latest render has not finished, so whether it moves is unknown — run the doctor again once the bar has redrawn",
    });
  });

  test("a daemon that could not say → failed with its reason", () => {
    expect(
      effectRefresh({ kind: "failed", reason: "daemon down" }, interval()),
    ).toEqual({ ok: false, reason: "daemon down" });
  });
});

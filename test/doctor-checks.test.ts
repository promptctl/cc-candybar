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
  type TmuxFacts,
} from "../src/doctor/checks";
import { detectTmuxHint } from "../src/tmux-hint";

const HINT = { socket: "/tmp/tmux-501/default", pane: "%3", truecolor: null };

const inside = (
  features: readonly string[],
  truecolor: string | null = null,
): TmuxFacts => ({
  kind: "inside",
  hint: { ...HINT, truecolor },
  termfeatures: { kind: "ok", value: features },
});

const LOADED: ConfigFacts = {
  kind: "loaded",
  path: "/p/.cc-candybar.json5",
  warnings: [],
  shadowed: [],
  unused: [],
};

const facts = (
  tmux: TmuxFacts,
  env: Record<string, unknown> = {},
  config: ConfigFacts = LOADED,
): DoctorFacts => ({
  tmux,
  config,
  claudeSettings: { path: "/home/u/.claude/settings.json", env },
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
      kind: "claude-settings-env",
      name: TMUX_TRUECOLOR_VAR,
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
        termfeatures: { kind: "failed", reason: "no server running" },
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
    expect(config({ ...LOADED, path: null })).toEqual({ ok: true });
  });

  test("an advisory the load earned fails it, in the load's own words", () => {
    const warning = '/p/.cc-candybar.json5:3: duplicate key "x"';
    expect(config({ ...LOADED, warnings: [warning] })).toEqual({
      ok: false,
      reason: warning,
      more: [],
    });
  });

  test("a config behind the loaded one fails it, naming both files", () => {
    expect(
      config({ ...LOADED, shadowed: ["/home/u/.config/cc-candybar/config.json5"] }),
    ).toEqual({
      ok: false,
      reason:
        "/home/u/.config/cc-candybar/config.json5 is never read — /p/.cc-candybar.json5 is found first",
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
        path: "/p/.cc-candybar.json5",
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
      ["tmuxTruecolor", true],
    ]);
  });
});

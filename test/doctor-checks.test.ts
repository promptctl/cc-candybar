// [LAW:verifiable-goals] brandon-doctor-b6a acceptance 1: the tmux-truecolor
// probe over fixture facts yields each verdict the ticket names — pure, no
// mocks, because the probe is a function of a DoctorFacts record.

import {
  CHECKS,
  checkByName,
  runDoctor,
  TMUX_TRUECOLOR_VAR,
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

const facts = (
  tmux: TmuxFacts,
  claudeSettingsEnv: Record<string, unknown> = {},
): DoctorFacts => ({ tmux, claudeSettingsEnv });

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

// Boundary contract for the provider lanes — every lane carries a typed
// Outcome and buildRenderPayload is the ONE log site for their failures;
// `absent` and `failed` both project as MISSING payload fields — distinct
// from a real 0/"" — so the DSL input fallback chain (default + last_error)
// fires. [LAW:no-silent-failure][LAW:single-enforcer][LAW:one-type-per-behavior]

import { EMPTY_HISTORY_DEPTH } from "../src/daemon/settings-history";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { resolveThemeSelection } from "../src/themes/palette-resolvers.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildRenderPayload } from "../src/daemon/render-payload";
import { claudeConfigDir } from "../src/claude-settings";
import type { ClientHints } from "../src/daemon/protocol";
import type {
  EffectiveGlobals,
  RenderPayloadDeps,
} from "../src/daemon/render-payload";
import type { GitInfo } from "../src/segments/git";
import { ABSENT, failed, ok, type Outcome } from "../src/utils/outcome";
import { FLOOR_STYLE } from "./helpers/floor-style";

type LogEntry = { level: string; msg: string };

function depsWith(
  gitOutcome: Outcome<GitInfo>,
  logs: LogEntry[],
  overrides: Record<string, unknown> = {},
): RenderPayloadDeps {
  return {
    gitProvider: { getGitInfo: async () => gitOutcome },
    usageStore: {
      getUsageInfo: async () => ABSENT,
      getTodayInfo: async () => ABSENT,
    },
    contextProvider: { getContextInfo: async () => ABSENT },
    metricsProvider: { getMetricsInfo: async () => ABSENT },
    tmuxService: { getSessionId: async () => ABSENT },
    log: (level: string, msg: string) => logs.push({ level, msg }),
    history: () => EMPTY_HISTORY_DEPTH,
    navigation: () => 0,
    ...overrides,
  } as unknown as RenderPayloadDeps;
}

// The effective globals the daemon resolves per render; these lane tests
// don't exercise them, so any well-formed struct serves as the required
// argument.
// No client hints: these fixtures exercise the daemon-side folds, not the wire
// boundary. An empty object is the honest "this render carried no hints"
// (the shape an old client produces), so `host.ssh` stays absent throughout.
const NO_HINTS: ClientHints = {};

const EFFECTIVE_GLOBALS: EffectiveGlobals = {
  theme: resolveThemeSelection(undefined, null, "textual-dark"),
  style: FLOOR_STYLE,
  preset: "default",
  presetCustomized: false,
  endcaps: "powerline",
  variation: "accent",
  charset: "unicode",
  colorCompatibility: "truecolor",
  autoWrap: true,
  padding: 1,
  updateNotice: true,
  separator: undefined,
};

const GIT_PATHS = new Set([
  "git.branch",
  "git.ahead",
  "git.sha",
  "git.stash",
  "git.upstream",
]);

function hookData(transcriptPath: string) {
  return {
    hook_event_name: "Status",
    session_id: "test-session",
    transcript_path: transcriptPath,
    cwd: "/tmp",
    model: { id: "claude-opus-4-7", display_name: "Opus" },
    workspace: { current_dir: "/tmp", project_dir: "/tmp", added_dirs: [] },
  };
}

describe("buildRenderPayload — git outcome lane", () => {
  test("whole-fetch failure: no git key, exactly one warn log with the reason", async () => {
    const logs: LogEntry[] = [];
    const deps = depsWith(failed("git status --porcelain=v2 --branch: timeout"), logs);

    const payload = await buildRenderPayload(
      hookData("/no/such/transcript.jsonl"),
      deps,
      undefined,
      GIT_PATHS,
      EFFECTIVE_GLOBALS,
      NO_HINTS,
      { unsaved: 0, resettable: 0 },
    );

    expect(payload.git).toBeUndefined();
    expect(logs).toEqual([
      {
        level: "warn",
        msg: "provider fetch failed: git status --porcelain=v2 --branch: timeout",
      },
    ]);
  });

  test("absent (not a repo): no git key, NOTHING logged", async () => {
    const logs: LogEntry[] = [];
    const deps = depsWith(ABSENT, logs);

    const payload = await buildRenderPayload(
      hookData("/no/such/transcript.jsonl"),
      deps,
      undefined,
      GIT_PATHS,
      EFFECTIVE_GLOBALS,
      NO_HINTS,
      { unsaved: 0, resettable: 0 },
    );

    expect(payload.git).toBeUndefined();
    expect(logs).toEqual([]);
  });

  test("per-field failure: field missing, siblings present, one log naming the field", async () => {
    const logs: LogEntry[] = [];
    const deps = depsWith(
      ok({
        branch: "main",
        status: "clean",
        aheadBehind: ok({ ahead: 1, behind: 2 }),
        sha: ok("abc1234"),
        stashCount: failed("git stash list: timeout, exit null"),
        upstream: ABSENT,
      }),
      logs,
    );

    const payload = await buildRenderPayload(
      hookData("/no/such/transcript.jsonl"),
      deps,
      undefined,
      GIT_PATHS,
      EFFECTIVE_GLOBALS,
      NO_HINTS,
      { unsaved: 0, resettable: 0 },
    );

    // ok fields project as values; the failed field is MISSING (the DSL
    // default + last_error chain fires) — never a fabricated 0.
    expect(payload.git).toEqual({
      branch: "main",
      status: "clean",
      ahead: 1,
      behind: 2,
      sha: "abc1234",
    });
    expect("stash" in payload.git!).toBe(false);
    // The absent upstream is also missing but logs nothing; only the failed
    // stash produces a log line.
    expect(logs).toEqual([
      {
        level: "warn",
        msg: "provider fetch failed: git.stash: git stash list: timeout, exit null",
      },
    ]);
  });
});

describe("buildRenderPayload — cache outcome lane", () => {
  const CACHE_PATHS = new Set(["cache.expiresAt"]);

  test("unreadable transcript: no cache key, one warn log", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-payload-cache-"));
    const transcript = join(dir, "transcript.jsonl");
    writeFileSync(transcript, "{}\n");
    chmodSync(transcript, 0o000);

    const logs: LogEntry[] = [];
    const deps = depsWith(ABSENT, logs);
    const payload = await buildRenderPayload(
      hookData(transcript),
      deps,
      undefined,
      CACHE_PATHS,
      EFFECTIVE_GLOBALS,
      NO_HINTS,
      { unsaved: 0, resettable: 0 },
    );
    chmodSync(transcript, 0o644);

    expect(payload.cache).toBeUndefined();
    expect(logs).toHaveLength(1);
    expect(logs[0]!.level).toBe("warn");
    expect(logs[0]!.msg).toContain("readTail");
  });

  test("cache-bearing transcript: cache.expiresAt projected, nothing logged", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-payload-cache-"));
    const transcript = join(dir, "transcript.jsonl");
    const ts = "2026-05-30T12:00:00.000Z";
    writeFileSync(
      transcript,
      JSON.stringify({
        timestamp: ts,
        message: { usage: { cache_read_input_tokens: 100 } },
      }) + "\n",
    );

    const logs: LogEntry[] = [];
    const deps = depsWith(ABSENT, logs);
    const payload = await buildRenderPayload(
      hookData(transcript),
      deps,
      undefined,
      CACHE_PATHS,
      EFFECTIVE_GLOBALS,
      NO_HINTS,
      { unsaved: 0, resettable: 0 },
    );

    expect(payload.cache).toEqual({
      expiresAt: Math.floor(Date.parse(ts) / 1000) + 3600,
    });
    expect(logs).toEqual([]);
  });
});

// The five lanes migrated after PR #96 (session/today/context/metrics/tmux)
// share the exact same contract as git/cache — one behavior, one type.
describe("buildRenderPayload — migrated lanes share the outcome contract", () => {
  const LANE_PATHS = new Set([
    "session.cost",
    "today.cost",
    "context.totalTokens",
    "metrics.messageCount",
    "tmux.session",
  ]);

  test("failed lanes each log one warn and project as missing fields", async () => {
    const logs: LogEntry[] = [];
    const deps = depsWith(ABSENT, logs, {
      contextProvider: {
        getContextInfo: async () => failed("context transcript: EACCES"),
      },
      metricsProvider: {
        getMetricsInfo: async () => failed("metrics (s): boom"),
      },
    });

    const payload = await buildRenderPayload(
      hookData("/no/such/transcript.jsonl"),
      deps,
      undefined,
      LANE_PATHS,
      EFFECTIVE_GLOBALS,
      NO_HINTS,
      { unsaved: 0, resettable: 0 },
    );

    expect(payload.context).toBeUndefined();
    expect(payload.metrics).toBeUndefined();
    expect(logs).toEqual(
      expect.arrayContaining([
        {
          level: "warn",
          msg: "provider fetch failed: context transcript: EACCES",
        },
        { level: "warn", msg: "provider fetch failed: metrics (s): boom" },
      ]),
    );
    expect(logs).toHaveLength(2);
  });

  test("ok lanes project values; absent lanes are missing with nothing logged", async () => {
    const logs: LogEntry[] = [];
    const deps = depsWith(ABSENT, logs, {
      tmuxService: { getSessionId: async () => ok("main-session") },
      usageStore: {
        getUsageInfo: async () =>
          ok({
            session: {
              cost: 1.25,
              calculatedCost: 1.25,
              officialCost: null,
              tokens: 42,
              tokenBreakdown: null,
            },
          }),
        getTodayInfo: async () => ABSENT,
      },
    });

    const payload = await buildRenderPayload(
      hookData("/no/such/transcript.jsonl"),
      deps,
      undefined,
      LANE_PATHS,
      EFFECTIVE_GLOBALS,
      NO_HINTS,
      { unsaved: 0, resettable: 0 },
    );

    expect(payload.tmux).toEqual({ session: "main-session" });
    expect(payload.session).toEqual({ cost: 1.25, tokens: 42 });
    expect(payload.today).toBeUndefined();
    expect(logs).toEqual([]);
  });

  test("a lane stub that THROWS is totalized to failed and logged with its lane name", async () => {
    const logs: LogEntry[] = [];
    const deps = depsWith(ABSENT, logs, {
      tmuxService: {
        getSessionId: async () => {
          throw new Error("stub bug");
        },
      },
    });

    const payload = await buildRenderPayload(
      hookData("/no/such/transcript.jsonl"),
      deps,
      undefined,
      LANE_PATHS,
      EFFECTIVE_GLOBALS,
      NO_HINTS,
      { unsaved: 0, resettable: 0 },
    );

    expect(payload.tmux).toBeUndefined();
    expect(logs).toHaveLength(1);
    expect(logs[0]!.msg).toContain("tmux:");
    expect(logs[0]!.msg).toContain("stub bug");
  });
});

// [LAW:one-source-of-truth] candybar-config-engine-71o.3: style/charset/
// colorCompatibility/autoWrap/padding are style's twins — this pins
// that buildRenderPayload projects the EffectiveGlobals struct into the
// payload verbatim (no name typo, no dropped field, unconditionally present
// with no `wants` gate — unlike theme/style, which renderDsl produces).
describe("buildRenderPayload — effective globals projection", () => {
  test("every template-facing EffectiveGlobals field lands under its own *.effective payload key, unconditionally; the two renderDsl-produced fields have none", async () => {
    const effective: EffectiveGlobals = {
      theme: resolveThemeSelection(undefined, null, "nord"),
      style: FLOOR_STYLE,
      preset: "default",
      presetCustomized: true,
      endcaps: "capsule",
      variation: "mono",
      charset: "ascii",
      colorCompatibility: "256",
      autoWrap: false,
      padding: 3,
      updateNotice: true,
      separator: undefined,
    };
    const logs: LogEntry[] = [];
    const payload = await buildRenderPayload(
      hookData("/no/such/transcript.jsonl"),
      depsWith(ABSENT, logs),
      undefined,
      new Set(), // no provider lane needed for this projection
      effective,
      NO_HINTS,
      { unsaved: 0, resettable: 0 },
    );
    // `theme` and `style` are the two fields this projection does NOT carry:
    // renderDsl injects both `.effective` values, because under a RULE in that
    // globals slot it is the only thing that knows the answer (brandon-looks-pe6
    // for `style`, brandon-themes-dzl for `theme`). Asserted absent rather than
    // left unmentioned, so re-adding a second producer fails here.
    expect("theme" in payload).toBe(false);
    expect("style" in payload).toBe(false);
    expect(payload.preset).toEqual({
      effective: "default",
      customized: true,
      bundled: true,
    });
    expect(payload.endcaps).toEqual({ effective: "capsule" });
    expect(payload.variation).toEqual({ effective: "mono" });
    expect(payload.charset).toEqual({ effective: "ascii" });
    expect(payload.colorCompatibility).toEqual({ effective: "256" });
    expect(payload.autoWrap).toEqual({ effective: false });
    expect(payload.padding).toEqual({ effective: 3 });
    // `updateNotice` gates the notice channel AND labels its settings-menu
    // toggle; `separator` only feeds the joiner, and no template reads it.
    expect(payload.updateNotice).toEqual({ effective: true });
    expect(payload).not.toHaveProperty("separator");
  });
});

describe("buildRenderPayload — git PR projection", () => {
  // [LAW:no-silent-failure] The PR field is the one git field whose `failed`
  // does NOT collapse to a missing key: it surfaces as `prError` (a visible
  // render value) AND logs, so a forge outage is distinct from "no PR".
  const PR_PATHS = new Set([
    "git.branch",
    "git.prNumber",
    "git.prUrl",
    "git.prError",
  ]);

  test("open PR (ok) → prNumber/prState/prUrl projected, nothing logged", async () => {
    const logs: LogEntry[] = [];
    const deps = depsWith(
      ok({
        branch: "feature",
        status: "clean",
        aheadBehind: ABSENT,
        pullRequest: ok({
          number: 76,
          state: "OPEN",
          url: "https://github.com/x/y/pull/76",
        }),
      }),
      logs,
    );

    const payload = await buildRenderPayload(
      hookData("/no/such/transcript.jsonl"),
      deps,
      undefined,
      PR_PATHS,
      EFFECTIVE_GLOBALS,
      NO_HINTS,
      { unsaved: 0, resettable: 0 },
    );

    expect(payload.git).toMatchObject({
      prNumber: 76,
      prState: "OPEN",
      prUrl: "https://github.com/x/y/pull/76",
    });
    expect("prError" in payload.git!).toBe(false);
    expect(logs).toEqual([]);
  });

  test("lookup failed → prError surfaced AND logged (visible, distinct)", async () => {
    const logs: LogEntry[] = [];
    const deps = depsWith(
      ok({
        branch: "feature",
        status: "clean",
        aheadBehind: ABSENT,
        pullRequest: failed("gh pr view: non-zero, exit 1, HTTP 401"),
      }),
      logs,
    );

    const payload = await buildRenderPayload(
      hookData("/no/such/transcript.jsonl"),
      deps,
      undefined,
      PR_PATHS,
      EFFECTIVE_GLOBALS,
      NO_HINTS,
      { unsaved: 0, resettable: 0 },
    );

    expect(payload.git!.prError).toBe("gh pr view: non-zero, exit 1, HTTP 401");
    expect("prNumber" in payload.git!).toBe(false);
    expect("prUrl" in payload.git!).toBe(false);
    expect(logs).toEqual([
      {
        level: "warn",
        msg: "provider fetch failed: git.pr: gh pr view: non-zero, exit 1, HTTP 401",
      },
    ]);
  });

  test("no PR (absent) → no pr* fields, nothing logged", async () => {
    const logs: LogEntry[] = [];
    const deps = depsWith(
      ok({
        branch: "feature",
        status: "clean",
        aheadBehind: ABSENT,
        pullRequest: ABSENT,
      }),
      logs,
    );

    const payload = await buildRenderPayload(
      hookData("/no/such/transcript.jsonl"),
      deps,
      undefined,
      PR_PATHS,
      EFFECTIVE_GLOBALS,
      NO_HINTS,
      { unsaved: 0, resettable: 0 },
    );

    expect("prNumber" in payload.git!).toBe(false);
    expect("prUrl" in payload.git!).toBe(false);
    expect("prError" in payload.git!).toBe(false);
    expect(logs).toEqual([]);
  });
});

// brandon-context-ceiling-xta.e3p: the autocompact lane reads the settings file
// of the Claude Code directory THIS render's client reported — never the
// daemon's own env — and its refusal is logged once by the one log site and
// carried into the payload as text the segment shows.
describe("buildRenderPayload — autocompact lane", () => {
  const AUTOCOMPACT_PATHS = new Set(["autocompact.window"]);
  const run = async (
    read: Outcome<number | "auto">,
    hints: ClientHints,
    logs: LogEntry[],
  ) => {
    const asked: string[] = [];
    const deps = depsWith(ABSENT, logs, {
      autoCompact: (settingsPath: string) => {
        asked.push(settingsPath);
        return read;
      },
    });
    const payload = await buildRenderPayload(
      hookData("/no/such/transcript.jsonl"),
      deps,
      undefined,
      AUTOCOMPACT_PATHS,
      EFFECTIVE_GLOBALS,
      hints,
      { unsaved: 0, resettable: 0 },
    );
    return { payload, asked };
  };

  test("the settings file is the one in the client's claudeConfigDir", async () => {
    const logs: LogEntry[] = [];
    const { payload, asked } = await run(
      ok(400_000),
      { claudeConfigDir: "/home/u/.claude-work" },
      logs,
    );
    expect(asked).toEqual(["/home/u/.claude-work/settings.json"]);
    // No context payload: the cap is the range's own top.
    expect(payload.autocompact).toEqual({
      window: 400_000,
      applied: 400_000,
      lower: 300_000,
      higher: 500_000,
    });
    expect(logs).toEqual([]);
  });

  // Asked for autocompact alone, the context lane still runs: the controls
  // are capped to the model's window, which only it knows.
  test("the cap comes from the context lane even when no template reads context", async () => {
    const deps = depsWith(ABSENT, [], {
      autoCompact: () => ok(800_000),
      contextProvider: {
        getContextInfo: async () =>
          ok({ totalTokens: 1, maxTokens: 200_000, contextLeftPercentage: 99 }),
      },
    });
    const payload = await buildRenderPayload(
      hookData("/no/such/transcript.jsonl"),
      deps,
      undefined,
      AUTOCOMPACT_PATHS,
      EFFECTIVE_GLOBALS,
      NO_HINTS,
      { unsaved: 0, resettable: 0 },
    );
    expect(payload.autocompact).toEqual({
      window: 800_000,
      applied: 200_000,
      lower: 100_000,
      higher: 0,
    });
  });

  test("a refused read: one warn log naming the lane, the reason in the payload", async () => {
    const logs: LogEntry[] = [];
    const { payload } = await run(failed("cannot read /c/settings.json: nope"), {}, logs);
    expect(payload.autocompact).toEqual({
      error: "cannot read /c/settings.json: nope",
    });
    expect(logs).toEqual([
      {
        level: "warn",
        msg: "provider fetch failed: autocompact: cannot read /c/settings.json: nope",
      },
    ]);
  });
});

// brandon-client-hints-7ua: the memento and today lanes answer for the Claude
// Code THIS render's client runs under — its config directory and the
// variables memento resolves its config home from — never the daemon's env.
describe("buildRenderPayload — the lanes that read a session's Claude Code", () => {
  const run = async (paths: string[], hints: ClientHints) => {
    const scopes: unknown[] = [];
    const seeded: unknown[] = [];
    const deps = depsWith(ABSENT, [], {
      mementoProvider: {
        getCeiling: async (scope: unknown) => {
          scopes.push(scope);
          return ABSENT;
        },
      },
      usageStore: {
        getUsageInfo: async () => ABSENT,
        getTodayInfo: async (_hook: unknown, claudeConfigDir: unknown) => {
          seeded.push(claudeConfigDir);
          return ABSENT;
        },
      },
    });
    await buildRenderPayload(
      hookData("/no/such/transcript.jsonl"),
      deps,
      undefined,
      new Set(paths),
      EFFECTIVE_GLOBALS,
      hints,
      { unsaved: 0, resettable: 0 },
    );
    return { scopes, seeded };
  };
  const ANCHOR = { sessionId: "test-session", projectDir: "/tmp", cwd: "/tmp" };

  test("memento is asked under the client's directory and env", async () => {
    const { scopes } = await run(["memento.ceiling"], {
      claudeConfigDir: "/home/u/.claude.zai",
      mementoEnv: { XDG_CONFIG_HOME: "/home/u/.config-zai" },
    });
    expect(scopes).toEqual([
      {
        ...ANCHOR,
        claudeConfigDir: "/home/u/.claude.zai",
        env: { XDG_CONFIG_HOME: "/home/u/.config-zai" },
      },
    ]);
  });

  test("a client that reports neither: the default directory, and the env left to the daemon's", async () => {
    const { scopes } = await run(["memento.ceiling"], NO_HINTS);
    expect(scopes).toEqual([
      { ...ANCHOR, claudeConfigDir: claudeConfigDir(undefined), env: undefined },
    ]);
  });

  test("today seeds the client's directory", async () => {
    const zai = await run(["today.cost"], { claudeConfigDir: "/home/u/.claude.zai" });
    expect(zai.seeded).toEqual(["/home/u/.claude.zai"]);
    expect((await run(["today.cost"], NO_HINTS)).seeded).toEqual([undefined]);
  });
});

// Boundary contract for the provider lanes — every lane carries a typed
// Outcome and buildRenderPayload is the ONE log site for their failures;
// `absent` and `failed` both project as MISSING payload fields — distinct
// from a real 0/"" — so the DSL input fallback chain (default + last_error)
// fires. [LAW:no-silent-failure][LAW:single-enforcer][LAW:one-type-per-behavior]

import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildRenderPayload } from "../src/daemon/render-payload";
import type { RenderPayloadDeps } from "../src/daemon/render-payload";
import type { GitInfo } from "../src/segments/git";
import { ABSENT, failed, ok, type Outcome } from "../src/utils/outcome";

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
    sessionState: { get: () => undefined },
    log: (level: string, msg: string) => logs.push({ level, msg }),
    ...overrides,
  } as unknown as RenderPayloadDeps;
}

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
    const deps = depsWith(failed("git status --porcelain -b: timeout"), logs);

    const payload = await buildRenderPayload(
      hookData("/no/such/transcript.jsonl"),
      deps,
      undefined,
      GIT_PATHS,
    );

    expect(payload.git).toBeUndefined();
    expect(logs).toEqual([
      {
        level: "warn",
        msg: "provider fetch failed: git status --porcelain -b: timeout",
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
    );

    expect(payload.tmux).toBeUndefined();
    expect(logs).toHaveLength(1);
    expect(logs[0]!.msg).toContain("tmux:");
    expect(logs[0]!.msg).toContain("stub bug");
  });
});

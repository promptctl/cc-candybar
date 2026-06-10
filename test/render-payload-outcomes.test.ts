// Boundary contract for the outcome-carrying provider lanes (git, cache):
// buildRenderPayload is the ONE log site for their failures, and `absent`
// and `failed` both project as MISSING payload fields — distinct from a real
// 0/"" — so the DSL input fallback chain (default + last_error) fires.
// [LAW:no-silent-failure][LAW:single-enforcer]

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
): RenderPayloadDeps {
  return {
    gitProvider: { getGitInfo: async () => gitOutcome },
    usageStore: {
      getUsageInfo: async () => null,
      getTodayInfo: async () => null,
    },
    contextProvider: { getContextInfo: async () => null },
    metricsProvider: { getMetricsInfo: async () => null },
    tmuxService: { getSessionId: async () => null },
    sessionState: { get: () => undefined },
    log: (level: string, msg: string) => logs.push({ level, msg }),
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

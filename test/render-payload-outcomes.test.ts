// Boundary contract for the provider lanes — every lane carries a typed
// Outcome, and payloadOf collects the failures of the lanes it reads, which a
// request's answer logs (git logs its own refreshes);
// `absent` and `failed` both project as MISSING payload fields — distinct
// from a real 0/"" — so the DSL input fallback chain (default + last_error)
// fires. [LAW:no-silent-failure][LAW:single-enforcer][LAW:one-type-per-behavior]

import { CacheExpiryProvider } from "../src/segments/cache";
import { UNFOLLOWED_FEEDS } from "../src/config/lanes";
import { EMPTY_HISTORY_DEPTH } from "../src/daemon/settings-history";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { prFactOf } from "../src/daemon/render-payload";
import { claudeConfigDir } from "../src/claude-settings";
import type { ClientHints } from "../src/daemon/protocol";
import type { RenderPayloadDeps } from "../src/daemon/render-payload";
import { type EffectiveGlobals } from "../src/config/effective-globals";
import { globalsFor } from "./helpers/selection";
import { VALUED_FIELDS } from "../src/config/globals-fields";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import type { GitInfo, GitInfoOptions, PrState } from "../src/segments/git";
import { ABSENT, PENDING, failed, ok, type Outcome } from "../src/utils/outcome";
import { NO_CONFIG_FILE } from "./helpers/config-file-facts";
import { instantOf } from "../src/utils/instant";
import type { Current } from "../src/utils/reading";
import {
  absentOwners,
  fakeAutoCompact,
  fakeContext,
  fakeGit,
  fakeMetrics,
  fakeTmux,
  fakeUsage,
  requestPayload,
  settled,
} from "./helpers/payload-owners";

type LogEntry = { level: string; msg: string };

function depsWith(
  gitOutcome: Outcome<GitInfo>,
  logs: LogEntry[],
  overrides: Record<string, unknown> = {},
): RenderPayloadDeps {
  return {
    ...absentOwners(),
    gitProvider: fakeGit(async () => gitOutcome),
    usageStore: fakeUsage({
      usage: async () => ABSENT,
      today: () => ABSENT,
    }),
    contextProvider: fakeContext(async () => ABSENT),
    metricsProvider: fakeMetrics(async () => ABSENT),
    tmuxService: fakeTmux(async () => ABSENT),
    log: (level: string, msg: string) => logs.push({ level, msg }),
    history: () => EMPTY_HISTORY_DEPTH,
    navigation: () => 0,
    feeds: () => UNFOLLOWED_FEEDS,
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
const TMUX_PANE = { socket: "/tmp/tmux.sock", pane: "%7", truecolor: null };

const EFFECTIVE_GLOBALS: EffectiveGlobals = globalsFor(DEFAULT_DSL_CONFIG);

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

describe("payloadOf — git outcome lane", () => {
  // A git failure is logged by the refresh that read it (src/daemon/cache/git.ts,
  // test/daemon-git-cache.test.ts): the value is stored, so a payload that
  // logged it would repeat it on every render.
  test("whole-fetch failure: no git key, and the payload logs nothing", async () => {
    const logs: LogEntry[] = [];
    const deps = depsWith(
      failed("git status --porcelain=v2 --branch: timeout"),
      logs,
    );

    const payload = await requestPayload(
      hookData("/no/such/transcript.jsonl"),
      instantOf(new Date()),
      deps,
      undefined,
      GIT_PATHS,
      EFFECTIVE_GLOBALS,
      NO_HINTS,
      NO_CONFIG_FILE,
    );

    expect(payload.git).toBeUndefined();
    expect(logs).toEqual([]);
  });

  test("absent (not a repo): no git key, NOTHING logged", async () => {
    const logs: LogEntry[] = [];
    const deps = depsWith(ABSENT, logs);

    const payload = await requestPayload(
      hookData("/no/such/transcript.jsonl"),
      instantOf(new Date()),
      deps,
      undefined,
      GIT_PATHS,
      EFFECTIVE_GLOBALS,
      NO_HINTS,
      NO_CONFIG_FILE,
    );

    expect(payload.git).toBeUndefined();
    expect(logs).toEqual([]);
  });

  test("per-field failure: field missing, siblings present, nothing logged here", async () => {
    const logs: LogEntry[] = [];
    const deps = depsWith(
      ok({
        branch: "main",
        status: "clean",
        aheadBehind: ok({ ahead: 1, behind: 2 }),
        head: ok("c0ffee"),
        sha: ok("abc1234"),
        stashCount: failed("git stash list: timeout, exit null"),
        upstream: ABSENT,
      }),
      logs,
    );

    const payload = await requestPayload(
      hookData("/no/such/transcript.jsonl"),
      instantOf(new Date()),
      deps,
      undefined,
      GIT_PATHS,
      EFFECTIVE_GLOBALS,
      NO_HINTS,
      NO_CONFIG_FILE,
    );

    // ok fields project as values; the failed field is MISSING (the DSL
    // default + last_error chain fires) — never a fabricated 0.
    expect(payload.git).toEqual({
      branch: "main",
      status: "clean",
      ahead: 1,
      behind: 2,
      sha: "abc1234",
      // Read, and the branch has none.
      tracking: "none",
    });
    expect("stash" in payload.git!).toBe(false);
    // Neither the absent upstream nor the failed stash is logged here: the
    // refresh that read the stash logged it.
    expect(logs).toEqual([]);
  });

  // The git provider stores one GitInfo between reads; the age must move with
  // each draw's instant, not stay frozen at the read.
  test("the commit date is stored as an instant, whatever the render's instant", async () => {
    // [LAW:one-source-of-truth] Its age is the draw's (the bundled
    // git.timeSinceCommit): a payload holding an age would be stale in every
    // frame drawn after the read that built it.
    const committedAt = Date.UTC(2026, 9, 15, 12, 0, 0) / 1000;
    const deps = depsWith(
      ok({
        branch: "main",
        status: "clean",
        aheadBehind: ABSENT,
        head: ok("c0ffee"),
        committedAt: ok(committedAt),
      }),
      [],
    );
    const storedAt = async (secondsLater: number) =>
      (
        settled(
          (
            await requestPayload(
          hookData("/no/such/transcript.jsonl"),
          instantOf(new Date((committedAt + secondsLater) * 1000)),
          deps,
          undefined,
          new Set(["git.committedAt"]),
          EFFECTIVE_GLOBALS,
          NO_HINTS,
          NO_CONFIG_FILE,
            )
          ).git,
        ) as { committedAt?: number } | undefined
      )?.committedAt;

    expect(await storedAt(90.5)).toBe(committedAt);
    expect(await storedAt(3600)).toBe(committedAt);
  });
});

describe("payloadOf — today lane", () => {
  test("asks the usage store for the day of the render's instant", async () => {
    const at = instantOf(new Date(Date.UTC(2031, 0, 2, 12, 0, 0)));
    const asked: unknown[] = [];
    await requestPayload(
      hookData("/no/such/transcript.jsonl"),
      at,
      depsWith(ABSENT, [], {
        usageStore: fakeUsage({
          usage: async () => ABSENT,
          today: (_hook: unknown, _dir: unknown, when: unknown) => {
            asked.push(when);
            return ABSENT;
          },
        }),
      }),
      undefined,
      new Set(["today.cost"]),
      EFFECTIVE_GLOBALS,
      NO_HINTS,
      NO_CONFIG_FILE,
    );
    expect(asked).toEqual([at]);
  });
});

describe("payloadOf — cache outcome lane", () => {
  const CACHE_PATHS = new Set(["cache.expiresAt"]);

  test("unreadable transcript: no cache key, one warn log", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-payload-cache-"));
    const transcript = join(dir, "transcript.jsonl");
    writeFileSync(transcript, "{}\n");
    chmodSync(transcript, 0o000);

    const logs: LogEntry[] = [];
    // The owner logs the refresh that failed, once, as the daemon's does.
    const deps = depsWith(ABSENT, logs, {
      cacheExpiry: new CacheExpiryProvider((level, msg) =>
        logs.push({ level, msg }),
      ),
    });
    const payload = await requestPayload(
      hookData(transcript),
      instantOf(new Date()),
      deps,
      undefined,
      CACHE_PATHS,
      EFFECTIVE_GLOBALS,
      NO_HINTS,
      NO_CONFIG_FILE,
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
    const payload = await requestPayload(
      hookData(transcript),
      instantOf(new Date()),
      deps,
      undefined,
      CACHE_PATHS,
      EFFECTIVE_GLOBALS,
      NO_HINTS,
      NO_CONFIG_FILE,
    );

    expect(payload.cache).toEqual({
      expiresAt: Math.floor(Date.parse(ts) / 1000) + 3600,
    });
    expect(logs).toEqual([]);
  });
});

// The five lanes migrated after PR #96 (session/today/context/metrics/tmux)
// share the exact same contract as git/cache — one behavior, one type.
describe("payloadOf — migrated lanes share the outcome contract", () => {
  const LANE_PATHS = new Set([
    "session.cost",
    "today.cost",
    "context.totalTokens",
    "metrics.messageCount",
    "tmux.session",
  ]);

  // [LAW:no-silent-failure] A failed lane was logged by the refresh that
  // failed, its owner's (these stubs stand in for owners); the payload
  // derived from it logs nothing again.
  test("failed lanes project as missing fields, and the payload logs none of them", async () => {
    const logs: LogEntry[] = [];
    const deps = depsWith(ABSENT, logs, {
      contextProvider: fakeContext(async () =>
        failed("context transcript: EACCES"),
      ),
      metricsProvider: fakeMetrics(async () => failed("metrics (s): boom")),
    });

    const payload = await requestPayload(
      hookData("/no/such/transcript.jsonl"),
      instantOf(new Date()),
      deps,
      undefined,
      LANE_PATHS,
      EFFECTIVE_GLOBALS,
      NO_HINTS,
      NO_CONFIG_FILE,
    );

    expect(payload.context).toBeUndefined();
    expect(payload.metrics).toBeUndefined();
    expect(logs).toEqual([]);
  });

  test("ok lanes project values; absent lanes are missing with nothing logged", async () => {
    const logs: LogEntry[] = [];
    const deps = depsWith(ABSENT, logs, {
      tmuxService: fakeTmux(async () => ok("main-session")),
      usageStore: fakeUsage({
        usage: async () =>
          ok({
            session: {
              cost: 1.25,
              calculatedCost: 1.25,
              officialCost: null,
              tokens: 42,
              tokenBreakdown: null,
            },
          }),
        today: () => ABSENT,
      }),
    });

    const payload = await requestPayload(
      hookData("/no/such/transcript.jsonl"),
      instantOf(new Date()),
      deps,
      undefined,
      LANE_PATHS,
      EFFECTIVE_GLOBALS,
      { tmux: TMUX_PANE },
      NO_CONFIG_FILE,
    );

    expect(payload.tmux).toEqual({ pane: "%7", session: "main-session" });
    expect(payload.session).toEqual({ cost: 1.25, tokens: 42 });
    expect(payload.today).toBeUndefined();
    expect(logs).toEqual([]);
  });

  test("a lane stub that THROWS is totalized to failed and logged with its lane name", async () => {
    const logs: LogEntry[] = [];
    const deps = depsWith(ABSENT, logs, {
      contextProvider: fakeContext(async () => {
        throw new Error("stub bug");
      }),
      tmuxService: fakeTmux(async () => failed("no server")),
    });

    const payload = await requestPayload(
      hookData("/no/such/transcript.jsonl"),
      instantOf(new Date()),
      deps,
      undefined,
      LANE_PATHS,
      EFFECTIVE_GLOBALS,
      { tmux: TMUX_PANE },
      NO_CONFIG_FILE,
    );

    expect(payload.context).toBeUndefined();
    // The pane is the client's report and survives the failed name lookup,
    // whose failure its owner logged when the refresh failed: the render
    // logs only the throw, where it was caught.
    expect(payload.tmux).toEqual({ pane: "%7" });
    expect(logs.map((l) => l.level)).toEqual(["error"]);
    expect(logs[0]!.msg).toContain("context lane threw: Error: stub bug");
  });

  // brandon-tmux-tk7: the tmux family is the session's own client hint. With
  // no pane reported the service is never asked, whatever it would answer —
  // the daemon's own tmux is not this session's.
  test.each<[string, ClientHints]>([
    ["not in tmux", { tmux: null }],
    ["a client too old to say", NO_HINTS],
  ])("%s: no tmux family, and tmux is not asked", async (_name, hints) => {
    const logs: LogEntry[] = [];
    let asked = 0;
    const deps = depsWith(ABSENT, logs, {
      tmuxService: fakeTmux(async () => {
        asked++;
        return ok("the-daemons-own-session");
      }),
    });

    const payload = await requestPayload(
      hookData("/no/such/transcript.jsonl"),
      instantOf(new Date()),
      deps,
      undefined,
      LANE_PATHS,
      EFFECTIVE_GLOBALS,
      hints,
      NO_CONFIG_FILE,
    );

    expect(payload.tmux).toBeUndefined();
    expect(asked).toBe(0);
    expect(logs).toEqual([]);
  });

  test("the pane the client reported is the pane tmux is asked about", async () => {
    const asked: unknown[] = [];
    const deps = depsWith(ABSENT, [], {
      tmuxService: fakeTmux(async (_holds: unknown, hint: unknown) => {
        asked.push(hint);
        return ABSENT;
      }),
    });

    await requestPayload(
      hookData("/no/such/transcript.jsonl"),
      instantOf(new Date()),
      deps,
      undefined,
      LANE_PATHS,
      EFFECTIVE_GLOBALS,
      { tmux: TMUX_PANE },
      NO_CONFIG_FILE,
    );

    expect(asked).toEqual([TMUX_PANE]);
  });
});

// [LAW:one-source-of-truth] candybar-config-engine-71o.3: style/
// colorCompatibility/autoWrap/padding are style's twins — this pins
// that payloadOf projects the EffectiveGlobals struct into the
// payload verbatim (no name typo, no dropped field, unconditionally present
// with no `wants` gate — unlike theme/style, which drawDsl produces).
describe("payloadOf — effective globals projection", () => {
  test("every template-facing EffectiveGlobals field lands under its own *.effective payload key, unconditionally; the two drawDsl-produced fields have none", async () => {
    // The bundled default's globals with every kind of valued field moved
    // off its floor: a word, a flag, an integer, a config-only depth, a lane.
    const effective: EffectiveGlobals = {
      ...globalsFor(DEFAULT_DSL_CONFIG),
      presetCustomized: true,
      endcaps: "capsule",
      variation: "mono",
      shade: "muted",
      colorCompatibility: "256",
      autoWrap: false,
      padding: 3,
      experimentalPane: true,
    };
    const logs: LogEntry[] = [];
    const payload = await requestPayload(
      hookData("/no/such/transcript.jsonl"),
      instantOf(new Date()),
      depsWith(ABSENT, logs),
      undefined,
      new Set(), // no provider lane needed for this projection
      effective,
      NO_HINTS,
      NO_CONFIG_FILE,
    );
    // `theme` and `style` are the two fields this projection does NOT carry:
    // drawDsl injects both `.effective` values, because under a RULE in that
    // globals slot it is the only thing that knows the answer (brandon-looks-pe6
    // for `style`, brandon-themes-dzl for `theme`). Asserted absent rather than
    // left unmentioned, so re-adding a second producer fails here.
    expect("theme" in payload).toBe(false);
    expect("style" in payload).toBe(false);
    expect("effect" in payload).toBe(false);
    expect(payload.preset).toEqual({
      effective: "default",
      customized: true,
      bundled: true,
    });
    for (const field of VALUED_FIELDS) {
      expect(payload[field]).toEqual({ effective: effective[field] });
    }
    expect(payload.endcaps).toEqual({ effective: "capsule" });
    expect(payload.padding).toEqual({ effective: 3 });
    expect(payload.experimentalPane).toEqual({ effective: true });
    // `updateNotice` gates the notice channel AND labels its settings-menu
    // toggle; `separator` only feeds the joiner, and no template reads it.
    expect(payload.updateNotice).toEqual({ effective: true });
    expect(payload).not.toHaveProperty("separator");
  });
});

describe("payloadOf — git PR projection", () => {
  // [LAW:no-silent-failure] The PR field is the one git field whose `failed`
  // does NOT collapse to a missing key: it surfaces as `prError` (a visible
  // render value) AND logs, so a forge outage is distinct from "no PR".
  const PR_PATHS = new Set([
    "git.branch",
    "git.prNumber",
    "git.prState",
    "git.prUrl",
    "git.prError",
    "git.prEarlier",
  ]);

  test("open PR (ok) → prNumber/prState/prUrl projected, nothing logged", async () => {
    const logs: LogEntry[] = [];
    const deps = depsWith(
      ok({
        branch: "feature",
        status: "clean",
        aheadBehind: ABSENT,
        head: ok("c0ffee"),
        pullRequest: ok({
          number: 76,
          state: "open",
          url: "https://github.com/x/y/pull/76",
          head: "c0ffee",
        }),
      }),
      logs,
    );

    const payload = await requestPayload(
      hookData("/no/such/transcript.jsonl"),
      instantOf(new Date()),
      deps,
      undefined,
      PR_PATHS,
      EFFECTIVE_GLOBALS,
      NO_HINTS,
      NO_CONFIG_FILE,
    );

    expect(payload.git).toMatchObject({
      prNumber: 76,
      prState: "open",
      prUrl: "https://github.com/x/y/pull/76",
    });
    expect("prError" in payload.git!).toBe(false);
    expect(logs).toEqual([]);
  });

  // A branch name reused after its PR concluded: HEAD moved off the PR's
  // head, or is unborn on the reused name. The branch has no PR; the forge's
  // older one is kept as its state alone.
  test.each<[PrState, Outcome<string>]>([
    ["merged", ok("c0ffee")],
    ["closed", ok("c0ffee")],
    ["merged", ABSENT],
  ])(
    "a %s PR whose head is not HEAD (%j) → only prEarlier",
    async (state, head) => {
      const logs: LogEntry[] = [];
      const deps = depsWith(
        ok({
          branch: "feature",
          status: "clean",
          aheadBehind: ABSENT,
          head,
          pullRequest: ok({
            number: 76,
            state,
            url: "https://github.com/x/y/pull/76",
            head: "0ld0id",
          }),
        }),
        logs,
      );

      const payload = await requestPayload(
        hookData("/no/such/transcript.jsonl"),
        instantOf(new Date()),
        deps,
        undefined,
        PR_PATHS,
        EFFECTIVE_GLOBALS,
        NO_HINTS,
        NO_CONFIG_FILE,
      );

      expect(payload.git).toEqual({
        branch: "feature",
        status: "clean",
        prEarlier: state,
      });
      expect(prFactOf(payload.git, true)).toBe(`earlier-${state}`);
      expect(logs).toEqual([]);
    },
  );

  test("a render reading no PR has no PR fact, whatever git's state", () => {
    expect(prFactOf(PENDING, false)).toBe("-");
    expect(prFactOf(PENDING, true)).toBe("pending");
  });

  test("a layout reading only git.prEarlier still asks the forge", async () => {
    const asked: GitInfoOptions[] = [];
    const deps = depsWith(ABSENT, [], {
      ...absentOwners(),
      gitProvider: fakeGit(
        async (_holds: unknown, _dir: string, options: GitInfoOptions) => {
          asked.push(options);
          return ABSENT;
        },
      ),
    });

    await requestPayload(
      hookData("/no/such/transcript.jsonl"),
      instantOf(new Date()),
      deps,
      "/repo",
      new Set(["git.prEarlier"]),
      EFFECTIVE_GLOBALS,
      NO_HINTS,
      NO_CONFIG_FILE,
    );

    expect(asked).toEqual([expect.objectContaining({ showPullRequest: true })]);
  });

  test("lookup failed → prError surfaced (visible, distinct); the lookup logged it", async () => {
    const logs: LogEntry[] = [];
    const deps = depsWith(
      ok({
        branch: "feature",
        status: "clean",
        aheadBehind: ABSENT,
        head: ok("c0ffee"),
        pullRequest: failed("gh pr view: non-zero, exit 1, HTTP 401"),
      }),
      logs,
    );

    const payload = await requestPayload(
      hookData("/no/such/transcript.jsonl"),
      instantOf(new Date()),
      deps,
      undefined,
      PR_PATHS,
      EFFECTIVE_GLOBALS,
      NO_HINTS,
      NO_CONFIG_FILE,
    );

    expect(settled(payload.git)!.prError).toBe("gh pr view: non-zero, exit 1, HTTP 401");
    expect("prNumber" in payload.git!).toBe(false);
    expect("prUrl" in payload.git!).toBe(false);
    expect(logs).toEqual([]);
  });

  test("no PR (absent) → no pr* fields, nothing logged", async () => {
    const logs: LogEntry[] = [];
    const deps = depsWith(
      ok({
        branch: "feature",
        status: "clean",
        aheadBehind: ABSENT,
        head: ok("c0ffee"),
        pullRequest: ABSENT,
      }),
      logs,
    );

    const payload = await requestPayload(
      hookData("/no/such/transcript.jsonl"),
      instantOf(new Date()),
      deps,
      undefined,
      PR_PATHS,
      EFFECTIVE_GLOBALS,
      NO_HINTS,
      NO_CONFIG_FILE,
    );

    expect("prNumber" in payload.git!).toBe(false);
    expect("prUrl" in payload.git!).toBe(false);
    expect("prError" in payload.git!).toBe(false);
    expect(logs).toEqual([]);
  });
});

// brandon-context-ceiling-xta.e3p: the autocompact lane reads the settings file
// of the Claude Code directory THIS render's client reported — never the
// daemon's own env — and its refusal is carried into the payload as text the
// segment shows. The refusal is logged by its owner, once per read that
// failed (test/autocompact-provider.test.ts), never by the render.
describe("payloadOf — autocompact lane", () => {
  const AUTOCOMPACT_PATHS = new Set(["autocompact.window"]);
  const run = async (
    read: Outcome<number | "auto">,
    hints: ClientHints,
    logs: LogEntry[],
  ) => {
    const asked: string[] = [];
    const deps = depsWith(ABSENT, logs, {
      autoCompact: fakeAutoCompact((settingsPath: string) => {
        asked.push(settingsPath);
        return read;
      }),
    });
    const payload = await requestPayload(
      hookData("/no/such/transcript.jsonl"),
      instantOf(new Date()),
      deps,
      undefined,
      AUTOCOMPACT_PATHS,
      EFFECTIVE_GLOBALS,
      hints,
      NO_CONFIG_FILE,
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
      autoCompact: fakeAutoCompact(() => ok(800_000)),
      contextProvider: fakeContext(async () =>
        ok({ totalTokens: 1, maxTokens: 200_000, contextLeftPercentage: 99 }),
      ),
    });
    const payload = await requestPayload(
      hookData("/no/such/transcript.jsonl"),
      instantOf(new Date()),
      deps,
      undefined,
      AUTOCOMPACT_PATHS,
      EFFECTIVE_GLOBALS,
      NO_HINTS,
      NO_CONFIG_FILE,
    );
    expect(payload.autocompact).toEqual({
      window: 800_000,
      applied: 200_000,
      lower: 100_000,
      higher: 0,
    });
  });

  // A provider that throws before it returns a promise is the lane's to
  // catch too: the render still builds, and the throw is logged.
  test("a provider that throws at once: failed in the payload, and logged", async () => {
    const logs: LogEntry[] = [];
    const deps = depsWith(ABSENT, logs, {
      autoCompact: fakeAutoCompact(() => {
        throw new Error("stub bug");
      }),
    });
    const payload = await requestPayload(
      hookData("/no/such/transcript.jsonl"),
      instantOf(new Date()),
      deps,
      undefined,
      AUTOCOMPACT_PATHS,
      EFFECTIVE_GLOBALS,
      NO_HINTS,
      NO_CONFIG_FILE,
    );
    expect(payload.autocompact).toEqual({
      error: "autocompact: Error: stub bug",
    });
    expect(logs).toHaveLength(1);
    expect(logs[0]!.level).toBe("error");
    expect(logs[0]!.msg).toContain("autocompact lane threw: Error: stub bug");
  });

  test("a refused read: the reason in the payload, and no log of it from the render", async () => {
    const logs: LogEntry[] = [];
    const { payload } = await run(
      failed("cannot read /c/settings.json: nope"),
      {},
      logs,
    );
    expect(payload.autocompact).toEqual({
      error: "cannot read /c/settings.json: nope",
    });
    expect(logs).toEqual([]);
  });
});

// brandon-client-hints-7ua: the today lane answers for the Claude Code THIS
// render's client runs under — its config directory — never the daemon's env.
describe("payloadOf — the lanes that read a session's Claude Code", () => {
  const run = async (paths: string[], hints: ClientHints) => {
    const seeded: unknown[] = [];
    const deps = depsWith(ABSENT, [], {
      usageStore: fakeUsage({
        usage: async () => ABSENT,
        today: (_hook: unknown, claudeConfigDir: unknown) => {
          seeded.push(claudeConfigDir);
          return ABSENT;
        },
      }),
    });
    await requestPayload(
      hookData("/no/such/transcript.jsonl"),
      instantOf(new Date()),
      deps,
      undefined,
      new Set(paths),
      EFFECTIVE_GLOBALS,
      hints,
      NO_CONFIG_FILE,
    );
    return { seeded };
  };

  test("today seeds the client's directory", async () => {
    const zai = await run(["today.cost"], {
      claudeConfigDir: "/home/u/.claude.zai",
    });
    expect(zai.seeded).toEqual(["/home/u/.claude.zai"]);
    expect((await run(["today.cost"], NO_HINTS)).seeded).toEqual([undefined]);
  });
});

// brandon-menu-ia-q30.ge5: the facts behind the menu's `⎘ resume` and
// `↗ config` — the config file's path rides the payload exactly while the
// session renders from one, and the resume command carries the session's
// configuration directory from the client's hint.
describe("payloadOf — config file and resume command", () => {
  const build = (configPath: string | null, hints: typeof NO_HINTS) =>
    requestPayload(
      hookData("/no/such/transcript.jsonl"),
      instantOf(new Date()),
      depsWith(ABSENT, []),
      undefined,
      new Set(),
      EFFECTIVE_GLOBALS,
      hints,
      { ...NO_CONFIG_FILE, configPath },
    );

  test("a config file's path is present; the bundled default's is absent", async () => {
    expect((await build("/c/config.json5", NO_HINTS)).configPath).toBe(
      "/c/config.json5",
    );
    expect("configPath" in (await build(null, NO_HINTS))).toBe(false);
  });

  test("the resume command resumes this session under its config dir", async () => {
    expect((await build(null, NO_HINTS)).resumeCommand).toBe(
      "cd /tmp && claude --resume test-session",
    );
    expect(
      (await build(null, { ...NO_HINTS, claudeConfigDir: "/c/.claude" }))
        .resumeCommand,
    ).toBe(
      "cd /tmp && CLAUDE_CONFIG_DIR=/c/.claude claude --resume test-session",
    );
  });

  test("a hook with no added_dirs resumes with none rather than failing", async () => {
    const { added_dirs: _, ...workspace } = hookData("/x").workspace;
    const payload = await requestPayload(
      { ...hookData("/no/such/transcript.jsonl"), workspace },
      instantOf(new Date()),
      depsWith(ABSENT, []),
      undefined,
      new Set(),
      EFFECTIVE_GLOBALS,
      NO_HINTS,
      NO_CONFIG_FILE,
    );
    expect(payload.resumeCommand).toBe(
      "cd /tmp && claude --resume test-session",
    );
  });
});

// A request waits only for first answers. A value the daemon itself made
// stale (a click's move) may take as long as the program the click ran, so a
// request after it draws the loading cell at once rather than waiting out its
// deadline.
describe("settlePayload — what a request waits on", () => {
  test("a superseded lane is not waited on: the request after a click draws it pending at once", async () => {
    let current: Current<string> = {
      kind: "pending",
      why: "unread",
      landed: Promise.resolve().then(() => {
        current = ok("work");
      }),
    };
    const deps = depsWith(ABSENT, [], {
      tmuxService: { declare: () => ({ current: () => current }) },
    });
    const request = () =>
      requestPayload(
        hookData("/no/such/transcript.jsonl"),
        instantOf(new Date()),
        deps,
        undefined,
        new Set(["tmux.session"]),
        EFFECTIVE_GLOBALS,
        { tmux: { socket: "/s", pane: "%7", truecolor: null } },
        NO_CONFIG_FILE,
      );
    // The key's first read is waited on.
    expect((await request()).tmux).toEqual({ pane: "%7", session: "work" });
    // A click supersedes it with a read that never lands; the request draws at
    // once. Any lane stands in: the wait asks why a lane is pending, never
    // which lane it is, and the owners that supersede pin their own state
    // (keyed-source, managed-storage and run-action tests).
    current = { kind: "pending", why: "superseded", landed: new Promise(() => {}) };
    expect((await request()).tmux).toEqual({ pane: "%7", session: PENDING });
  });
});

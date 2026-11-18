// The one faked Claude Code session `check` draws: the hook its client sends,
// the hints beside it, and the owners every reading of it comes from. The
// collector stamps its world state from these owners as the daemon's stamps
// one from the real providers, so `check` draws the session through the
// daemon's own path.
//
// [LAW:verifiable-goals] It is deliberately RICH (dirty git with every
// worktree count, an upstream, a stash, a recent commit; live session, today,
// context, metrics and rate-limit data; tmux and ssh) so gated segments
// actually RENDER their content instead of gating off. A minimal session would
// let a field-name typo in the git, directory, metrics or budget branches slip
// through: those branches only run when their data is present.
//
// test/example-configs.test.ts asserts rendered content against these literal
// values (780s → "◷ 13m", cost $0.39, version 1.15.0, …); changing one here
// fails that suite loudly rather than drifting silently.

import type { ClientHints } from "./daemon/foundations/protocol.js";
import type { SessionId } from "./daemon/foundations/session-id.js";
import type { Lanes, RenderPayloadDeps } from "./daemon/readings.js";
import type { SourceRuns } from "./daemon/source-runs.js";
import type { DaySums } from "./daemon/cache/session-usage-store.js";
import { oneDay } from "./daemon/foundations/today-facts.js";
import type { CheckedHookData } from "./renderer-interface/request-context.js";
import type { GitInfo } from "./segments/git.js";
import type { TranscriptUsage } from "./segments/session.js";
import type { MetricsFold } from "./segments/metrics.js";
import type { AutoCompactWindow } from "./segments/autocompact.js";
import { IDLE, type DaemonFacts } from "./facts/world-state.js";
import type { Instant } from "./utils/instant.js";
import { ABSENT, ok } from "./utils/outcome.js";
import { settledLane } from "./utils/reading.js";
import type { DaemonLogger } from "./utils/logger.js";
import type { Locate } from "./daemon/statusline-answer.js";

// The hints the fixture's client sends: in tmux pane `%0`, and `ssh: true` for
// the same reason `tmux.session` is populated — this fixture deliberately
// satisfies every gate so a when-gated segment RENDERS and its template gets
// checked. A local-looking fixture would gate the host segment off and let a
// typo inside it ship.
export const CHECK_HINTS = {
  tmux: { socket: "/tmp/tmux.sock", pane: "%0", truecolor: null },
  ssh: true,
} as const satisfies ClientHints;

// The faked session's home. Not the user's: a directory segment abbreviates a
// path by what is on disk there, so a real home draws a different bar on every
// machine. The config is still discovered from the user's own home.
export const CHECK_HOME = "/home/tester";

// Where the faked session's directory sits: the `src` of the main checkout
// its git lane answers for. The disk has no such checkout, so the host's own
// read would put a repository's git state in a directory with no repository.
export const checkLocate: Locate = () => ({
  main: `${CHECK_HOME}/code/cc-candybar`,
  worktree: "",
  subpath: "/src",
  noRepo: false,
});

// The hook the fixture's client sends for `session`, from a checkout under
// the fixture's home, with its project at `projectDir`: the directory the
// config is discovered from, which the request's origin names.
export function checkHook(
  at: Instant,
  session: SessionId,
  projectDir: string,
): CheckedHookData {
  const nowSec = Math.floor(at);
  return {
    hook_event_name: "Status",
    session_id: session,
    version: "1.15.0",
    cwd: `${CHECK_HOME}/code/cc-candybar/src`,
    transcript_path: `${CHECK_HOME}/.claude/projects/x/test.jsonl`,
    model: { id: "claude-opus-4-8", display_name: "Opus 4.8" },
    // An effort level, so the model cell draws its effort gauge and gets that
    // template checked. Not max: max climbs a frame a second, and `check`
    // renders at the wall clock, so its bar (and every doc fence pinned to
    // it) would change from one second to the next. Every level computes
    // max's bubble, so xhigh evaluates it too.
    effort: { level: "xhigh" },
    workspace: {
      current_dir: `${CHECK_HOME}/code/cc-candybar/src`,
      project_dir: projectDir,
      added_dirs: [],
    },
    // The hook's instantaneous fields the payload lays over the document's
    // transcript folds: the session's cost, durations and lines, and the
    // native context window.
    cost: {
      total_cost_usd: 0.39,
      total_duration_ms: 930_000,
      total_api_duration_ms: 4_200,
      total_lines_added: 512,
      total_lines_removed: 88,
    },
    context_window: {
      total_input_tokens: 241_400,
      total_output_tokens: 0,
      context_window_size: 1_000_000,
      used_percentage: 76,
      remaining_percentage: 24,
      current_usage: {
        input_tokens: 48_487,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
    rate_limits: {
      five_hour: { used_percentage: 63, resets_at: nowSec + 2 * 3600 },
      seven_day: { used_percentage: 21, resets_at: nowSec + 5 * 86400 },
    },
  };
}

// What every owner answers for the fixture's session at `at`, each in the
// type the owner gives it.
export function checkLanes(at: Instant) {
  const nowSec = Math.floor(at);
  return {
    git: ok<GitInfo>({
      branch: "main",
      status: "dirty",
      aheadBehind: ok({ ahead: 2, behind: 1 }),
      head: ok("abc1234def5678"),
      workingTree: { staged: 3, unstaged: 2, untracked: 1, conflicts: 0 },
      sha: ok("abc1234"),
      operation: ok("rebase"),
      committedAt: ok(nowSec - 780),
      stashCount: ok(1),
      upstream: ok("origin/main"),
      repoName: ok("cc-candybar"),
      repoUrl: ok("https://github.com/promptctl/cc-candybar"),
      // A branch with no PR: no PR keys.
      pullRequest: ABSENT,
    }),
    usage: ok<TranscriptUsage>({
      calculatedCost: 0.39,
      tokens: 241400,
      tokenBreakdown: null,
    }),
    context: ok(48487),
    metrics: ok<MetricsFold>({
      lastResponseTime: 8.2,
      messageCount: 8,
      nonPrompts: 0,
    }),
    activity: ABSENT,
    tmuxSession: ok("work"),
    hostName: ok("tester-box"),
    hostUser: ok("tester"),
    cache: ok(nowSec + 15 * 60),
    speed: ABSENT,
    // A set window with a step each way, so the when-gated `autocompact`
    // control renders all of its cells.
    autoCompact: ok<AutoCompactWindow>(400_000),
  } satisfies Omit<Lanes, "sources" | "runs" | "env" | "doctor">;
}

// [LAW:one-source-of-truth] One day's sums, which the draw projects to its own
// day as the daemon's draw does.
export function checkDay(at: Instant): DaySums {
  return { roots: [], sums: oneDay(at, 12.5, 3_400_000) };
}

// The daemon's own facts as a command holds them: no update offered, no
// file-events, launcher, renderer or act fault.
export function checkDaemonFacts(at: Instant): DaemonFacts {
  return {
    update: { newer: { ...ABSENT, at }, act: IDLE, actsError: null },
    fileEvents: [],
    launcher: [],
    rendererEnded: null,
    actFailed: null,
  };
}

// [LAW:types-are-the-program] The owners of the fixture's session, typed as
// the collector reads the daemon's, so an owner the payload comes to need is a
// compile error here until the fixture answers it. Each answers its lane's
// value at once. A plugin's data source reads absent, as a session's does
// before its program first writes: `check` runs no plugin program, so a
// segment gated on `hasKey` is hidden, and an unguarded read fails the check
// with the missing-field error that session's bar would draw. Shell and file
// sources run for real, through `sourceRuns`.
export function checkOwners(
  at: Instant,
  sourceRuns: Pick<SourceRuns, "declare">,
  log: DaemonLogger,
): RenderPayloadDeps {
  const lanes = checkLanes(at);
  return {
    home: CHECK_HOME,
    gitProvider: { declare: () => settledLane(lanes.git) },
    usageStore: {
      usageOf: () => lanes.usage,
      speedOf: () => lanes.speed,
      declareToday: () => settledLane(ok(checkDay(at))),
      daysOutside: () => ABSENT,
    },
    contextProvider: { tokensOf: () => lanes.context },
    metricsProvider: { foldOf: () => lanes.metrics },
    activityProvider: { activityOf: () => lanes.activity },
    tmuxService: { declare: () => settledLane(lanes.tmuxSession) },
    managedStorage: { declare: () => settledLane(ABSENT) },
    sourceRuns,
    // [LAW:no-silent-failure] Nothing `check` draws asks the doctor; a draw
    // that does fails its lane, naming why.
    doctor: {
      declare: () => {
        throw new Error("check asks no doctor");
      },
    },
    autoCompact: { stored: () => lanes.autoCompact },
    cacheExpiry: { expiryOf: () => lanes.cache },
    hostService: {
      declareName: () => settledLane(lanes.hostName),
      declareUser: () => settledLane(lanes.hostUser),
    },
    // Every transcript lane answers above, so the trigger has nothing to
    // read.
    transcriptLanes: { declare: () => settledLane(ok(null)) },
    log,
    faults: { of: () => undefined },
  };
}

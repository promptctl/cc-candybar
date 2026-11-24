// A sample Claude Code session with populated git, transcript, and rate-limit data.
import type { ClientHints } from "../../../src/daemon/foundations/protocol.js";
import type { SessionId } from "../../../src/daemon/foundations/session-id.js";
import type { Lanes } from "../../../src/daemon/readings.js";
import type { DaySums } from "../../../src/daemon/cache/session-usage-store.js";
import { oneDay } from "../../../src/daemon/foundations/today-facts.js";
import type { CheckedHookData } from "../../../src/renderer-interface/request-context.js";
import type { GitInfo } from "../../../src/segments/git.js";
import type { TranscriptUsage } from "../../../src/segments/session.js";
import type { MetricsFold } from "../../../src/segments/metrics.js";
import type { AutoCompactWindow } from "../../../src/segments/autocompact.js";
import type { Instant } from "../../../src/utils/instant.js";
import { ABSENT, ok } from "../../../src/utils/outcome.js";

// The hints the fixture's client sends: in tmux pane `%0`, and `ssh: true` for
// the same reason `tmux.session` is populated — this fixture deliberately
// satisfies every gate so a when-gated segment RENDERS and its template gets
// checked. A local-looking fixture would gate the host segment off and let a
// typo inside it ship.
export const SAMPLE_HINTS = {
  tmux: { socket: "/tmp/tmux.sock", pane: "%0", truecolor: null },
  ssh: true,
} as const satisfies ClientHints;

// [LAW:verifiable-goals] The faked session's home. Not the user's: a directory segment abbreviates a
// path by what is on disk there, so a real home draws a different bar on every
// machine. The config is still discovered from the user's own home.
export const SAMPLE_HOME = "/home/tester";

// The hook the fixture's client sends for `session`, from a checkout under
// the fixture's home, with its project at `projectDir`: the directory the
// config is discovered from, which the request's origin names.
export function sampleHook(
  at: Instant,
  session: SessionId,
  projectDir: string,
): CheckedHookData {
  const nowSec = Math.floor(at);
  return {
    hook_event_name: "Status",
    session_id: session,
    version: "1.15.0",
    cwd: `${SAMPLE_HOME}/code/cc-candybar/src`,
    transcript_path: `${SAMPLE_HOME}/.claude/projects/x/test.jsonl`,
    model: { id: "claude-opus-4-8", display_name: "Opus 4.8" },
    // An effort level, so the model cell draws its effort gauge and gets that
    // template checked. Max climbs a frame a second and
    // the clock advances during a test. The bar (and every doc fence pinned to
    // it) would change from one second to the next. Every level computes
    // max's bubble, so xhigh evaluates it too.
    effort: { level: "xhigh" },
    workspace: {
      current_dir: `${SAMPLE_HOME}/code/cc-candybar/src`,
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
export function sampleLanes(at: Instant) {
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
  } satisfies Omit<Lanes, "sources" | "runs" | "env">;
}

// [LAW:one-source-of-truth] One day's sums, which the draw projects to its own
// day as the daemon's draw does.
export function sampleDay(at: Instant): DaySums {
  return { roots: [], sums: oneDay(at, 12.5, 3_400_000) };
}

// [LAW:single-enforcer] The single place where the daemon assembles every
// data field the DSL templates can read. The output of this function — the
// `RenderPayload` — is fed verbatim to `registry.applyInput(...)`, and every
// `kind: "input"` variable in the default DSL config resolves its `path`
// against exactly this shape.
//
// [LAW:dataflow-not-control-flow] Variability lives in the values flowing
// through here, not in whether providers run. Every render fetches every
// segment's data; the providers themselves cache so redundant fetches are
// cheap. The DSL templates use `when` predicates and inline guards on the
// values (e.g. `{{ if ne .git.branch "" }}`) to decide what renders — never
// in whether the daemon computes a value.
//
// [LAW:one-source-of-truth] `RenderPayload` is the contract between the
// daemon's data-provider fleet and the DSL config's input declarations. The
// default config in `src/config/default-dsl-config.ts` declares input paths
// that mirror this shape; user configs MUST agree (a path that doesn't
// resolve falls back to the variable's declared default).

import type { ClaudeHookData } from "../utils/claude.js";
import type { GitInfo } from "../segments/git.js";
import type { UsageProvider } from "../segments/session.js";
import type { TodayProvider } from "../segments/today.js";
import type { ContextProvider } from "../segments/context.js";
import type { MetricsProvider } from "../segments/metrics.js";
import type { BlockProvider } from "../segments/block.js";
import type { TmuxService } from "../segments/tmux.js";
import type { GitDataProvider } from "./cache/git.js";
import type { SessionStateRW } from "./session-state.js";

// ─── Augmented payload shape ─────────────────────────────────────────────────

// [LAW:types-are-the-program] The RenderPayload extends ClaudeHookData with
// daemon-computed fields. The new keys are all OPTIONAL on the type because
// individual provider failures (no transcript, no git repo, no tmux) leave
// their slots null/missing — and the DSL templates handle absence via
// `when`/inline guards, never by branching in this code.
export interface RenderPayload extends ClaudeHookData {
  // env-style values surfaced as paths so the DSL can read them via `input`
  // alongside the rest of the payload. (`kind: "env"` is also available for
  // arbitrary env-var lookups in user configs.)
  readonly home?: string;

  // ─── Daemon-computed augmentations ───────────────────────────────────────
  // The provider's null/absent return becomes a missing field; the DSL's
  // input-var fallback chain fills in the default.

  readonly git?: GitPayload;
  readonly tmux?: { readonly session: string };
  readonly theme?: string;

  // Usage-family. Each provider returns null when it has no data (no
  // transcript yet, no rate-limit window active, etc.); we drop the field
  // rather than emit zeros, so an unconfigured user sees their declared
  // `default` (typically 0 for number, "" for string).
  readonly session?: SessionPayload;
  readonly today?: TodayPayload;
  readonly block?: BlockPayload;
  readonly weekly?: WeeklyPayload;
  readonly context?: ContextPayload;
  readonly metrics?: MetricsPayload;
}

// Flattened projection of GitInfo: every field shape the parity bindings
// reference. Optional fields project to defaulted scalars at this boundary so
// the DSL input path always lands on a value of the declared type.
export interface GitPayload {
  readonly repoName: string;
  readonly branch: string;
  readonly sha: string;
  readonly ahead: number;
  readonly behind: number;
  readonly staged: number;
  readonly unstaged: number;
  readonly untracked: number;
  readonly conflicts: number;
  readonly upstream: string;
  readonly stash: number;
  readonly status: string;
}

export interface SessionPayload {
  readonly cost: number;
  readonly tokens: number;
}

export interface TodayPayload {
  readonly cost: number;
  readonly tokens: number;
}

export interface BlockPayload {
  readonly nativeUtilization: number;
  readonly resetsAt: number;
}

export interface WeeklyPayload {
  readonly percentage: number;
  readonly resetsAt: number;
}

export interface ContextPayload {
  readonly totalTokens: number;
  readonly contextLeft: number;
}

export interface MetricsPayload {
  readonly lastResponseTime: number;
  readonly responseTime: number;
  readonly sessionDuration: number;
  readonly messageCount: number;
  readonly linesAdded: number;
  readonly linesRemoved: number;
}

// ─── Provider dependencies ────────────────────────────────────────────────────

export interface RenderPayloadDeps {
  readonly gitProvider: GitDataProvider;
  readonly usageProvider: UsageProvider;
  readonly todayProvider: TodayProvider;
  readonly contextProvider: ContextProvider;
  readonly metricsProvider: MetricsProvider;
  readonly blockProvider: BlockProvider;
  readonly tmuxService: TmuxService;
  readonly sessionState: SessionStateRW;
}

// ─── Builder ─────────────────────────────────────────────────────────────────

// Autocompact buffer used by the context provider. Hardcoded here because the
// DSL config has no equivalent of the legacy `context.autocompactBuffer` knob
// — if a user needs a different value, they configure the context segment's
// template to compute differently. Matches the legacy default.
const DEFAULT_AUTOCOMPACT_BUFFER = 33000;

/**
 * Compose every render-time data source into the augmented payload that the
 * DSL applies to its input variables.
 *
 * All provider calls run in parallel; each one's failure becomes a missing
 * field (handled by the DSL input fallback chain). No provider error
 * propagates to the caller — a single broken source must not blank the bar.
 *
 * [LAW:no-silent-fallbacks] Provider rejections are logged by the underlying
 * data-provider layer; an absent field is the explicit signal that the DSL
 * input fallback uses. This function does not silently coerce nulls to zeros
 * — that decision lives in the DSL declaration's `default` field, owned by
 * the config, not buried here.
 */
export async function buildRenderPayload(
  hookData: ClaudeHookData,
  deps: RenderPayloadDeps,
  cwd: string | undefined,
): Promise<RenderPayload> {
  // [LAW:dataflow-not-control-flow] Parallel fetch — same shape every call.
  // The .catch(() => null) on each leg converts a thrown provider error into
  // the same "no data" signal as an empty/null return. Errors should be rare
  // (providers handle their own fs/process errors internally), but this
  // boundary ensures a single misbehaving provider can't poison the line.
  const [gitInfo, usage, today, context, metrics, tmuxSession] =
    await Promise.all([
      deps.gitProvider
        .getGitInfo(
          cwd ?? hookData.workspace?.current_dir,
          {},
          hookData.workspace?.project_dir,
        )
        .catch(() => null),
      deps.usageProvider
        .getUsageInfo(hookData.session_id, hookData)
        .catch(() => null),
      deps.todayProvider.getTodayInfo().catch(() => null),
      deps.contextProvider
        .getContextInfo(hookData, DEFAULT_AUTOCOMPACT_BUFFER)
        .catch(() => null),
      deps.metricsProvider
        .getMetricsInfo(hookData.session_id, hookData)
        .catch(() => null),
      deps.tmuxService.getSessionId().catch(() => null),
    ]);

  const blockInfo = await deps.blockProvider
    .getActiveBlockInfo(hookData)
    .catch(() => null);

  // [LAW:one-source-of-truth] The theme variable surfaces the session's
  // resolved theme so the toolbar/tray DSL templates can encode it into
  // cc-candybar:// URLs without re-resolving. SessionState owns the value;
  // we mirror it onto the payload, not redeclare it.
  const themeRaw = deps.sessionState.get(hookData.session_id, "theme");
  const theme = typeof themeRaw === "string" ? themeRaw : undefined;

  const home = process.env.HOME ?? process.env.USERPROFILE;

  // [LAW:types-are-the-program] Narrowed handles so the spread expressions
  // below see plain non-null values — TS doesn't propagate the discriminant
  // of `usage?.session.cost !== null` to the consequent's property reads.
  const sessionPayload: SessionPayload | undefined =
    usage !== null &&
    usage.session.cost !== null &&
    usage.session.tokens !== null
      ? { cost: usage.session.cost, tokens: usage.session.tokens }
      : undefined;
  const todayPayload: TodayPayload | undefined =
    today !== null && today.cost !== null && today.tokens !== null
      ? { cost: today.cost, tokens: today.tokens }
      : undefined;

  return {
    ...hookData,
    ...(home !== undefined && { home }),
    ...(gitInfo !== null && { git: projectGitInfo(gitInfo) }),
    ...(tmuxSession !== null && { tmux: { session: tmuxSession } }),
    ...(theme !== undefined && { theme }),
    ...(sessionPayload !== undefined && { session: sessionPayload }),
    ...(todayPayload !== undefined && { today: todayPayload }),
    ...(blockInfo !== null && {
      block: {
        nativeUtilization: blockInfo.nativeUtilization,
        // [LAW:one-source-of-truth] Surface the raw `resets_at` epoch (not
        // pre-computed minutes) so DSL templates compose `minutesUntilReset
        // .block.resetsAt` — the same formatter the weekly segment uses.
        // Pre-computing here would split "minutes until reset" into two
        // paths (precomputed for block, template-computed for weekly), drift
        // bait.
        resetsAt: hookData.rate_limits?.five_hour?.resets_at ?? 0,
      },
    }),
    ...(hookData.rate_limits?.seven_day !== undefined && {
      weekly: {
        percentage: hookData.rate_limits.seven_day.used_percentage,
        resetsAt: hookData.rate_limits.seven_day.resets_at,
      },
    }),
    ...(context !== null && {
      context: {
        totalTokens: context.totalTokens,
        contextLeft: context.contextLeftPercentage,
      },
    }),
    ...(metrics !== null && {
      metrics: {
        lastResponseTime: metrics.lastResponseTime ?? 0,
        responseTime: metrics.responseTime ?? 0,
        sessionDuration: metrics.sessionDuration ?? 0,
        messageCount: metrics.messageCount ?? 0,
        linesAdded: metrics.linesAdded ?? 0,
        linesRemoved: metrics.linesRemoved ?? 0,
      },
    }),
  };
}

// [LAW:types-are-the-program] Project the optional-rich GitInfo down to the
// flat shape the DSL input paths read. Every optional becomes a typed default
// at this boundary so the DSL never sees `undefined` for these fields —
// templates can `{{ if ne .git.repoName "" }}` without worrying about whether
// the path resolved.
function projectGitInfo(info: GitInfo): GitPayload {
  return {
    repoName: info.repoName ?? "",
    branch: info.branch,
    sha: info.sha ?? "",
    ahead: info.ahead,
    behind: info.behind,
    staged: info.staged ?? 0,
    unstaged: info.unstaged ?? 0,
    untracked: info.untracked ?? 0,
    conflicts: info.conflicts ?? 0,
    upstream: info.upstream ?? "",
    stash: info.stashCount ?? 0,
    status: info.status,
  };
}
